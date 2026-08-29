import { describe, expect, test } from "vitest";

import {
  governMarkdownWorkset,
  MarkdownWorksetGovernorError,
} from "./markdown-workset-governor.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  parseNativeRecordMarkdown,
  renderNativeRecordMarkdown,
  type MarkdownWorksetFileInput,
  type MarkdownWorksetNativeRecord,
} from "./markdown-workset.js";

const POLICY_VERSION = "markdown-governance/v1";
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);

function nativeRecord(
  id: string,
  overrides: Partial<MarkdownWorksetNativeRecord> = {},
): MarkdownWorksetNativeRecord {
  return {
    id,
    sourceTable: "memories",
    text: `记忆 ${id}`,
    contentHash: `legacy-${id}`,
    vector: [0.1, 0.2],
    importance: 0.7,
    category: "fact",
    dataType: "memory",
    metadata: { semanticType: "rules", evidenceRefs: [`evidence:${id}`] },
    createdAt: "2026-08-28T00:00:00.000Z",
    lifecycleStatus: "active",
    ...overrides,
  };
}

function sourceFile(
  record: MarkdownWorksetNativeRecord,
  scopeFingerprint: string | null = SCOPE_A,
): MarkdownWorksetFileInput {
  const source = createMarkdownWorksetRecord({
    phase: "source",
    scopeFingerprint: scopeFingerprint ?? undefined,
    record,
  });
  return {
    relativePath: `source/${record.sourceTable}/${record.id}.md`,
    markdown: renderNativeRecordMarkdown(source),
  };
}

function govern(files: readonly MarkdownWorksetFileInput[]) {
  const manifest = createMarkdownWorksetManifest({
    migrationRunId: "markdown-governor-test-run",
    phase: "source",
    policyVersion: "markdown-export/v1",
    createdAt: "2026-08-28T01:00:00.000Z",
    files,
  });
  return {
    manifest,
    result: governMarkdownWorkset({
      sourceManifest: manifest,
      sourceFiles: files,
      policyVersion: POLICY_VERSION,
    }),
  };
}

function governedRecord(
  result: ReturnType<typeof governMarkdownWorkset>,
  sourceRef: string,
) {
  const file = result.governedFiles.find((candidate) =>
    parseNativeRecordMarkdown(candidate.markdown).sourceRef === sourceRef);
  if (!file) throw new Error(`missing governed file for ${sourceRef}`);
  return parseNativeRecordMarkdown(file.markdown);
}

describe("Markdown migration workset governor", () => {
  test("strict verify 后 exact duplicate many-to-one，并在 canonical 文件聚合排序 mergedFrom", () => {
    const first = sourceFile(nativeRecord("memory-a", {
      text: "同一条规则",
      importance: 0.6,
    }));
    const second = sourceFile(nativeRecord("memory-b", {
      text: "同一条规则",
      importance: 0.9,
    }));
    const third = sourceFile(nativeRecord("memory-c", {
      text: "同一条规则",
      importance: 0.5,
    }));
    const sourceBytes = [first.markdown, second.markdown, third.markdown];

    const { manifest, result } = govern([third, second, first]);

    expect(result.plan.metrics).toMatchObject({
      sourceTotal: 3,
      sourceMappedTotal: 3,
      unresolvedTotal: 0,
      sourceMappingCoverage: 1,
    });
    expect(result.sourceSnapshotSha256).toBe(manifest.snapshotSha256);
    expect(result.plan.snapshotSha256).toBe(manifest.snapshotSha256);
    expect(result.governedManifest.snapshotSha256).toBe(manifest.snapshotSha256);
    expect(result.governedManifest.phase).toBe("governed");
    expect(result.governedFiles).toHaveLength(3);
    expect(result.governedFiles.every((file) => file.relativePath.startsWith("governed/")))
      .toBe(true);

    expect(governedRecord(result, "memories:memory-b")).toMatchObject({
      disposition: "canonical_keep",
      canonicalTargetRef: "memories:memory-b",
      mergedFrom: ["memories:memory-a", "memories:memory-c"],
      policyVersion: POLICY_VERSION,
    });
    expect(governedRecord(result, "memories:memory-a")).toMatchObject({
      disposition: "merge_exact",
      canonicalTargetRef: "memories:memory-b",
      mergedFrom: [],
    });
    expect([first.markdown, second.markdown, third.markdown]).toEqual(sourceBytes);
  });

  test("显式 revision、stale、Knowledge、缺 scope 与 conflict 分别得到保守 disposition", () => {
    const files = [
      sourceFile(nativeRecord("revision-old", {
        text: "旧规则",
        metadata: {
          semanticType: "rules",
          sourceIdentity: "rule://formatting",
          revision: { id: "v1", order: 1 },
        },
      })),
      sourceFile(nativeRecord("revision-new", {
        text: "新规则",
        metadata: {
          semanticType: "rules",
          sourceIdentity: "rule://formatting",
          revision: { id: "v2", order: 2 },
        },
      })),
      sourceFile(nativeRecord("stale", {
        metadata: { semanticType: "task_context", staleReason: "task_finished" },
      })),
      sourceFile(nativeRecord("knowledge", {
        sourceTable: "knowledge",
        dataType: "knowledge",
        metadata: {},
      })),
      sourceFile(nativeRecord("missing-scope"), null),
      sourceFile(nativeRecord("conflict", {
        metadata: { semanticType: "rules", conflict: true },
      })),
    ];

    const { result } = govern(files);
    const dispositions = Object.fromEntries(result.plan.mappings.map((mapping) => [
      mapping.sourceRef, mapping.disposition,
    ]));

    expect(dispositions).toEqual({
      "knowledge:knowledge": "lookup_only",
      "memories:conflict": "distinct_keep",
      "memories:missing-scope": "quarantine",
      "memories:revision-new": "canonical_keep",
      "memories:revision-old": "supersede",
      "memories:stale": "archive_stale",
    });
    expect(result.governedFiles).toHaveLength(files.length);
  });

  test("semantic merge 只接受 metadata 中当前 policy 明确批准且同 scope/type 的 target", () => {
    const target = sourceFile(nativeRecord("target", { text: "目标规则" }));
    const approved = sourceFile(nativeRecord("approved", {
      text: "语义相同规则",
      metadata: {
        semanticType: "rules",
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "memories:target",
          approved: true,
          policyVersion: POLICY_VERSION,
          method: "embedding",
          confidence: 0.94,
        },
      },
    }));
    const oldPolicy = sourceFile(nativeRecord("old-policy", {
      text: "旧策略建议",
      metadata: {
        semanticType: "rules",
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "memories:target",
          approved: true,
          policyVersion: "markdown-governance/old",
          method: "embedding",
          confidence: 0.99,
        },
      },
    }));
    const crossScope = sourceFile(nativeRecord("cross-scope", {
      text: "跨 scope 建议",
      metadata: {
        semanticType: "rules",
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "memories:target",
          approved: true,
          policyVersion: POLICY_VERSION,
          method: "graph",
          confidence: 0.98,
        },
      },
    }), SCOPE_B);
    const wrongType = sourceFile(nativeRecord("wrong-type", {
      text: "类型不兼容建议",
      metadata: {
        semanticType: "resource",
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "memories:target",
          approved: true,
          policyVersion: POLICY_VERSION,
          method: "lexical",
          confidence: 0.96,
        },
      },
    }));
    const notApproved = sourceFile(nativeRecord("not-approved", {
      text: "未经批准建议",
      metadata: {
        semanticType: "rules",
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "memories:target",
          approved: false,
          policyVersion: POLICY_VERSION,
          method: "embedding",
          confidence: 0.99,
        },
      },
    }));

    const { result } = govern([
      target, approved, oldPolicy, crossScope, wrongType, notApproved,
    ]);

    expect(governedRecord(result, "memories:approved")).toMatchObject({
      disposition: "merge_semantic",
      canonicalTargetRef: "memories:target",
    });
    expect(governedRecord(result, "memories:old-policy").disposition).toBe("distinct_keep");
    const quarantined = governedRecord(result, "memories:cross-scope");
    expect(quarantined.disposition).toBe("quarantine");
    expect(quarantined).not.toHaveProperty("canonicalTargetRef");
    expect(governedRecord(result, "memories:wrong-type").disposition).toBe("quarantine");
    expect(governedRecord(result, "memories:not-approved").disposition).toBe("distinct_keep");
    expect(governedRecord(result, "memories:target").mergedFrom)
      .toEqual(["memories:approved"]);
  });

  test("manifest/file 漂移在治理前 fail closed，不生成部分结果", () => {
    const file = sourceFile(nativeRecord("drift"));
    const manifest = createMarkdownWorksetManifest({
      migrationRunId: "markdown-governor-drift",
      phase: "source",
      policyVersion: "markdown-export/v1",
      createdAt: "2026-08-28T01:00:00.000Z",
      files: [file],
    });

    expect(() => governMarkdownWorkset({
      sourceManifest: manifest,
      sourceFiles: [{ ...file, markdown: file.markdown.replace("记忆", "篡改") }],
      policyVersion: POLICY_VERSION,
    })).toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_MANIFEST_DRIFT" }));
  });

  test("只接受 source manifest，且 policy version 必须是稳定非空文本", () => {
    const source = sourceFile(nativeRecord("phase"));
    const governed = createMarkdownWorksetRecord({
      phase: "governed",
      scopeFingerprint: SCOPE_A,
      disposition: "distinct_keep",
      canonicalTargetRef: "memories:phase",
      policyVersion: POLICY_VERSION,
      record: nativeRecord("phase"),
    });
    const file = { ...source, markdown: renderNativeRecordMarkdown(governed) };
    const manifest = createMarkdownWorksetManifest({
      migrationRunId: "markdown-governor-phase",
      phase: "governed",
      policyVersion: POLICY_VERSION,
      createdAt: "2026-08-28T01:00:00.000Z",
      files: [file],
    });

    expect(() => governMarkdownWorkset({
      sourceManifest: manifest,
      sourceFiles: [file],
      policyVersion: POLICY_VERSION,
    })).toThrowError(MarkdownWorksetGovernorError);
    expect(() => governMarkdownWorkset({
      sourceManifest: createMarkdownWorksetManifest({
        migrationRunId: "markdown-governor-source",
        phase: "source",
        policyVersion: "markdown-export/v1",
        createdAt: "2026-08-28T01:00:00.000Z",
        files: [source],
      }),
      sourceFiles: [source],
      policyVersion: " ",
    })).toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_GOVERNOR_INVALID_INPUT" }));
  });
});
