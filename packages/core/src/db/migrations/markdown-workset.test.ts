import { describe, expect, test } from "vitest";

import {
  MarkdownWorksetError,
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetSnapshotSha256,
  markdownWorksetManifestSha256,
  parseMarkdownWorksetManifest,
  parseNativeRecordMarkdown,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
  verifyMarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
} from "./markdown-workset.js";

const SCOPE_FINGERPRINT = "a".repeat(64);

function nativeRecord(
  overrides: Partial<MarkdownWorksetNativeRecord> = {},
): MarkdownWorksetNativeRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sourceTable: "memories",
    text: "第一行\n---\n<!-- mengshu-content-length: 7 -->\n最后一行",
    contentHash: "legacy-md5-or-sha256",
    vector: [0.1, -0.2, 0.3],
    importance: 0.8,
    category: "fact",
    dataType: "memory",
    metadata: {
      semanticType: "rules",
      nested: { b: 2, a: 1 },
      tags: ["governed", "migration"],
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    projectName: "memory-autodb",
    appName: "codex",
    userId: "user-a",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    tenantId: "tenant-a",
    canonicalProjectId: "project-a",
    productId: "codex",
    producerId: "agent-a",
    namespace: "memories",
    visibility: "private",
    lifecycleStatus: "active",
    embeddingSpaceId: `embedding-space:v1:${"b".repeat(64)}`,
    embeddingSpaceState: "known-queryable",
    scopeKey: "tenant-a:codex:user-a:project-a:agent-a:memories",
    ...overrides,
  };
}

describe("Markdown migration workset contract", () => {
  test("原始 PostgreSQL 记录可以经 Markdown 无损往返，正文中的伪 marker 不截断", () => {
    const record = createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: nativeRecord(),
    });

    const markdown = renderNativeRecordMarkdown(record);
    const parsed = parseNativeRecordMarkdown(markdown);

    expect(parsed).toEqual(record);
    expect(markdown).toContain("mengshu_workset_schema: mengshu.native-record-markdown/v1");
    expect(markdown).toContain("mengshu_source_ref: memories:11111111-1111-4111-8111-111111111111");
    expect(markdown).toContain("第一行");
  });

  test("迁移 raw envelope 原样保留 legacy data_type 与空的可选 scope 列", () => {
    const legacy = nativeRecord({
      dataType: "status" as never,
      workspaceId: "",
      importance: null as never,
    });
    const record = createMarkdownWorksetRecord({
      phase: "source",
      record: legacy,
    });

    expect(parseNativeRecordMarkdown(renderNativeRecordMarkdown(record)).record)
      .toMatchObject({ dataType: "status", workspaceId: "", importance: null });
  });

  test("governed 记录固定保存 disposition、canonical target、merged-from 与 policy", () => {
    const record = createMarkdownWorksetRecord({
      phase: "governed",
      scopeFingerprint: SCOPE_FINGERPRINT,
      disposition: "canonical_keep",
      canonicalTargetRef: "memories:11111111-1111-4111-8111-111111111111",
      mergedFrom: [
        "memories:33333333-3333-4333-8333-333333333333",
        "memories:22222222-2222-4222-8222-222222222222",
      ],
      policyVersion: "markdown-governance/v1",
      record: nativeRecord(),
    });

    expect(parseNativeRecordMarkdown(renderNativeRecordMarkdown(record))).toEqual({
      ...record,
      mergedFrom: [
        "memories:22222222-2222-4222-8222-222222222222",
        "memories:33333333-3333-4333-8333-333333333333",
      ],
    });
  });

  test("正文或 opaque envelope 被篡改时拒绝解析", () => {
    const markdown = renderNativeRecordMarkdown(createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: nativeRecord(),
    }));

    expect(() => parseNativeRecordMarkdown(markdown.replace("第一行", "被篡改")))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_CONTENT_DRIFT" }));
    expect(() => parseNativeRecordMarkdown(markdown.replace(/mengshu_envelope: (.)/, "mengshu_envelope: X")))
      .toThrowError(MarkdownWorksetError);
  });

  test("snapshot hash 与输入顺序无关，manifest 必须覆盖每个文件且 hash 一致", () => {
    const first = createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: nativeRecord(),
    });
    const second = createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: "b".repeat(64),
      record: nativeRecord({
        id: "22222222-2222-4222-8222-222222222222",
        sourceTable: "knowledge",
        dataType: "knowledge",
        namespace: "knowledge",
      }),
    });
    const files = [
      { relativePath: "source/memories/11/111.md", markdown: renderNativeRecordMarkdown(first) },
      { relativePath: "source/knowledge/22/222.md", markdown: renderNativeRecordMarkdown(second) },
    ];

    const manifest = createMarkdownWorksetManifest({
      migrationRunId: "markdown-migration-2026-08-28-01",
      phase: "source",
      policyVersion: "markdown-export/v1",
      createdAt: "2026-08-28T01:00:00.000Z",
      files,
    });

    expect(manifest.sourceCount).toBe(2);
    expect(manifest.snapshotSha256).toBe(markdownWorksetSnapshotSha256([second, first]));
    const serialized = serializeMarkdownWorksetManifest(manifest);
    expect(parseMarkdownWorksetManifest(serialized)).toEqual(manifest);
    expect(markdownWorksetManifestSha256(serialized)).toMatch(/^[0-9a-f]{64}$/);
    expect(markdownWorksetManifestSha256(serializeMarkdownWorksetManifest(
      parseMarkdownWorksetManifest(serialized),
    ))).toBe(markdownWorksetManifestSha256(serialized));
    expect(verifyMarkdownWorksetManifest(manifest, [...files].reverse())).toEqual({
      sourceCount: 2,
      verifiedCount: 2,
      snapshotSha256: manifest.snapshotSha256,
    });
    expect(() => verifyMarkdownWorksetManifest(manifest, files.slice(0, 1)))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_MANIFEST_DRIFT" }));
  });

  test("非法向量、重复 source ref 和 source count 漂移均 fail closed", () => {
    expect(() => createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: nativeRecord({ vector: [Number.NaN] }),
    })).toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_INVALID_INPUT" }));

    const record = createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: SCOPE_FINGERPRINT,
      record: nativeRecord(),
    });
    expect(() => markdownWorksetSnapshotSha256([record, record]))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_DUPLICATE_SOURCE_REF" }));
    expect(() => parseMarkdownWorksetManifest("{\"schema\":\"attacker\"}"))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_WORKSET_MANIFEST_DRIFT" }));
  });
});
