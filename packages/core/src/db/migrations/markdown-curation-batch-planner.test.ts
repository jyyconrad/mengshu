import { describe, expect, test } from "vitest";

import {
  planMemoryCurationBatches,
  type MemoryCurationPlannerFile,
} from "./markdown-curation-batch-planner.js";
import type {
  MarkdownPreprocessNode,
  MarkdownPreprocessGroup,
} from "./markdown-workset-preprocessor.js";

const SCOPE = "a".repeat(64);

function node(
  id: string,
  semanticTypes: readonly string[] = [],
  flags: readonly string[] = [],
  scopeFingerprint: string | undefined = SCOPE,
): MarkdownPreprocessNode {
  return {
    sourceRef: `memories:${id}`,
    sourceHash: id.padEnd(64, "0").slice(0, 64),
    sourceTable: "memories",
    ...(scopeFingerprint ? { scopeFingerprint } : {}),
    normalizedContentHash: id.padEnd(64, "1").slice(0, 64),
    semanticTypeCandidates: semanticTypes.map((semanticType) => ({
      semanticType: semanticType as never,
      confidence: 0.9,
      reason: "test",
    })),
    logicalSourceCandidates: [],
    revisionCandidates: [],
    ordinalCandidates: [],
    resourceCandidates: [],
    topicCandidates: [],
    routeCandidates: {
      source: "insufficient_metadata",
      topic: "insufficient_metadata",
      global: "insufficient_metadata",
    },
    qualityFlags: flags,
  };
}

function file(id: string, bytes = 100): MemoryCurationPlannerFile {
  return {
    sourceRef: `memories:${id}`,
    sourceHash: id.padEnd(64, "0").slice(0, 64),
    relativePath: `source/memories/${id}.md`,
    markdownSha256: id.padEnd(64, "2").slice(0, 64),
    bytes,
  };
}

describe("Memory curation batch planner", () => {
  test("exact cluster 不拆分并生成互斥 quarantine/review/type batches", () => {
    const nodes = [
      node("a", ["rules"]),
      node("b", ["rules"]),
      node("c"),
      node("d", ["rules", "task_context"]),
      node("e", ["profile"], ["legacy_quarantine"]),
    ];
    const groups: readonly MarkdownPreprocessGroup[] = [{
      kind: "exact_content",
      key: "f".repeat(64),
      members: ["memories:a", "memories:b"],
    }];
    const result = planMemoryCurationBatches({
      migrationRunId: "run-01",
      sourceSnapshotSha256: "1".repeat(64),
      sourceManifestSha256: "2".repeat(64),
      preprocessedManifestSha256: "3".repeat(64),
      inventorySha256: "4".repeat(64),
      policyVersion: "memory-curation-batches/v1",
      createdAt: "2026-08-28T00:00:00.000Z",
      nodes,
      groups,
      files: ["a", "b", "c", "d", "e"].map((id) => file(id)),
      maxUnitsPerBatch: 30,
      maxBytesPerBatch: 400_000,
    });

    expect(result.summary).toMatchObject({
      sourceCount: 5,
      unitCount: 4,
      batchCount: 4,
      byCohort: {
        quarantine: { units: 1, sources: 1 },
        untyped: { units: 1, sources: 1 },
        type_conflict: { units: 1, sources: 1 },
        rules: { units: 1, sources: 2 },
      },
    });
    const exactUnit = result.units.find((unit) => unit.sourceRefs.includes("memories:a"));
    expect(exactUnit?.sourceRefs).toEqual(["memories:a", "memories:b"]);
    expect(result.batches.flatMap((batch) => batch.unitIds).sort())
      .toEqual(result.units.map((unit) => unit.unitId).sort());
  });

  test("输入顺序不影响 plan hash，超出 byte 上限的 unit 单独成批", () => {
    const nodes = [node("a", ["rules"]), node("b", ["rules"])];
    const common = {
      migrationRunId: "run-01",
      sourceSnapshotSha256: "1".repeat(64),
      sourceManifestSha256: "2".repeat(64),
      preprocessedManifestSha256: "3".repeat(64),
      inventorySha256: "4".repeat(64),
      policyVersion: "memory-curation-batches/v1",
      createdAt: "2026-08-28T00:00:00.000Z",
      groups: [],
      maxUnitsPerBatch: 30,
      maxBytesPerBatch: 150,
    } as const;
    const first = planMemoryCurationBatches({
      ...common,
      nodes,
      files: [file("a", 200), file("b", 100)],
    });
    const second = planMemoryCurationBatches({
      ...common,
      nodes: [...nodes].reverse(),
      files: [file("b", 100), file("a", 200)],
    });
    expect(first.planSha256).toBe(second.planSha256);
    expect(first.batches).toHaveLength(2);
  });

  test("拒绝跨 scope exact group、重复成员和缺失文件映射", () => {
    const crossScope = [node("a", ["rules"]), node("b", ["rules"], [], "b".repeat(64))];
    const group: MarkdownPreprocessGroup = {
      kind: "exact_content",
      key: "f".repeat(64),
      members: ["memories:a", "memories:b"],
    };
    const base = {
      migrationRunId: "run-01",
      sourceSnapshotSha256: "1".repeat(64),
      sourceManifestSha256: "2".repeat(64),
      preprocessedManifestSha256: "3".repeat(64),
      inventorySha256: "4".repeat(64),
      policyVersion: "memory-curation-batches/v1",
      createdAt: "2026-08-28T00:00:00.000Z",
      maxUnitsPerBatch: 30,
      maxBytesPerBatch: 400_000,
    } as const;
    expect(() => planMemoryCurationBatches({
      ...base,
      nodes: crossScope,
      groups: [group],
      files: [file("a"), file("b")],
    })).toThrow(/scope/i);
    expect(() => planMemoryCurationBatches({
      ...base,
      nodes: [node("a")],
      groups: [],
      files: [],
    })).toThrow(/coverage/i);
  });
});
