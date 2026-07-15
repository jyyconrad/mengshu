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
import {
  DATABASE_STORE_CLEANUP_WARNING,
  parseDatabaseStoreResult,
} from "../db/types.js";
import {
  AuthorityScopedForgetError,
  executeAuthorityScopedForget,
} from "../lifecycle/forget-transaction.js";
import type { AuditRepository } from "../../../../storage/repositories/types.js";
import type { ContextBlock, MemoryRecord, MemoryScope, RecallHit } from "../domain/types.js";
import type {
  BuildContextInput,
  AuthorityScopedForgetInput,
  AuthorityScopedForgetResult,
  AuthorityScopedForgetService,
  DeleteMemoryInput,
  DeleteMemoryResult,
  EmbeddingPort,
  HealthSnapshot,
  MemoryRepository,
  MemoryRepositoryStoreResult,
  MemoryService,
  ForgetTransactionPort,
  RecallInput,
  RecallResult,
  StoreMemoryInput,
  StoreMemoryResult,
} from "../domain/service-types.js";
import type { QueryHitsTracker } from "../../../../graph/query-hits-tracker.js";
import type {
  EmbeddingReadGuard,
  EmbeddingRecallPolicyDecision,
  EmbeddingWriteGuard,
} from "../storage/embedding-space-policy.js";
import {
  isProviderOwnedAtomicMemoryStorePort,
  type ProviderOwnedAtomicMemoryStorePort,
} from "./write-kernel-transaction.js";

export type {
  BuildContextInput,
  AuthorityScopedForgetInput,
  AuthorityScopedForgetResult,
  AuthorityScopedForgetService,
  DeleteMemoryInput,
  DeleteMemoryResult,
  EmbeddingPort,
  HealthSnapshot,
  MemoryRepository,
  MemoryRepositoryQuery,
  MemoryRepositoryStoreResult,
  MemoryService,
  ForgetTransactionPort,
  RecallInput,
  StoreMemoryInput,
  StoreMemoryResult,
} from "../domain/service-types.js";

/** 通过公共 service 入口暴露错误码与事务编排器，供 RB1 adapter 做安全映射。 */
export { AuthorityScopedForgetError, executeAuthorityScopedForget };

export interface DefaultMemoryServiceOptions {
  repository: MemoryRepository;
  embeddings: EmbeddingPort;
  /**
   * PostgreSQL v11 provider-owned write transaction. Runtime PostgreSQL writes
   * must use this port so record + audit + outbox + receipt share one commit.
   */
  atomicStore?: ProviderOwnedAtomicMemoryStorePort;
  /**
   * 可选审计仓库。非原子兼容写与拒绝路径使用它；注入 atomicStore 时成功写审计
   * 由 provider transaction 完成，本仓库只保留拒绝/其它 lifecycle 审计。
   */
  audit?: AuditRepository;
  /**
   * 可选 queryHits 追踪器。注入后 recall 会递增被命中 entity 的 queryHits30d。
   * P2 核心功能：使 hotness 评分生效，topic tree 开始创建。
   */
  queryHitsTracker?: QueryHitsTracker;
  /** 真实事务端口；缺失时 authority-scoped forget 必须 fail-closed。 */
  forgetTransactions?: ForgetTransactionPort;
  /**
   * Registry-aware ANN gate。runtime 必须注入；独立使用 service 时不传，
   * 保留 provider-neutral 的旧行为以兼容现有调用方。
   */
  embeddingReadGuard?: EmbeddingReadGuard;
  /** Registry-aware durable write gate; runtime 注入与其他写链相同的实例。 */
  embeddingWriteGuard?: EmbeddingWriteGuard;
  /** Runtime 持有的权威 metadata stamper；所有公开写入口统一应用。 */
  stampEmbeddingMetadata?: (
    metadata: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
}

export type EmbeddingRecallResult = RecallResult & {
  readonly retrievalMode?: "same-space-ann" | "fail-closed";
  readonly embeddingPolicyReason?:
    | EmbeddingRecallPolicyDecision["reasonCode"]
    | "caller-space-filter-conflict";
};

function validateSingleStoreOutcome(
  outcome: MemoryRepositoryStoreResult,
  requestedId: string,
): MemoryRepositoryStoreResult["records"][number] {
  if (!Number.isInteger(outcome.inserted) || !Number.isInteger(outcome.duplicates) ||
      outcome.inserted < 0 || outcome.duplicates < 0 ||
      outcome.inserted + outcome.duplicates !== 1 || outcome.records.length !== 1) {
    throw new Error("Memory repository store outcome has inconsistent counts");
  }
  const [record] = outcome.records;
  if (!record || record.requestedId !== requestedId ||
      typeof record.persistedId !== "string" || record.persistedId.length === 0 ||
      (record.stored ? outcome.inserted !== 1 : outcome.duplicates !== 1)) {
    throw new Error("Memory repository store outcome has an invalid record result");
  }
  return record;
}

export class DefaultMemoryService implements MemoryService, AuthorityScopedForgetService {
  private readonly repository: MemoryRepository;
  private readonly embeddings: EmbeddingPort;
  private readonly atomicStore?: ProviderOwnedAtomicMemoryStorePort;
  private readonly audit?: AuditRepository;
  private readonly queryHitsTracker?: QueryHitsTracker;
  private readonly forgetTransactions?: ForgetTransactionPort;
  private readonly embeddingReadGuard?: EmbeddingReadGuard;
  private readonly embeddingWriteGuard?: EmbeddingWriteGuard;
  private readonly stampEmbeddingMetadata?: DefaultMemoryServiceOptions["stampEmbeddingMetadata"];

  constructor(options: DefaultMemoryServiceOptions) {
    this.repository = options.repository;
    this.embeddings = options.embeddings;
    if (options.atomicStore && !isProviderOwnedAtomicMemoryStorePort(options.atomicStore)) {
      throw new Error("memory service atomic store must be provider-owned");
    }
    this.atomicStore = options.atomicStore;
    this.audit = options.audit;
    this.queryHitsTracker = options.queryHitsTracker;
    this.forgetTransactions = options.forgetTransactions;
    this.embeddingReadGuard = options.embeddingReadGuard;
    this.embeddingWriteGuard = options.embeddingWriteGuard;
    this.stampEmbeddingMetadata = options.stampEmbeddingMetadata;
  }

  async storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResult> {
    // 必须是 storeMemory 的第一项外部能力检查；预传 vector 也不能绕过。
    this.embeddingWriteGuard?.assertWriteAllowed();

    if (typeof input.record.text !== "string" || input.record.text.trim().length === 0) {
      throw new Error("memory record text is required");
    }

    // REST/MCP/script 调用方不拥有 active embedding-space identity。
    // 在 provider 写入前由 service 边界统一盖章；冲突由 runtime stamper fail-closed。
    const inputRecord = this.stampEmbeddingMetadata
      ? {
          ...input.record,
          metadata: this.stampEmbeddingMetadata(input.record.metadata),
        }
      : input.record;

    // DEFECT-001 防御：如果 scope 是 undefined，先归一化避免 validateScopeForWrite 崩溃。
    // 注意：显式传递空字符串仍会被 validateScopeForWrite 拒绝（保持严格校验）。
    const normalizedScope = inputRecord.scope
      ? inputRecord.scope
      : normalizeScope(undefined);

    // v0.1 单 appId：record.scope 与 request scope 自洽校验，防止隔离字段缺失或被改动。
    try {
      validateScopeForWrite(normalizedScope, normalizedScope);
    } catch (error) {
      if (this.audit) {
        await auditLifecycle(this.audit, {
          scope: normalizedScope,
          action: "scope.reject",
          targetId: inputRecord.id,
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
      !inputRecord.vector || inputRecord.vector.length === 0;
    const record = needsEmbedding
      ? { ...inputRecord, scope: normalizedScope, vector: await this.embeddings.embed(inputRecord.text) }
      : { ...inputRecord, scope: normalizedScope };

    if (this.atomicStore) {
      const outcome = await this.atomicStore.store(record);
      return {
        id: outcome.id,
        stored: outcome.stored,
        ...(outcome.cleanupFailed
          ? { warnings: [DATABASE_STORE_CLEANUP_WARNING] }
          : {}),
      };
    }

    const storeResult = await this.repository.store([record]);
    if (!storeResult) {
      throw new Error("Memory repository store outcome is unavailable");
    }
    const normalizedStoreResult = parseDatabaseStoreResult(storeResult);
    if (!normalizedStoreResult) {
      throw new Error("Memory repository store outcome is invalid");
    }
    const recordResult = validateSingleStoreOutcome(normalizedStoreResult, record.id);
    const stored = recordResult.stored;
    const persistedId = recordResult.persistedId;

    // Non-Postgres compatibility path. PostgreSQL runtime injects atomicStore
    // above and never reaches this post-commit audit branch.
    if (stored && this.audit) {
      await auditLifecycle(this.audit, {
        scope: record.scope,
        action: "memory.store",
        targetId: persistedId,
      });
    }

    return {
      id: persistedId,
      stored,
      warnings: normalizedStoreResult.cleanup
        ? [DATABASE_STORE_CLEANUP_WARNING]
        : undefined,
    };
  }

  async recall(input: RecallInput): Promise<EmbeddingRecallResult> {
    const scope = normalizeScope(input.scope);
    const embeddingDecision = this.embeddingReadGuard?.snapshot();
    if (embeddingDecision && !embeddingDecision.allowed) {
      return {
        scope,
        query: input.query,
        hits: [],
        retrievalMode: "fail-closed",
        embeddingPolicyReason: embeddingDecision.reasonCode,
      };
    }

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

    if (embeddingDecision?.allowed) {
      const requiredFilter = embeddingDecision.requiredFilter;
      const callerFilter = filter ?? {};
      const hasConflict = Object.entries(requiredFilter).some(
        ([key, value]) =>
          Object.prototype.hasOwnProperty.call(callerFilter, key) &&
          callerFilter[key] !== value,
      );
      if (hasConflict) {
        return {
          scope,
          query: input.query,
          hits: [],
          retrievalMode: "fail-closed",
          embeddingPolicyReason: "caller-space-filter-conflict",
        };
      }
      filter = { ...callerFilter, ...requiredFilter };
    }

    const vector = await this.embeddings.embed(input.query);

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

    const sameSpaceRecords = embeddingDecision?.allowed
      ? records.filter((record) => {
          const metadata = record.metadata ?? {};
          return Object.entries(embeddingDecision.requiredFilter).every(
            ([key, value]) => metadata[key] === value,
          );
        })
      : records;

    // Repository/provider 必须前置下推 authority；这里仍做独立的返回边界校验，
    // 防止错误 provider、旧索引或 mock 把跨租户文本/ID 泄露给上层。
    const authorityRecords = sameSpaceRecords.filter((record) =>
      record.scope?.tenantId === scope.tenantId && record.scope?.userId === scope.userId,
    );

    const hits: RecallHit[] = authorityRecords
      .map((record) => {
        // authority 已硬隔离；同 tenant/user 内其它 scope 维度继续作为软排序信号。
        // 因此 profile 等既有跨 project 语义不受影响。
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
      // 综合分降序：同 authority 内，同 scope（高 scopeFit）排前，跨 project 等靠后。
      // 综合分相同时按向量相似度兜底（保持相关性优先的稳定排序）。
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const av = a.scoreBreakdown?.vector ?? 0;
        const bv = b.scoreBreakdown?.vector ?? 0;
        return bv - av;
      })
      // Provider 应在 authority WHERE 后应用 LIMIT；后置 slice 是防御性保证，
      // 避免违反合同的 repository 返回越界数量。
      .slice(0, input.limit ?? authorityRecords.length);

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
      ...(embeddingDecision?.allowed
        ? {
            retrievalMode: embeddingDecision.mode,
            embeddingPolicyReason: embeddingDecision.reasonCode,
          }
        : {}),
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
    void input;
    throw new AuthorityScopedForgetError(
      "AUTHORITY_REQUIRED",
      "legacy delete does not carry server-owned authority; use forget()",
    );
  }

  async forget(input: AuthorityScopedForgetInput): Promise<AuthorityScopedForgetResult> {
    return executeAuthorityScopedForget(this.forgetTransactions, input);
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
