/**
 * cli-recall.ts
 *
 * 工作内容：注册 `ms recall <query>` 命令，召回记忆并可选展示评分明细。
 * 命令形态：`ms recall <query> [--limit <n>] [--min-score <n>] [--explain]`
 *
 * 设计边界：
 *   - 普通模式：按 min-score 过滤，打印命中文本与综合分（与 `ms search` 类似）。
 *   - --explain 模式：以 min-score=0 拉取更广候选集，对每条命中用
 *     computeNodeScoreWithBreakdown 计算 6 因子明细（relevance 注入向量相似度），
 *     按综合分降序分区为「保留」与「过滤」两部分，过滤项附 filteredReason。
 *   - 召回阶段的向量相似度作为 relevance 因子注入；其余因子取记录可得字段。
 *   - 纯展示命令，不修改任何记忆。
 */

import type { CommanderLike } from "./cli.js";
import type { MemoryService } from "../../core/service-types.js";
import type { MemoryRecord, MemoryScope, RecallHit } from "../../core/types.js";
import {
  computeNodeScoreWithBreakdown,
  DEFAULT_RECALL_WEIGHTS,
  type NodeScoreBreakdown,
  type RecallWeights,
  type ImportanceMetadata,
} from "../../core/recall-scoring.js";
import { detectExplicitSave, type SourceKind } from "../../processing/importance-score.js";

/** recall 命令依赖注入。 */
export interface RecallCliDeps {
  service: MemoryService;
  /** 默认 scope（与 bin/ms.ts 一致）。 */
  defaultScope: MemoryScope;
  /** 评分权重（默认 DEFAULT_RECALL_WEIGHTS）。 */
  weights?: RecallWeights;
}

interface RecallOptions {
  limit?: string;
  minScore?: string;
  explain?: boolean;
}

/** --explain 模式拉取候选集时的放大倍数，确保过滤项也能被看到。 */
const EXPLAIN_CANDIDATE_MULTIPLIER = 3;

/** 取记录文本（兼容 MemoryRecord / ChunkRecord / SummaryNode）。 */
function hitText(record: RecallHit["record"]): string {
  const r = record as { text?: string; summary?: string; title?: string };
  return r.text ?? r.summary ?? r.title ?? "";
}

/**
 * 映射 provenance.source 到 SourceKind（P1-Q4 修复）
 *
 * provenance.source 可能的值：user, agent, system, scan, 或自定义字符串。
 * SourceKind 是评分权重的 6 档枚举。
 */
function mapProvenanceSourceToSourceKind(source: string | undefined): SourceKind | undefined {
  if (!source) return undefined;

  // 直接映射
  const directMap: Record<string, SourceKind> = {
    user: "session_user",
    agent: "agent_output",
    system: "agent_output",
    scan: "document",
    tool: "tool_result",
    rule: "rule_file",
  };

  if (source in directMap) {
    return directMap[source];
  }

  // 模糊匹配
  const lower = source.toLowerCase();
  if (lower.includes("user")) return "session_user";
  if (lower.includes("agent")) return "agent_output";
  if (lower.includes("tool")) return "tool_result";
  if (lower.includes("rule")) return "rule_file";
  if (lower.includes("doc") || lower.includes("scan")) return "document";
  if (lower.includes("log")) return "work_log";

  // 默认回退
  return "agent_output";
}

/**
 * 从 MemoryRecord 提取 ImportanceMetadata（P1-Q4 修复）
 *
 * 用于 --explain 模式重构 importance 4 项明细追溯。
 */
function extractImportanceMetadata(record: MemoryRecord): ImportanceMetadata | undefined {
  // salience 优先从 metadata.salience 获取，回退到 record.confidence
  const salience =
    (typeof record.metadata?.salience === "number" ? record.metadata.salience : undefined) ??
    record.confidence;

  const sourceKind = mapProvenanceSourceToSourceKind(record.provenance?.source);
  const semanticType = record.semanticType;

  // 检测显式保存（从记忆文本）
  const explicitSave = detectExplicitSave(record.text);

  // 缺失必要字段时返回 undefined（computeNodeScoreWithBreakdown 会用默认值）
  if (!salience || !sourceKind || !semanticType) {
    return undefined;
  }

  return {
    salience,
    sourceKind,
    explicitSave,
    semanticType,
  };
}

function fmt(value: number): string {
  return value.toFixed(3);
}

/** 打印单条命中的 6 因子评分明细。 */
function printBreakdown(breakdown: NodeScoreBreakdown): void {
  const { factors, contributions } = breakdown;
  const rows: Array<[string, number, number]> = [
    ["relevance", factors.relevance, contributions.relevance],
    ["scopeFit", factors.scopeFit, contributions.scopeFit],
    ["importance", factors.importance, contributions.importance],
    ["confidence", factors.confidence, contributions.confidence],
    ["evidenceWeight", factors.evidenceWeight, contributions.evidenceWeight],
    ["recency", factors.recency, contributions.recency],
  ];
  for (const [name, value, contribution] of rows) {
    console.log(
      `    - ${name.padEnd(14)} value=${fmt(value)}  contribution=${fmt(contribution)}`,
    );
  }
  if (breakdown.importanceBreakdown) {
    const ib = breakdown.importanceBreakdown;
    console.log(
      `      importance 明细: salience=${fmt(ib.salience_llm)} authority=${fmt(ib.sourceAuthority)} explicit=${fmt(ib.explicitnessBonus)} type=${fmt(ib.typePrior)}`,
    );
  }
}

/** 注册 `ms recall <query>` 命令。 */
export function registerRecallCliCommands(memory: CommanderLike, deps: RecallCliDeps): void {
  const weights = deps.weights ?? DEFAULT_RECALL_WEIGHTS;

  memory
    .command("recall <query>")
    .description(
      "召回记忆并按综合分排序\n" +
        "--explain 展示 6 因子评分明细，并对低于 min-score 的候选给出 filteredReason",
    )
    .option("-l, --limit <n>", "最大返回条数", "10")
    .option("-s, --min-score <n>", "最小综合分阈值", "0.3")
    .option("--explain", "展示召回评分明细 + filteredReason", false)
    .action(async (...args: unknown[]) => {
      const query = args[0] as string;
      const options = (args[1] ?? {}) as RecallOptions;
      const limit = Number.parseInt(options.limit ?? "10", 10);
      const minScore = Number.parseFloat(options.minScore ?? "0.3");
      const explain = options.explain === true;

      if (!explain) {
        const result = await deps.service.recall({
          query,
          scope: deps.defaultScope,
          limit,
          minScore,
          searchAll: true,
        });
        console.log(`Found ${result.hits.length} results:\n`);
        for (const hit of result.hits) {
          console.log(`[${fmt(hit.score)}] ${hitText(hit.record)}`);
        }
        return;
      }

      // --explain：拉取更广候选集（min-score=0），本地计算综合分后再分区。
      const result = await deps.service.recall({
        query,
        scope: deps.defaultScope,
        limit: Math.max(limit * EXPLAIN_CANDIDATE_MULTIPLIER, limit),
        minScore: 0,
        searchAll: true,
      });

      // 召回阶段的向量相似度作为 relevance 因子注入。
      // P1-Q4 修复：提取 importanceMeta 以启用 4 项明细追溯。
      const scored = result.hits.map((hit) => {
        const record = hit.record as MemoryRecord;
        const importanceMeta = extractImportanceMetadata(record);
        const breakdown = computeNodeScoreWithBreakdown(
          record,
          weights,
          { relevance: hit.score },
          importanceMeta,
        );
        return { hit, breakdown };
      });

      // 按综合分降序（稳定排序）。
      const sorted = [...scored].sort((a, b) => b.breakdown.score - a.breakdown.score);

      const kept = sorted.filter((s) => s.breakdown.score >= minScore).slice(0, limit);
      const filtered = sorted.filter((s) => s.breakdown.score < minScore);

      console.log(`Recall explain for: "${query}"`);
      console.log(`min-score=${fmt(minScore)}  limit=${limit}  candidates=${sorted.length}\n`);

      console.log(`保留 ${kept.length} 条：`);
      for (const { hit, breakdown } of kept) {
        console.log(`\n  [total=${fmt(breakdown.score)}] ${hitText(hit.record)}`);
        printBreakdown(breakdown);
      }

      if (filtered.length > 0) {
        console.log(`\n过滤 ${filtered.length} 条：`);
        for (const { hit, breakdown } of filtered) {
          const filteredReason = `total score ${fmt(breakdown.score)} < min-score ${fmt(minScore)}`;
          console.log(`\n  [total=${fmt(breakdown.score)}] ${hitText(hit.record)}`);
          console.log(`    filteredReason: ${filteredReason}`);
          printBreakdown(breakdown);
        }
      }
    });
}
