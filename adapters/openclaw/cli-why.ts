/**
 * OpenClaw `ms why <target>` 子命令。
 *
 * 本文件做什么：解释一条记忆"为什么存在 / 为什么被召回"，对单条 MemoryRecord
 * 聚合并展示四类溯源信息：
 * - 来源（provenance）：source / sessionId / conversationId / messageId / filePath
 * - Scope：tenant/app/user/project/agent/namespace/visibility
 * - 风险标记（riskFlags）：来自 metadata.riskFlags（去重）
 * - 合并/替代记录：supersededBy / sourceNodeIds / metadata.mergedFrom
 *
 * 核心流程：
 * 1. 用 target 调 MemoryService.recall（searchAll）拿候选 hits。
 * 2. resolveTarget：精确 id 命中优先，否则取得分最高 hit。
 * 3. extractWhyDetails 抽取结构化溯源，formatWhyReport 渲染文本。
 *
 * 关键边界：
 * - 纯函数（extractWhyDetails / formatWhyReport / resolveTarget）不依赖 IO，便于单测。
 * - service 缺失或 recall 失败（如 embedding 不可用）时友好降级，不抛未捕获异常。
 * - 与 cli.ts 共用 CommanderLike 鸭子类型，避免引入 commander 硬依赖。
 */

import type { CommanderLike } from "./cli.js";
import type { MemoryService } from "../../core/service-types.js";
import type { MemoryRecord, MemoryScope, RecallHit } from "../../core/types.js";

/** why 命令依赖注入。service/scope 缺省时降级。 */
export interface WhyCliDeps {
  /** 用于解析 target 的召回服务（需 embedding）。 */
  service?: MemoryService;
  /** 召回使用的默认 scope。 */
  scope?: MemoryScope;
}

interface WhyOptions {
  limit?: string;
}

/** 来源（provenance）摘要。 */
export interface WhySource {
  source?: string;
  sessionId?: string;
  conversationId?: string;
  messageId?: string;
  filePath?: string;
  createdAt?: number;
}

/** 合并/替代记录摘要。 */
export interface WhyMerge {
  /** 被哪条记录替代（生命周期 superseded）。 */
  supersededBy?: string;
  /** 原始证据来源节点。 */
  sourceNodeIds: string[];
  /** 合并自的旧记录（metadata.mergedFrom）。 */
  mergedFrom: string[];
  /** 是否存在任意合并/替代痕迹。 */
  hasMergeHistory: boolean;
}

/** 单条记忆的溯源详情。 */
export interface WhyDetails {
  id: string;
  text: string;
  kind: string;
  importance: number;
  source: WhySource;
  scope: MemoryScope;
  riskFlags: string[];
  merge: WhyMerge;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

/** 从 MemoryRecord 抽取结构化溯源详情（纯函数）。 */
export function extractWhyDetails(record: MemoryRecord): WhyDetails {
  const metadata = record.metadata ?? {};
  const riskFlags = dedupe(asStringArray(metadata.riskFlags));
  const sourceNodeIds = record.sourceNodeIds ?? [];
  const mergedFrom = asStringArray(metadata.mergedFrom);
  const supersededBy = record.supersededBy;

  return {
    id: record.id,
    text: record.text,
    kind: record.kind,
    importance: record.importance,
    source: {
      source: record.provenance?.source,
      sessionId: record.provenance?.sessionId,
      conversationId: record.provenance?.conversationId,
      messageId: record.provenance?.messageId,
      filePath: record.provenance?.filePath,
      createdAt: record.provenance?.createdAt ?? record.createdAt,
    },
    scope: record.scope,
    riskFlags,
    merge: {
      supersededBy,
      sourceNodeIds,
      mergedFrom,
      hasMergeHistory:
        Boolean(supersededBy) || sourceNodeIds.length > 0 || mergedFrom.length > 0,
    },
  };
}

function formatTimestamp(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return "未知";
  }
  return new Date(ts).toISOString();
}

function line(label: string, value: string | undefined): string {
  return `  - ${label}: ${value && value.length > 0 ? value : "未知"}`;
}

/** 将 WhyDetails 渲染为人类可读报告（纯函数）。 */
export function formatWhyReport(record: MemoryRecord): string {
  const d = extractWhyDetails(record);
  const lines: string[] = [];

  lines.push(`记忆 ${d.id}`);
  lines.push(`  ${d.text}`);
  lines.push(`  kind=${d.kind} | importance=${d.importance.toFixed(2)}`);

  lines.push("");
  lines.push("来源 (provenance):");
  lines.push(line("source", d.source.source));
  lines.push(line("sessionId", d.source.sessionId));
  lines.push(line("conversationId", d.source.conversationId));
  if (d.source.messageId) {
    lines.push(line("messageId", d.source.messageId));
  }
  if (d.source.filePath) {
    lines.push(line("filePath", d.source.filePath));
  }
  lines.push(line("createdAt", formatTimestamp(d.source.createdAt)));

  lines.push("");
  lines.push("Scope:");
  lines.push(line("tenant", d.scope.tenantId));
  lines.push(line("app", d.scope.appId));
  lines.push(line("user", d.scope.userId));
  lines.push(line("project", d.scope.projectId));
  lines.push(line("agent", d.scope.agentId));
  lines.push(line("namespace", d.scope.namespace));
  lines.push(line("visibility", d.scope.visibility ?? "private"));

  lines.push("");
  lines.push("风险标记 (riskFlags):");
  lines.push(d.riskFlags.length > 0 ? `  - ${d.riskFlags.join(", ")}` : "  - 无");

  lines.push("");
  lines.push("合并/替代记录 (merge):");
  if (!d.merge.hasMergeHistory) {
    lines.push("  - 无");
  } else {
    if (d.merge.supersededBy) {
      lines.push(line("supersededBy", d.merge.supersededBy));
    }
    if (d.merge.sourceNodeIds.length > 0) {
      lines.push(line("sourceNodeIds", d.merge.sourceNodeIds.join(", ")));
    }
    if (d.merge.mergedFrom.length > 0) {
      lines.push(line("mergedFrom", d.merge.mergedFrom.join(", ")));
    }
  }

  return lines.join("\n");
}

/** 在候选 hits 中解析目标记录：精确 id 命中优先，否则取首个（按得分排序）。 */
export function resolveTarget(target: string, hits: RecallHit[]): MemoryRecord | undefined {
  const records = hits
    .map((hit) => hit.record)
    .filter((record): record is MemoryRecord => "id" in record && "provenance" in record);

  const exact = records.find((record) => record.id === target);
  if (exact) {
    return exact;
  }
  return records[0];
}

async function handleWhy(target: unknown, options: WhyOptions, deps: WhyCliDeps): Promise<void> {
  const text = typeof target === "string" ? target.trim() : "";
  if (text.length === 0) {
    console.log("用法：ms why <记忆 id 或查询文本>");
    return;
  }

  if (!deps.service) {
    console.log("未注入 MemoryService，无法解析记忆来源。");
    return;
  }

  const limit = options.limit ? Number.parseInt(options.limit, 10) : 10;
  try {
    const result = await deps.service.recall({
      query: text,
      scope: deps.scope,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
      minScore: 0,
      searchAll: true,
    });

    const record = resolveTarget(text, result.hits);
    if (!record) {
      console.log(`未找到匹配的记忆（target=${text}）。`);
      return;
    }

    console.log(formatWhyReport(record));
  } catch (error) {
    console.log(`解析失败（已降级）：${(error as Error).message}`);
    console.log("提示：why 需要可用的 embedding 配置以执行召回。");
  }
}

/** 注册 why 命令到父 `ms` 命令。 */
export function registerWhyCliCommands(memory: CommanderLike, deps: WhyCliDeps): void {
  memory
    .command("why <target>")
    .description("Explain a memory's source, scope, riskFlags and merge history")
    .option("-l, --limit <n>", "Max candidates to resolve target from", "10")
    .action(async (...args: unknown[]) => {
      const [target, opts] = args;
      const record = opts && typeof opts === "object" ? (opts as Record<string, unknown>) : {};
      const limit = typeof record.limit === "string" ? record.limit : undefined;
      await handleWhy(target, { limit }, deps);
    });
}
