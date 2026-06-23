/**
 * `ms project backfill-observation-metadata` - 回填历史 observation metadata 字段。
 *
 * 背景：
 * F4 修复后，storeObservation 写入时会在 metadata 补充 userId/projectPath/agentName
 * （runtime.ts:291-293），但修复前写入的 observation 缺少这些字段。
 * 虽然 scope 改为软排序后这些记录能被召回，但 metadata 缺字段导致溯源信息不完整
 * （`ms why <记忆ID>` 无法显示来源）。
 *
 * 目标：
 * 从 record.scope 回填缺失的 metadata.userId/projectPath/agentName 字段，
 * 确保溯源完整。
 *
 * 关键实现说明：
 * - record.kind 不会持久化到 DB metadata（recordToMemoryEntry 不写 kind），
 *   因此真实 Postgres 中 observation 靠 metadata.eventType（总是存在）+ source 识别。
 *   本命令用 isObservationEntry() 做内存识别，兼容 kind/eventType/source 多种标志。
 * - MemoryEntry 无顶层 scope 字段，scope 从 metadata 反解
 *   （userId/projectId/agentId 或 projectPath/agentName）。
 *
 * 约束：
 * - 只回填 observation
 * - 只回填 metadata 缺 userId/projectPath/agentName 的记录
 * - 默认 dry-run，需显式 --apply
 * - limit 默认 1000，防止误全表更新
 */

import type { CommanderLike } from "./index.js";
import type { DatabaseProvider, MemoryEntry, TableName } from "../../../../packages/core/src/db/types.js";

export interface BackfillObservationMetadataDeps {
  /** 数据库 provider（需支持 query + updateMetadata） */
  db?: DatabaseProvider;
  /** 当前工作目录 */
  cwd?: () => string;
}

interface BackfillOptions {
  dryRun?: boolean;
  apply?: boolean;
  limit?: string;
}

interface BackfillCandidate {
  /** 完整原始 entry（apply 时直接复用，避免二次查询） */
  entry: MemoryEntry;
  /** 从 metadata 反解的 scope（用于回填值） */
  scope: {
    userId?: string;
    projectId?: string;
    agentId?: string;
  };
  /** 缺失的 metadata 字段名 */
  missingFields: string[];
}

interface BackfillReport {
  affectedCount: number;
  samples: Array<{
    id: string;
    missingFields: string[];
    willFill: Record<string, string>;
  }>;
  appliedCount?: number;
  failedIds?: string[];
}

/**
 * 识别一条 entry 是否为 observation。
 *
 * record.kind 不持久化到 metadata，因此采用多重标志：
 * - metadata.kind === "observation"（mock / 部分迁移数据）
 * - metadata.eventType 存在（真实 observation 总带 eventType）
 * - metadata.source === "agent-fast-path"（observation 默认来源）
 */
function isObservationEntry(metadata: Record<string, unknown>): boolean {
  if (metadata.kind === "observation") return true;
  if (typeof metadata.eventType === "string" && metadata.eventType.length > 0) return true;
  if (metadata.source === "agent-fast-path") return true;
  return false;
}

/**
 * 检查 metadata 缺失哪些溯源字段。
 */
function findMissingFields(metadata: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!metadata.userId) missing.push("userId");
  if (!metadata.projectPath) missing.push("projectPath");
  if (!metadata.agentName) missing.push("agentName");
  return missing;
}

/**
 * 从 metadata 反解 scope（MemoryEntry 无顶层 scope 字段）。
 *
 * 回填来源优先级：
 * - userId   <- metadata.userId
 * - projectId <- metadata.projectId ?? metadata.projectPath
 * - agentId  <- metadata.agentId ?? metadata.agentName
 */
function resolveScopeFromMetadata(metadata: Record<string, unknown>): {
  userId?: string;
  projectId?: string;
  agentId?: string;
} {
  const asString = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  return {
    userId: asString(metadata.userId),
    projectId: asString(metadata.projectId) ?? asString(metadata.projectPath),
    agentId: asString(metadata.agentId) ?? asString(metadata.agentName),
  };
}

/**
 * 扫描候选：找出 observation 且 metadata 缺 userId/projectPath/agentName 的记录。
 *
 * 注意：record.kind 不持久化，SQL 层无法精确按 kind 过滤，因此宽查 memory 表后
 * 用 isObservationEntry 内存识别。limit*2 作为扫描窗口；大库建议增大 limit 分批运行。
 */
async function scanCandidates(
  db: DatabaseProvider,
  limit: number,
): Promise<BackfillCandidate[]> {
  // 宽查 memory 表（不强制 SQL kind 过滤，避免真实环境查空）
  const results = await db.query({
    dataTypes: ["memory"],
    limit: limit * 2,
  });

  const candidates: BackfillCandidate[] = [];

  for (const entry of results) {
    if (!isObservationEntry(entry.metadata)) continue;

    const missingFields = findMissingFields(entry.metadata);
    if (missingFields.length === 0) continue;

    candidates.push({
      entry,
      scope: resolveScopeFromMetadata(entry.metadata),
      missingFields,
    });

    if (candidates.length >= limit) break;
  }

  return candidates;
}

/**
 * 为单条候选计算回填值（缺失字段补 scope 值，scope 也缺则补 "default"）。
 */
function computeFillValues(candidate: BackfillCandidate): Record<string, string> {
  const fill: Record<string, string> = {};
  if (candidate.missingFields.includes("userId")) {
    fill.userId = candidate.scope.userId || "default";
  }
  if (candidate.missingFields.includes("projectPath")) {
    fill.projectPath = candidate.scope.projectId || "default";
  }
  if (candidate.missingFields.includes("agentName")) {
    fill.agentName = candidate.scope.agentId || "default";
  }
  return fill;
}

/**
 * 生成报告（dry-run / apply 共用）。
 */
function generateReport(candidates: BackfillCandidate[]): BackfillReport {
  const samples = candidates.slice(0, 5).map((c) => ({
    id: c.entry.id,
    missingFields: c.missingFields,
    willFill: computeFillValues(c),
  }));

  return {
    affectedCount: candidates.length,
    samples,
  };
}

/**
 * 执行真实回填（按 id UPDATE metadata，jsonb 增量合并）。
 *
 * 关键：不能用 db.store —— Postgres provider 在 content_hash 冲突时
 * DO NOTHING，已存在记录的 metadata 不会被更新（回填完全失效）。
 * 改用 db.updateMetadata 直接按主键 `metadata || patch::jsonb` 合并。
 *
 * 每条独立 try/catch，记录失败 id，最后由调用方汇总输出。
 */
async function applyBackfill(
  db: DatabaseProvider,
  candidates: BackfillCandidate[],
): Promise<{ appliedCount: number; failedIds: string[] }> {
  let appliedCount = 0;
  const failedIds: string[] = [];

  for (const candidate of candidates) {
    const entry = candidate.entry;
    try {
      const fill = computeFillValues(candidate);
      // observation 实际所在表（默认 memories），按 entry.tableName 传入
      const tableName: TableName | undefined = entry.tableName;

      const updated = await db.updateMetadata!(entry.id, fill, tableName);
      if (updated) {
        appliedCount++;
      } else {
        // 未命中任何行（id 不存在等），视为失败以便溯源
        failedIds.push(entry.id);
        console.warn(`  ✗ 回填未命中 (id=${entry.id})：未找到匹配记录`);
      }
    } catch (error) {
      failedIds.push(entry.id);
      console.warn(`  ✗ 回填失败 (id=${entry.id}): ${(error as Error).message}`);
    }
  }

  return { appliedCount, failedIds };
}

/** 打印 dry-run 报告。 */
function printDryRunReport(report: BackfillReport): void {
  console.log("\n[Dry-run] Backfill observation metadata");
  console.log(
    `- Query: observation AND (metadata.userId IS NULL OR metadata.projectPath IS NULL OR metadata.agentName IS NULL)`,
  );
  console.log(`- Affected: ${report.affectedCount} records`);

  if (report.samples.length > 0) {
    console.log(`- Sample (first ${report.samples.length}):`);
    for (const sample of report.samples) {
      const fields = sample.missingFields.join(", ");
      const fills = Object.entries(sample.willFill)
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");
      console.log(`  - id: ${sample.id} | missing: ${fields} | will fill: ${fills}`);
    }
  }

  console.log("\n- To apply: ms project backfill-observation-metadata --apply");
}

/** 打印 apply 结果。 */
function printApplyResult(report: BackfillReport): void {
  const applied = report.appliedCount ?? 0;
  const failedIds = report.failedIds ?? [];
  console.log("\n[Apply] Backfill observation metadata");
  console.log(`- Affected: ${report.affectedCount} records`);
  console.log(`- Applied: ${applied} records`);
  console.log(`- Failed: ${failedIds.length} records`);

  if (failedIds.length > 0) {
    const sample = failedIds.slice(0, 5);
    console.log(`- Failed sample (first ${sample.length}): ${sample.join(", ")}`);
  }
}

/** 命令处理器。 */
async function handleBackfillObservationMetadata(
  options: BackfillOptions,
  deps: BackfillObservationMetadataDeps,
): Promise<void> {
  if (!deps.db) {
    console.error("\n✗ 数据库 provider 未注入，无法执行回填。");
    process.exitCode = 1;
    return;
  }

  // 回填依赖 updateMetadata（按主键 jsonb merge）。
  // store 在 content_hash 冲突时 DO NOTHING，无法更新已存在记录，因此必须支持 updateMetadata。
  if (options.apply && typeof deps.db.updateMetadata !== "function") {
    console.error(
      "\n✗ 该 db 后端不支持 metadata 回填（缺少 updateMetadata 实现）。请使用 Postgres 后端。",
    );
    process.exitCode = 1;
    return;
  }

  const limit = options.limit ? Number.parseInt(options.limit, 10) : 1000;

  if (options.apply) {
    console.log("\n⚠️  警告：这是数据修改操作，将更新 observation 的 metadata 字段。");
    console.log("⚠️  强烈建议先运行 --dry-run 确认影响范围。");
    console.log(`⚠️  回填上限：${limit} 条记录。\n`);
  }

  console.log(`扫描 observation 且 metadata 缺字段的记录（limit=${limit}）...`);
  const candidates = await scanCandidates(deps.db, limit);

  if (candidates.length === 0) {
    console.log("\n✓ 未发现需要回填的记录。");
    return;
  }

  const report = generateReport(candidates);

  if (options.apply) {
    console.log(`\n开始回填 ${report.affectedCount} 条记录...`);
    const { appliedCount, failedIds } = await applyBackfill(deps.db, candidates);
    report.appliedCount = appliedCount;
    report.failedIds = failedIds;
    printApplyResult(report);
  } else {
    printDryRunReport(report);
  }
}

/** 注册 `ms project backfill-observation-metadata` 子命令。 */
export function registerBackfillObservationMetadataCommand(
  project: CommanderLike,
  deps: BackfillObservationMetadataDeps,
): void {
  project
    .command("backfill-observation-metadata")
    .description(
      "Backfill missing metadata fields (userId/projectPath/agentName) for historical observations",
    )
    .option("--dry-run", "Preview affected records without applying changes (default)", true)
    .option("--apply", "Apply real backfill (UPDATE metadata)", false)
    .option("--limit <n>", "Maximum records to backfill (default: 1000)", "1000")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as BackfillOptions;
      await handleBackfillObservationMetadata(options, deps);
    });
}
