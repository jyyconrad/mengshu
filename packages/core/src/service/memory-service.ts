/**
 * 默认记忆服务实现。
 *
 * 当前版本先把核心服务边界立起来：store/recall/context/delete/health 都通过
 * repository 和 embedding port 完成；context 组装委托给 retrieval context packer，
 * 让 REST/MCP/SDK/OpenClaw 共用同一套 provenance 和 prompt safety 规则。
 */

import { packContext } from "../retrieval/context-packer.js";
import { auditLifecycle } from "../../../../lifecycle/audit.js";
import { normalizeScope, validateScopeForWrite } from "../domain/scope.js";
import { computeScopeFit } from "../domain/scope-fit.js";
import { computeNodeScoreWithBreakdown } from "../domain/recall-scoring.js";
import type { AuditRepository } from "../../../../storage/repositories/types.js";
import type { ContextBlock, MemoryRecord, MemoryScope, RecallHit } from "../domain/types.js";
import type {
  BuildContextInput,
  DeleteMemoryInput,
  DeleteMemoryResult,
  EmbeddingPort,
  HealthSnapshot,
  MemoryRepository,
  MemoryService,
  RecallInput,
  RecallResult,
  StoreMemoryInput,
  StoreMemoryResult,
} from "../domain/service-types.js";
import type { QueryHitsTracker } from "../../../../graph/query-hits-tracker.js";

export type {
  BuildContextInput,
  DeleteMemoryInput,
  DeleteMemoryResult,
  EmbeddingPort,
  HealthSnapshot,
  MemoryRepository,
  MemoryRepositoryQuery,
  MemoryService,
  RecallInput,
  StoreMemoryInput,
  StoreMemoryResult,
} from "../domain/service-types.js";

export interface DefaultMemoryServiceOptions {
  repository: MemoryRepository;
  embeddings: EmbeddingPort;
  /**
   * 可选审计仓库。注入后写入/拒绝路径会追加 audit 记录；不传时行为与不审计版本完全一致，
   * 保持向后兼容。
   */
  audit?: AuditRepository;
  /**
   * 可选 queryHits 追踪器。注入后 recall 会递增被命中 entity 的 queryHits30d。
   * P2 核心功能：使 hotness 评分生效，topic tree 开始创建。
   */
  queryHitsTracker?: QueryHitsTracker;
}

export class DefaultMemoryService implements MemoryService {
  private readonly repository: MemoryRepository;
  private readonly embeddings: EmbeddingPort;
  private readonly audit?: AuditRepository;
  private readonly queryHitsTracker?: QueryHitsTracker;

  constructor(options: DefaultMemoryServiceOptions) {
    this.repository = options.repository;
    this.embeddings = options.embeddings;
    this.audit = options.audit;
    this.queryHitsTracker = options.queryHitsTracker;
  }

  async storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResult> {
    // DEFECT-001 防御：如果 scope 是 undefined，先归一化避免 validateScopeForWrite 崩溃。
    // 注意：显式传递空字符串仍会被 validateScopeForWrite 拒绝（保持严格校验）。
    const normalizedScope = input.record.scope
      ? input.record.scope
      : normalizeScope(undefined);

    // v0.1 单 appId：record.scope 与 request scope 自洽校验，防止隔离字段缺失或被改动。
    try {
      validateScopeForWrite(normalizedScope, normalizedScope);
    } catch (error) {
      if (this.audit) {
        await auditLifecycle(this.audit, {
          scope: normalizedScope,
          action: "scope.reject",
          targetId: input.record.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }

    // 缺陷修复：storeMemory 此前从不计算 embedding，导致 record.vector 为 undefined →
    // 落到 LanceDB 固定维向量 schema 时触发 "vector must have at least 1 dimension"。
    // 参照 runtime.ts storeObservation 的 embed 模式：vector 缺失或为空数组时补齐。
    // 不可变更新：基于入参创建新 record，不修改 input.record。
    const needsEmbedding =
      !input.record.vector || input.record.vector.length === 0;
    const record = needsEmbedding
      ? { ...input.record, scope: normalizedScope, vector: await this.embeddings.embed(input.record.text) }
      : { ...input.record, scope: normalizedScope };

    await this.repository.store([record]);

    if (this.audit) {
      await auditLifecycle(this.audit, {
        scope: record.scope,
        action: "memory.store",
        targetId: record.id,
      });
    }

    return {
      id: record.id,
      stored: true,
    };
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const scope = normalizeScope(input.scope);
    const vector = await this.embeddings.embed(input.query);

    // D-25：硬过滤模式时，把项目/产品维度注入 filter（通过内部 key 传递给 adapter）
    let filter = input.filter;
    if (input.scopeFilterMode === "hard") {
      // 优先用显式传入的 filterProject/filterProduct，回退当前 scope（如果不是 default）
      const project = input.filterProject ?? (scope.projectId !== "default" ? scope.projectId : undefined);
      const product = input.filterProduct ?? (scope.appId !== "default" ? scope.appId : undefined);

      if (project || product || input.projectPattern) {
        filter = { ...input.filter };  // 仅在有硬过滤时才复制 filter
        if (project) {
          filter._projectName = project;  // 内部 key，adapter 会提取
        }
        if (product) {
          filter._appName = product;
        }
        if (input.projectPattern) {
          filter._projectPattern = input.projectPattern;
        }
      }
    }

    const records = await this.repository.query({
      query: input.query,
      vector,
      limit: input.limit,
      minScore: input.minScore,
      filter,  // 含硬过滤内部 key（仅在 hard 模式且有值时不为 undefined）
      scope,
      tableName: input.tableName,
      dataTypes: input.dataTypes,
      searchAll: input.searchAll,
    });

    const hits: RecallHit[] = records
      .map((record) => {
        // scope 软排序：record 自身 scope 与 query scope 的契合度（[0,1]）。
        // 跨 scope 的记忆不被拦截，只是 scopeFit 偏低导致排序靠后。
        const recordScope = (record as MemoryRecord).scope ?? scope;
        const scopeFit = computeScopeFit(scope, recordScope);

        // 用召回评分体系重算综合分：relevance 注入向量相似度，scopeFit 注入契合度。
        // 其余因子（importance/confidence/evidence/recency）由 record 字段近似。
        const breakdown = computeNodeScoreWithBreakdown(record, undefined, {
          relevance: record.score,
          scopeFit,
        });

        const hit: RecallHit = {
          record,
          score: breakdown.score,
          source: "vector",
          scoreBreakdown: {
            vector: record.score,
            scopeFit,
            composite: breakdown.score,
          },
          provenance: record.provenance,
        };
        return hit;
      })
      // 综合分降序：同 scope（高 scopeFit）排前，跨 scope 不拦截只靠后。
      // 综合分相同时按向量相似度兜底（保持相关性优先的稳定排序）。
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const av = a.scoreBreakdown?.vector ?? 0;
        const bv = b.scoreBreakdown?.vector ?? 0;
        return bv - av;
      });

    // P2: 追踪 queryHits，递增被命中 entity 的 queryHits30d
    if (this.queryHitsTracker && hits.length > 0) {
      // 异步追踪，不阻塞 recall 返回
      this.queryHitsTracker.trackRecallHits(hits, scope).catch((error) => {
        console.error("[QueryHitsTracker] Failed to track recall hits:", error);
      });
    }

    return {
      scope,
      query: input.query,
      hits,
    };
  }

  async buildContext(input: BuildContextInput): Promise<ContextBlock> {
    const recalled = await this.recall(input);
    return packContext({
      scope: recalled.scope,
      title: input.title ?? "Retrieved Context",
      hits: recalled.hits,
    });
  }

  async delete(input: DeleteMemoryInput): Promise<DeleteMemoryResult> {
    if (input.ids && input.ids.length > 0) {
      await this.repository.delete(input.ids);
      return { deleted: input.ids.length };
    }
    if (input.filter) {
      const deleted = await this.repository.deleteByFilter(input.filter);
      return { deleted };
    }
    return { deleted: 0 };
  }

  async health(): Promise<HealthSnapshot> {
    try {
      const records = await this.repository.count();
      return { ok: true, records };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
