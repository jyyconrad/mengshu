import { describe, expect, test } from "vitest";

import {
  CanonicalMarkdownAssetError,
  canonicalMarkdownAssetManifestSha256,
  createCanonicalMarkdownAsset,
  createCanonicalMarkdownAssetManifest,
  parseCanonicalMarkdownAsset,
  parseCanonicalMarkdownAssetManifest,
  renderCanonicalMarkdownAsset,
  serializeCanonicalMarkdownAssetManifest,
  type CanonicalMarkdownAsset,
} from "./canonical-markdown-asset.js";

const SCOPE = "a".repeat(64);
const SNAPSHOT = "b".repeat(64);
const POLICY = "canonical-asset/v1";

function memoryAsset(overrides: Partial<CanonicalMarkdownAsset> = {}): CanonicalMarkdownAsset {
  return createCanonicalMarkdownAsset({
    kind: "memory",
    scopeFingerprint: SCOPE,
    semanticType: "rules",
    sourceBindings: [
      { sourceRef: "memories:source-c", sourceHash: "3".repeat(64) },
      { sourceRef: "memories:source-a", sourceHash: "1".repeat(64) },
      { sourceRef: "memories:source-b", sourceHash: "2".repeat(64) },
    ],
    policyVersion: POLICY,
    records: [
      {
        recordId: "rule-b",
        recordKind: "record",
        text: "提交前必须运行严格类型检查。",
        metadata: { evidenceRefs: ["evidence-b"], priority: 2 },
      },
      {
        recordId: "rule-a",
        recordKind: "chunk",
        text: "先验证源快照，再生成 canonical asset。\n第二行保留。",
        metadata: { evidenceRefs: ["evidence-a"] },
      },
    ],
    ...overrides,
  });
}

describe("canonical Markdown asset", () => {
  test("Memory 多记录 asset 规范化来源与记录顺序，并严格往返完整 envelope", () => {
    const asset = memoryAsset();
    const repeated = memoryAsset();
    const markdown = renderCanonicalMarkdownAsset(asset);

    expect(asset.assetId).toBe(repeated.assetId);
    expect(asset.contentHash).toBe(repeated.contentHash);
    expect(asset.sourceBindings).toEqual([
      { sourceRef: "memories:source-a", sourceHash: "1".repeat(64) },
      { sourceRef: "memories:source-b", sourceHash: "2".repeat(64) },
      { sourceRef: "memories:source-c", sourceHash: "3".repeat(64) },
    ]);
    expect(asset.records.map((record) => record.recordId)).toEqual(["rule-a", "rule-b"]);
    expect(markdown).toContain("# Canonical Memory Asset");
    expect(markdown).toContain("先验证源快照");
    expect(parseCanonicalMarkdownAsset(markdown)).toEqual(asset);
  });

  test("Knowledge 可带 logicalSource/revision；Memory 必须有 semanticType 且不得带 Knowledge identity", () => {
    const knowledge = createCanonicalMarkdownAsset({
      kind: "knowledge",
      scopeFingerprint: SCOPE,
      logicalSource: "https://docs.example.com/guide",
      revision: { id: "rev-2", order: 2 },
      sourceBindings: [{ sourceRef: "knowledge:chunk-1", sourceHash: "4".repeat(64) }],
      policyVersion: POLICY,
      records: [{
        recordId: "chunk-1",
        recordKind: "chunk",
        text: "知识正文",
        metadata: {},
      }],
    });

    expect(parseCanonicalMarkdownAsset(renderCanonicalMarkdownAsset(knowledge))).toEqual(knowledge);
    expect(knowledge.assetId).toMatch(/^canonical_knowledge_[0-9a-f]{32}$/);
    expect(() => createCanonicalMarkdownAsset({
      kind: "memory",
      scopeFingerprint: SCOPE,
      sourceBindings: [{ sourceRef: "memories:1", sourceHash: "1".repeat(64) }],
      policyVersion: POLICY,
      records: [{ recordId: "r1", recordKind: "record", text: "x", metadata: {} }],
    })).toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_INVALID_INPUT" }));
    expect(() => memoryAsset({ logicalSource: "forbidden" } as Partial<CanonicalMarkdownAsset>))
      .toThrowError(CanonicalMarkdownAssetError);
  });

  test("正文、opaque envelope、identity/content hash 任一漂移均 fail closed", () => {
    const markdown = renderCanonicalMarkdownAsset(memoryAsset());

    expect(() => parseCanonicalMarkdownAsset(markdown.replace("先验证源快照", "直接覆盖源快照")))
      .toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_CONTENT_DRIFT" }));
    expect(() => parseCanonicalMarkdownAsset(markdown.replace(/mengshu_envelope: (.)/, "mengshu_envelope: X")))
      .toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT" }));
    expect(() => parseCanonicalMarkdownAsset(markdown.replace(
      /mengshu_content_hash: [0-9a-f]{64}/,
      `mengshu_content_hash: ${"f".repeat(64)}`,
    ))).toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_HASH_DRIFT" }));
    expect(() => parseCanonicalMarkdownAsset(markdown.replace(
      /mengshu_asset_id: canonical_memory_[0-9a-f]{32}/,
      `mengshu_asset_id: canonical_memory_${"f".repeat(32)}`,
    ))).toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_HASH_DRIFT" }));
  });

  test("重复 record/source、来源数量错位与非法 revision 均拒绝", () => {
    expect(() => createCanonicalMarkdownAsset({
      kind: "memory",
      scopeFingerprint: SCOPE,
      semanticType: "rules",
      sourceBindings: [
        { sourceRef: "memories:1", sourceHash: "1".repeat(64) },
        { sourceRef: "memories:1", sourceHash: "2".repeat(64) },
      ],
      policyVersion: POLICY,
      records: [{ recordId: "r1", recordKind: "record", text: "x", metadata: {} }],
    })).toThrowError(CanonicalMarkdownAssetError);
    expect(() => createCanonicalMarkdownAsset({
      kind: "knowledge",
      scopeFingerprint: SCOPE,
      sourceBindings: [],
      policyVersion: POLICY,
      records: [{ recordId: "r1", recordKind: "chunk", text: "x", metadata: {} }],
    })).toThrowError(CanonicalMarkdownAssetError);
    expect(() => createCanonicalMarkdownAsset({
      kind: "knowledge",
      scopeFingerprint: SCOPE,
      logicalSource: "guide",
      revision: { id: "v0", order: -1 },
      sourceBindings: [{ sourceRef: "knowledge:1", sourceHash: "1".repeat(64) }],
      policyVersion: POLICY,
      records: [
        { recordId: "same", recordKind: "chunk", text: "a", metadata: {} },
        { recordId: "same", recordKind: "chunk", text: "b", metadata: {} },
      ],
    })).toThrowError(CanonicalMarkdownAssetError);
  });
});

describe("canonical Markdown asset manifest", () => {
  test("从 asset 文件推导 mapped/asset count、文件 hash 与确定性序列化", () => {
    const memory = memoryAsset();
    const knowledge = createCanonicalMarkdownAsset({
      kind: "knowledge",
      scopeFingerprint: SCOPE,
      sourceBindings: [{ sourceRef: "knowledge:chunk-1", sourceHash: "4".repeat(64) }],
      policyVersion: POLICY,
      records: [{ recordId: "chunk-1", recordKind: "chunk", text: "知识", metadata: {} }],
    });
    const manifest = createCanonicalMarkdownAssetManifest({
      governanceRunId: "governance-run-1",
      policyVersion: POLICY,
      createdAt: "2026-08-28T08:00:00.000Z",
      sourceCount: 6,
      archiveCount: 1,
      quarantineCount: 1,
      sourceSnapshotSha256: SNAPSHOT,
      files: [
        { relativePath: "assets/z-knowledge.md", markdown: renderCanonicalMarkdownAsset(knowledge) },
        { relativePath: "assets/a-memory.md", markdown: renderCanonicalMarkdownAsset(memory) },
      ],
    });
    const serialized = serializeCanonicalMarkdownAssetManifest(manifest);

    expect(manifest).toMatchObject({
      sourceCount: 6,
      mappedCount: 4,
      assetCount: 2,
      archiveCount: 1,
      quarantineCount: 1,
      sourceSnapshotSha256: SNAPSHOT,
    });
    expect(manifest.files.map((file) => file.relativePath)).toEqual([
      "assets/a-memory.md", "assets/z-knowledge.md",
    ]);
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.markdownSha256)))
      .toBe(true);
    expect(parseCanonicalMarkdownAssetManifest(serialized)).toEqual(manifest);
    expect(canonicalMarkdownAssetManifestSha256(serialized)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("source 守恒、跨 asset 重复来源、文件漂移和 manifest 篡改均拒绝", () => {
    const asset = memoryAsset();
    const markdown = renderCanonicalMarkdownAsset(asset);
    const base = {
      governanceRunId: "governance-run-1",
      policyVersion: POLICY,
      createdAt: "2026-08-28T08:00:00.000Z",
      sourceCount: 3,
      archiveCount: 0,
      quarantineCount: 0,
      sourceSnapshotSha256: SNAPSHOT,
      files: [{ relativePath: "assets/a.md", markdown }],
    };
    const manifest = createCanonicalMarkdownAssetManifest(base);
    const serialized = serializeCanonicalMarkdownAssetManifest(manifest);

    expect(() => createCanonicalMarkdownAssetManifest({ ...base, sourceCount: 4 }))
      .toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT" }));
    expect(() => createCanonicalMarkdownAssetManifest({
      ...base,
      sourceCount: 6,
      files: [
        ...base.files,
        { relativePath: "assets/b.md", markdown },
      ],
    })).toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT" }));
    expect(() => createCanonicalMarkdownAssetManifest({
      ...base,
      files: [{ ...base.files[0]!, markdown: markdown.replace("先验证", "已篡改") }],
    })).toThrowError(CanonicalMarkdownAssetError);
    expect(() => parseCanonicalMarkdownAssetManifest(serialized.replace(
      '"assetCount": 1', '"assetCount": 2',
    ))).toThrowError(expect.objectContaining({ code: "CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT" }));
    expect(() => canonicalMarkdownAssetManifestSha256(`${serialized} `))
      .toThrowError(CanonicalMarkdownAssetError);
  });
});
