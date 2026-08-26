/**
 * cli-recall.ts 单元测试。
 *
 * 验证 `ms recall <query>` 命令注册与 --explain 行为：
 * 1. 以 "recall <query>" 名注册，带 description 与 --explain/--limit/--min-score 选项。
 * 2. 普通模式下按 minScore 过滤并打印命中。
 * 3. --explain 模式下打印 6 因子评分明细，并对低于 min-score 的候选给出 filteredReason。
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { registerRecallCliCommands } from "./recall.js";
import type { CommanderLike } from "./index.js";
import type { MemoryService } from "../../../../core/service-types.js";
import type { MemoryScope, MemoryRecord, RecallResult } from "../../../../core/types.js";
import {
  computeNodeScoreWithBreakdown,
  computeRecallScoreBreakdown,
} from "../../../../core/recall-scoring.js";

interface FakeCommand {
  name: string;
  description?: string;
  options: Array<{ flag: string; description: string; defaultValue?: unknown }>;
  action?: (...args: unknown[]) => unknown;
}

function makeFakeCommander(): {
  commander: CommanderLike;
  commands: FakeCommand[];
} {
  const commands: FakeCommand[] = [];
  let current: FakeCommand | undefined;
  const commander: CommanderLike = {
    command(name: string) {
      current = { name, options: [] };
      commands.push(current);
      return commander;
    },
    description(text: string) {
      if (current) current.description = text;
      return commander;
    },
    option(flag: string, description: string, defaultValue?: unknown) {
      if (current) current.options.push({ flag, description, defaultValue });
      return commander;
    },
    action(handler: (...args: unknown[]) => unknown) {
      if (current) current.action = handler;
      return commander;
    },
  };
  return { commander, commands };
}

const scope: MemoryScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "default",
  projectId: "default",
  agentId: "default",
  namespace: "memories",
};

function makeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    scope,
    kind: "fact",
    text: overrides.text ?? `record-${id}`,
    contentHash: `hash-${id}`,
    importance: overrides.importance ?? 0.5,
    category: "core",
    dataType: "memory",
    metadata: {},
    provenance: { source: "user" },
    createdAt: 0,
    ...overrides,
  };
}

/** 构造一个返回固定 hits 的 fake service。 */
function makeFakeService(
  recordsWithScore: Array<{ record: MemoryRecord; score: number }>,
): MemoryService {
  const recall = vi.fn(async (): Promise<RecallResult> => ({
    scope,
    query: "q",
    hits: recordsWithScore.map((r) => ({
      record: r.record,
      score: computeRecallScoreBreakdown(r.record, {
        relevance: r.score,
        scopeFit: 1,
      }, ["vector"], { vector: r.score }).score,
      source: "vector" as const,
      scoreBreakdown: computeRecallScoreBreakdown(r.record, {
        relevance: r.score,
        scopeFit: 1,
      }, ["vector"], { vector: r.score }),
    })),
  }));
  return { recall } as unknown as MemoryService;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

function loggedOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

describe("registerRecallCliCommands", () => {
  test("注册 recall 命令并带 --explain 选项", () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"));
    expect(recall).toBeDefined();
    expect(recall?.description).toBeTruthy();
    const flags = recall?.options.map((o) => o.flag) ?? [];
    expect(flags.some((f) => f.includes("--explain"))).toBe(true);
    expect(flags.some((f) => f.includes("--limit"))).toBe(true);
    expect(flags.some((f) => f.includes("--min-score"))).toBe(true);
  });

  test("普通模式打印命中数量与分数", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        { record: makeRecord("a", { text: "alpha" }), score: 0.9 },
        { record: makeRecord("b", { text: "beta" }), score: 0.8 },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;
    await recall.action!("q", { limit: "10", minScore: "0.3", explain: false });
    const out = loggedOutput();
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  test("--explain 打印 6 因子明细", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        { record: makeRecord("a", { text: "alpha", importance: 0.9 }), score: 0.9 },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;
    await recall.action!("q", { limit: "10", minScore: "0.3", explain: true });
    const out = loggedOutput();
    expect(out).toContain("relevance");
    expect(out).toContain("importance");
    expect(out).toContain("confidence");
    expect(out).toContain("recency");
    // 总分应出现
    expect(out).toMatch(/total|综合分|score/i);
  });

  test("--explain 原样消费服务六因子回执，不把最终 score 再当 relevance", async () => {
    const { commander, commands } = makeFakeCommander();
    const record = makeRecord("authoritative", { text: "authoritative-breakdown" });
    const breakdown = computeNodeScoreWithBreakdown(record, undefined, {
      relevance: 0.1,
      scopeFit: 1,
    });
    const service = {
      recall: vi.fn(async () => ({
        scope,
        query: "q",
        hits: [{
          record,
          score: breakdown.score,
          source: "vector" as const,
          scoreBreakdown: {
            ...breakdown,
            matchedBy: ["vector" as const],
            sourceSignals: { vector: 0.1 },
          },
        }],
      })),
    } as unknown as MemoryService;
    registerRecallCliCommands(commander, { service, defaultScope: scope });

    await commands.find((c) => c.name.startsWith("recall"))!
      .action!("q", { limit: "10", minScore: "0", explain: true });

    expect(loggedOutput()).toContain("relevance      value=0.100");
  });

  test.each([false, true])("explain=%s 时缺少完整回执都 fail-closed", async (explain) => {
    const { commander, commands } = makeFakeCommander();
    const record = makeRecord("invalid", { text: "must not be recomputed" });
    const service = {
      recall: vi.fn(async () => ({
        scope,
        query: "q",
        hits: [{ record, score: 0.9, source: "vector" as const }],
      })),
    } as unknown as MemoryService;
    registerRecallCliCommands(commander, { service, defaultScope: scope });

    await expect(commands.find((c) => c.name.startsWith("recall"))!
      .action!("q", { limit: "10", minScore: "0", explain }))
      .rejects.toThrow("RECALL_SCORE_BREAKDOWN_REQUIRED");
    expect(loggedOutput()).not.toContain("must not be recomputed");
  });

  test("--explain 对低于 min-score 的候选给出 filteredReason", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        { record: makeRecord("keep", { text: "keep-me" }), score: 0.9 },
        { record: makeRecord("drop", { text: "drop-me" }), score: 0.1 },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;
    await recall.action!("q", { limit: "10", minScore: "0.5", explain: true });
    const out = loggedOutput();
    expect(out).toContain("drop-me");
    expect(out).toMatch(/filteredReason|min-score|过滤/i);
  });

  test("--explain 原样展示 governed retrieval filteredReason", async () => {
    const { commander, commands } = makeFakeCommander();
    const service = {
      recall: vi.fn(async (): Promise<RecallResult> => ({
        scope,
        query: "q",
        hits: [],
        filtered: [{
          candidateId: "graph:blocked",
          authoritativeRecordId: "memory-blocked",
          source: "entity_graph",
          filteredReason: "evidence_unavailable",
        }],
      })),
    } as unknown as MemoryService;
    registerRecallCliCommands(commander, { service, defaultScope: scope });

    await commands.find((c) => c.name.startsWith("recall"))!
      .action!("q", { limit: "10", minScore: "0", explain: true });

    expect(loggedOutput()).toContain("memory-blocked [entity_graph] filteredReason: evidence_unavailable");
  });

  test("P1-Q4: --explain 展示 importance 4 项明细（含 metadata.salience）", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        {
          record: makeRecord("a", {
            text: "记住这条规则",
            importance: 0.85,
            metadata: { salience: 0.9 },
            provenance: { source: "user" },
            semanticType: "rules",
          }),
          score: 0.9,
        },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;
    await recall.action!("q", { limit: "10", minScore: "0.3", explain: true });
    const out = loggedOutput();

    // 验证 6 因子明细存在
    expect(out).toContain("relevance");
    expect(out).toContain("importance");

    // P1-Q4 核心验证：importance 4 项明细追溯
    expect(out).toMatch(/importance 明细|salience|authority|explicit|type/i);
  });

  test("P1-Q4: 缺失元数据时不显示 importance 明细", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        {
          record: makeRecord("b", {
            text: "无元数据记录",
            importance: 0.6,
            // 缺少 metadata.salience, provenance.source, semanticType
          }),
          score: 0.8,
        },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;
    await recall.action!("q", { limit: "10", minScore: "0.3", explain: true });
    const out = loggedOutput();

    // 6 因子明细应该存在
    expect(out).toContain("relevance");
    expect(out).toContain("importance");

    // importance 明细行不应出现（因为缺失必要元数据）
    const lines = out.split("\n");
    const hasImportanceBreakdown = lines.some((line) =>
      /importance 明细.*salience.*authority/.test(line),
    );
    expect(hasImportanceBreakdown).toBe(false);
  });

  test("P1-Q4: confidence 可作为 salience 回退", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        {
          record: makeRecord("c", {
            text: "使用 confidence 作为 salience",
            importance: 0.7,
            confidence: 0.8, // 回退为 salience
            provenance: { source: "agent" },
            semanticType: "experience",
          }),
          score: 0.85,
        },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;
    await recall.action!("q", { limit: "10", minScore: "0.3", explain: true });
    const out = loggedOutput();

    // 应该能显示 importance 明细（因为 confidence 可作为 salience）
    expect(out).toMatch(/importance 明细|salience|authority/i);
  });

  test("--explain 遇到历史非数值评分字段时不崩溃", async () => {
    const { commander, commands } = makeFakeCommander();
    registerRecallCliCommands(commander, {
      service: makeFakeService([
        {
          record: makeRecord("legacy", {
            text: "legacy score shape",
            hotness: { queryHits30d: 1 } as never,
          }),
          score: 0.8,
        },
      ]),
      defaultScope: scope,
    });
    const recall = commands.find((c) => c.name.startsWith("recall"))!;

    await expect(
      recall.action!("q", { limit: "10", minScore: "0.3", explain: true }),
    ).resolves.not.toThrow();
    expect(loggedOutput()).toContain("legacy score shape");
  });
});
