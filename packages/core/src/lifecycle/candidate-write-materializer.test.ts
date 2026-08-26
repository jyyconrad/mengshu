import { describe, expect, test, vi } from "vitest";

import type { MemorySemanticType } from "../domain/types.js";
import type { WriteMemoryRecord } from "../service/write-kernel.js";
import type { ComputedCandidateSpec } from "./candidate-spec-computation.js";
import { validateCandidateWithReceipt } from "./candidate-validator.js";
import {
  CandidateWriteMaterializationError,
  materializeCandidateWriteRecords,
  type CandidateWriteMaterializerDependencies,
} from "./candidate-write-materializer.js";

const scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  visibility: "private" as const,
});

type ContentRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

function spec(
  route: ContentRecord["route"],
  index: number,
  overrides: Partial<ComputedCandidateSpec> = {},
): ComputedCandidateSpec {
  const semanticType: MemorySemanticType = index % 2 === 0 ? "rules" : "experience";
  const validationReceipt = validateCandidateWithReceipt({
    text: `受治理的候选记忆 ${index}`,
    semanticType,
    salience: 0.83,
    temporality: "persistent",
    crossContextual: true,
    targetScope: "project",
    evidence: { quote: `候选记忆 ${index}`, eventIds: [`event-${index}`] },
  }, {
    text: `受治理的候选记忆 ${index}`,
    scope: "project",
    eventIds: [`event-${index}`],
  }, { candidateOrdinal: index }).receipt;
  return {
    text: `受治理的候选记忆 ${index}`,
    semanticType,
    kind: semanticType === "rules" ? "constraint" : "lesson",
    confidence: 0.83,
    reason: "fixture",
    extractor: "materializer-fixture",
    evidence: { quote: `候选记忆 ${index}`, eventIds: [`event-${index}`] },
    metadata: {
      admission: route,
      admissionReason: "fixture-admission",
      valueScore: route === "active" ? 0.92 : 0.63,
      salience: 0.83,
      targetScope: "project",
      riskFlags: [],
    },
    auditMetadata: { admission: route, semanticType, riskFlags: [] },
    validationReceipt,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<CandidateWriteMaterializerDependencies> = {},
): CandidateWriteMaterializerDependencies {
  return {
    embed: vi.fn(async ({ recordId }) => recordId.endsWith("-0") ? [0.1, 0.2] : [0.3, 0.4]),
    scoreImportance: vi.fn(async () => 0.37),
    exactDedup: vi.fn(async () => ({ duplicate: false })),
    semanticDedup: vi.fn(async () => ({ duplicate: false })),
    stampMetadata: (metadata) => metadata,
    ...overrides,
  };
}

function materialize(
  specs: readonly ComputedCandidateSpec[],
  deps = dependencies(),
  signal = new AbortController().signal,
) {
  return materializeCandidateWriteRecords(deps, {
    specs,
    scope,
    fallbackReason: null,
    traceId: "trace-a",
    intent: "auto",
    createdAt: 1_000,
    createRecordId: (index) => `record-${index}`,
  }, signal);
}

describe("candidate write materializer", () => {
  test("accepted validation receipt 原样持久化进 governance.candidate", async () => {
    const candidateSpec = spec("active", 0);
    const records = await materialize([candidateSpec]);

    expect(records[0].governance.candidate).toMatchObject({
      validationReceipt: candidateSpec.validationReceipt,
    });
    expect(records[0].governance.candidate.validationReceipt)
      .toEqual(candidateSpec.validationReceipt);
  });

  test("保留六种 admission route，并把 extractor 扩展 kind 确定性映射为 MemoryKind", async () => {
    const routes: readonly ContentRecord["route"][] = [
      "candidate_low_priority",
      "candidate",
      "active",
      "lookup_only",
      "evidence_only",
      "drop",
    ];

    const records = await materialize(routes.map((route, index) => spec(route, index)));

    expect(records.map((record) => record.route)).toEqual(routes);
    expect(records.map((record) => record.kind)).toEqual([
      "other", "decision", "other", "decision", "other", "decision",
    ]);
    expect(records.every((record) => Object.isFrozen(record))).toBe(true);
    expect(records.every((record) => Object.isFrozen(record.vector))).toBe(true);
  });

  test("importance 独立计算且 embedding 原样进入完整 record，不复用 valueScore/confidence", async () => {
    const stampMetadata = vi.fn((metadata) => metadata);
    const records = await materialize([spec("active", 0)], dependencies({ stampMetadata }));

    expect(records[0]).toMatchObject({
      id: "record-0",
      mutation: "content",
      commandType: "observeAuto",
      route: "active",
      valueScore: 0.92,
      importance: 0.37,
      confidence: 0.83,
      vector: [0.1, 0.2],
      semanticType: "rules",
      evidenceIds: ["event-0"],
      governance: {
        admissionReason: "fixture-admission",
        candidate: {
          originalKind: "constraint",
          extractor: "materializer-fixture",
          targetScope: "project",
          riskFlags: [],
          treeRouting: {
            version: 1,
            evidenceId: "event-0",
            sourceId: "session-a",
            entityIds: [],
            scopeVisibility: "project",
            riskFlags: [],
            topicLabels: [],
            topicHotnessEligible: false,
            explicitGlobal: false,
            isWorkspaceRule: false,
          },
        },
      },
    });
    expect(records[0]!.importance).not.toBe(records[0]!.valueScore);
    expect(records[0]!.importance).not.toBe(records[0]!.confidence);
    expect(stampMetadata).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      recordId: "record-0",
      scope,
      spec: expect.objectContaining({ semanticType: "rules" }),
    }));
  });

  test("exact duplicate 变为可重放的 drop record，并短路 semantic dedup", async () => {
    const semanticDedup = vi.fn(async () => ({ duplicate: false }));
    const deps = dependencies({
      exactDedup: vi.fn(async () => ({ duplicate: true, duplicateOf: "memory-existing" })),
      semanticDedup,
    });

    const records = await materialize([spec("active", 0)], deps);

    expect(records[0]).toMatchObject({
      id: "record-0",
      route: "drop",
      governance: {
        candidate: {
          dedup: { kind: "exact", duplicateOf: "memory-existing" },
        },
      },
    });
    expect(semanticDedup).not.toHaveBeenCalled();
  });

  test("semantic duplicate 变为 drop record，且 dedup 输入排除稳定批次 ID 并包含已接受批次", async () => {
    const seen: Array<{ excludeIds: readonly string[]; batchRecords: readonly ContentRecord[] }> = [];
    const deps = dependencies({
      semanticDedup: vi.fn(async (input) => {
        seen.push({ excludeIds: input.excludeIds, batchRecords: input.batchRecords });
        return input.recordId === "record-1"
          ? { duplicate: true, duplicateOf: "record-0" }
          : { duplicate: false };
      }),
    });

    const records = await materialize([spec("candidate", 0), spec("active", 1)], deps);

    expect(records.map((record) => record.route)).toEqual(["candidate", "drop"]);
    expect(records[1]!.governance.candidate).toMatchObject({
      dedup: { kind: "semantic", duplicateOf: "record-0" },
    });
    expect(seen[0]).toEqual({ excludeIds: ["record-0", "record-1"], batchRecords: [] });
    expect(seen[1]!.excludeIds).toEqual(["record-0", "record-1"]);
    expect(seen[1]!.batchRecords.map((record) => record.id)).toEqual(["record-0"]);
  });

  test("D-06 lexical duplicate 在治理回执中保留独立层级", async () => {
    const deps = dependencies({
      exactDedup: vi.fn(async () => ({
        duplicate: true,
        duplicateOf: "memory-lexical",
        layer: "lexical" as const,
      })),
    });

    const records = await materialize([spec("active", 0)], deps);

    expect(records[0]).toMatchObject({
      route: "drop",
      governance: {
        candidate: {
          dedup: { kind: "lexical", duplicateOf: "memory-lexical" },
        },
      },
    });
  });

  test("相同稳定输入重算得到相同 record snapshot", async () => {
    const input = [spec("active", 0), spec("candidate", 1)];

    const first = await materialize(input);
    const replay = await materialize(input);

    expect(replay).toEqual(first);
  });

  test.each([
    ["importance", dependencies({ scoreImportance: async () => Number.NaN })],
    ["vector", dependencies({ embed: async () => [0.1, Number.POSITIVE_INFINITY] })],
    ["dedup", dependencies({ exactDedup: async () => ({ duplicate: "yes" } as never) })],
  ])("非法 %s 输出在持久化前 fail-closed", async (_label, deps) => {
    await expect(materialize([spec("active", 0)], deps)).rejects.toBeInstanceOf(
      CandidateWriteMaterializationError,
    );
  });

  test("abort 在后续评分和去重前终止", async () => {
    const controller = new AbortController();
    const scoreImportance = vi.fn(async () => 0.37);
    const exactDedup = vi.fn(async () => ({ duplicate: false }));
    const deps = dependencies({
      embed: vi.fn(async () => {
        controller.abort(new DOMException("stop", "AbortError"));
        return [0.1, 0.2];
      }),
      scoreImportance,
      exactDedup,
    });

    await expect(materialize([spec("active", 0)], deps, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(scoreImportance).not.toHaveBeenCalled();
    expect(exactDedup).not.toHaveBeenCalled();
  });
});
