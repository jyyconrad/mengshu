import { describe, expect, test } from "vitest";

import {
  createMarkdownWorksetRecord,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetRecord,
} from "./markdown-workset.js";
import {
  assembleMarkdownWorksetPreprocessInventory,
  preprocessMarkdownWorksetRecord,
  preprocessMarkdownWorkset,
} from "./markdown-workset-preprocessor.js";

const SCOPE = "a".repeat(64);
const OTHER_SCOPE = "b".repeat(64);

function source(
  id: string,
  overrides: Partial<MarkdownWorksetNativeRecord> = {},
  scopeFingerprint: string | null = SCOPE,
): MarkdownWorksetRecord {
  return createMarkdownWorksetRecord({
    phase: "source",
    ...(scopeFingerprint ? { scopeFingerprint } : {}),
    record: {
      id,
      sourceTable: "memories",
      text: `memory ${id}`,
      contentHash: `legacy-${id}`,
      vector: [0.1, 0.2],
      importance: 0.8,
      category: "fact",
      dataType: "fact",
      metadata: {},
      createdAt: "2026-08-28T00:00:00.000Z",
      ...overrides,
    },
  });
}

describe("Markdown workset preprocessor", () => {
  test("两遍索引在输入乱序时仍稳定生成 exact/source/revision 关系", () => {
    const records = [
      source("r2", {
        text: "same\r\ncontent",
        metadata: {
          source: "docs/guide.md",
          revision: { id: "rev-2", order: 2 },
          semanticType: "rules",
          valueScore: 0.9,
          topicLabels: ["Runtime", "runtime"],
        },
      }),
      source("r1", {
        text: "same\ncontent",
        metadata: {
          source: "docs/guide.md",
          revision: { id: "rev-1", order: 1 },
          semanticType: "rules",
          valueScore: 0.9,
          topicLabels: ["Runtime"],
        },
      }),
    ];

    const first = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records,
    });
    const second = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records: [...records].reverse(),
    });

    expect(first.inventorySha256).toBe(second.inventorySha256);
    expect(first.nodes.map((node) => node.sourceRef)).toEqual([
      "memories:r1", "memories:r2",
    ]);
    expect(first.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "exact_content",
        members: ["memories:r1", "memories:r2"],
      }),
      expect.objectContaining({
        kind: "logical_source",
        members: ["memories:r1", "memories:r2"],
      }),
    ]));
    expect(first.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "exact_duplicate_candidate",
        from: "memories:r2",
        to: "memories:r1",
      }),
      expect.objectContaining({
        kind: "revision_successor_candidate",
        from: "memories:r2",
        to: "memories:r1",
      }),
    ]));
  });

  test("只生成 5type 与树路由候选，不把候选升级为最终裁决", () => {
    const result = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records: [source("typed", {
        text: "项目里必须运行 npm test，并记录结果。",
        importance: 0.9,
        metadata: {
          semanticType: "rules",
          valueScore: 0.72,
          topicLabels: ["Quality Gate"],
          explicitGlobal: true,
        },
      })],
    });

    expect(result.nodes[0]).toMatchObject({
      semanticTypeCandidates: [
        expect.objectContaining({ semanticType: "rules", reason: "metadata.semanticType" }),
      ],
      routeCandidates: {
        source: "threshold_met",
        topic: "threshold_met",
        global: "threshold_met",
      },
    });
    expect(result.nodes[0]).not.toHaveProperty("semanticType");
    expect(result.nodes[0]).not.toHaveProperty("disposition");
  });

  test("缺失 scope 时不跨记录建立 exact/source/resource 聚合关系", () => {
    const records = [
      source("u1", {
        text: "same",
        metadata: { source: "https://example.invalid/doc" },
      }, null),
      source("u2", {
        text: "same",
        metadata: { source: "https://example.invalid/doc" },
      }, null),
    ];
    const result = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records,
    });

    expect(result.groups).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.nodes.every((node) => node.qualityFlags.includes("missing_scope"))).toBe(true);
  });

  test("同值不能跨 exact scope 聚合，resource locator 只形成候选", () => {
    const first = source("s1", {
      text: "same",
      sourceTable: "knowledge",
      metadata: {
        source: "kb",
        path: "docs/api.md",
        revisionId: "rev-a",
      },
    }, SCOPE);
    const second = source("s2", {
      text: "same",
      sourceTable: "knowledge",
      metadata: {
        source: "kb",
        path: "docs/api.md",
        revisionId: "rev-a",
      },
    }, OTHER_SCOPE);

    const result = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records: [first, second],
    });

    expect(result.groups).toEqual([]);
    expect(result.nodes[0]?.resourceCandidates).toContainEqual(expect.objectContaining({
      kind: "path",
      locator: "docs/api.md",
    }));
    expect(result.nodes[0]?.semanticTypeCandidates).toContainEqual(expect.objectContaining({
      semanticType: "resource",
      reason: "knowledge_namespace_hint",
    }));
  });

  test("拒绝 governed phase、重复 sourceRef 和无效快照哈希", () => {
    const valid = source("one");
    const governed = createMarkdownWorksetRecord({
      phase: "governed",
      disposition: "canonical_keep",
      policyVersion: "govern/v1",
      scopeFingerprint: SCOPE,
      record: valid.record,
    });
    expect(() => preprocessMarkdownWorkset({
      sourceSnapshotSha256: "bad",
      policyVersion: "markdown-preprocess/v1",
      records: [valid],
    })).toThrow(/invalid/i);
    expect(() => preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records: [valid, valid],
    })).toThrow(/duplicate/i);
    expect(() => preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records: [governed],
    })).toThrow(/source phase/i);
  });

  test("流式单记录节点与批量汇总产生同一 inventory hash", () => {
    const records = [source("stream-2"), source("stream-1")];
    const batch = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      records,
    });
    const streamed = assembleMarkdownWorksetPreprocessInventory({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v1",
      nodes: records.map(preprocessMarkdownWorksetRecord).reverse(),
    });
    expect(streamed.inventorySha256).toBe(batch.inventorySha256);
    expect(streamed).toEqual(batch);
  });

  test("documentId + 连续 ordinal 只形成显式 snapshot revision 候选", () => {
    const records = [0, 1, 2].map((ordinal) => source(`chunk-${ordinal}`, {
      sourceTable: "knowledge",
      text: `chunk ${ordinal}`,
      metadata: {
        documentId: "11111111-1111-4111-8111-111111111111",
        logicalId: `logical-chunk-${ordinal}`,
        sourceId: `source-chunk-${ordinal}`,
        ordinal,
      },
    }));
    const result = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v2",
      records,
    });

    expect(result.groups).toContainEqual(expect.objectContaining({
      kind: "snapshot_revision",
      members: ["knowledge:chunk-0", "knowledge:chunk-1", "knowledge:chunk-2"],
    }));
    expect(result.relationships).toContainEqual(expect.objectContaining({
      kind: "same_snapshot_revision_candidate",
      from: "knowledge:chunk-1",
      to: "knowledge:chunk-0",
    }));
    expect(result.nodes[0]?.ordinalCandidates).toEqual([
      { ordinal: 0, field: "ordinal", confidence: 1 },
    ]);
    expect(result.nodes[0]?.logicalSourceCandidates.map((candidate) => candidate.field))
      .toEqual(expect.arrayContaining(["documentId", "logicalId", "sourceId"]));
    expect(result.summary.snapshotRevisionGroups).toBeGreaterThan(0);
  });

  test("fileModifiedAt 是来源修订候选，updatedAt 不是", () => {
    const result = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v2",
      records: [source("file", {
        metadata: {
          filePath: "docs/guide.md",
          fileModifiedAt: 1_778_000_000_000,
          updatedAt: 1_779_000_000_000,
        },
      })],
    });
    expect(result.nodes[0]?.revisionCandidates).toContainEqual({
      id: "mtime:1778000000000",
      field: "fileModifiedAt",
      confidence: 0.95,
      order: 1_778_000_000_000,
    });
    expect(result.nodes[0]?.revisionCandidates.some((candidate) =>
      candidate.field === "updatedAt")).toBe(false);
  });

  test("URL 只规范化协议和主机名，大小写敏感 path 不合并", () => {
    const result = preprocessMarkdownWorkset({
      sourceSnapshotSha256: "c".repeat(64),
      policyVersion: "markdown-preprocess/v3",
      records: [
        source("url-a", { metadata: { source: "HTTPS://EXAMPLE.COM/Docs/Guide" } }),
        source("url-b", { metadata: { source: "https://example.com/docs/guide" } }),
        source("url-c", { metadata: { source: "https://example.com/Docs/Guide" } }),
      ],
    });
    expect(result.groups).toContainEqual(expect.objectContaining({
      kind: "logical_source",
      members: ["memories:url-a", "memories:url-c"],
    }));
    expect(result.groups.some((group) => group.kind === "logical_source" &&
      group.members.includes("memories:url-b") && group.members.includes("memories:url-a")))
      .toBe(false);
  });
});
