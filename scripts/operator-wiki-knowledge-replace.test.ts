import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  auditRecordReason,
  buildBaselineReceipt,
  buildInputsDiff,
  claimPathViolation,
  coverageReport,
  dedupeWikiPages,
  detectContentHashConflicts,
  embeddingSpaceQueryFallback,
  evaluateKnownIssues,
  excerptMatches,
  extractWorksetBody,
  mergeRecordError,
  parseAnalysisLine,
  parseBatchFileName,
  parseWikiPage,
  resolveEmbeddingDims,
  runAudit,
  runFreeze,
  runMerge,
  runPreflight,
  scanWikiRoot,
  searchOldRunEvidence,
  type AnalysisRecord,
  type SourceManifestEntry,
  type WikiPage,
} from "./operator-wiki-knowledge-replace.js";

const SCOPE_A = "local:mengshu:default:knowledge-a:default:knowledge";
const SCOPE_B = "local:mengshu:default:knowledge-b:default:knowledge";
// 计划点名的 typo scope：knowledge-legacy-tech-writer 中间是空格而不是连字符。
const SCOPE_TYPO = "local:mengshu:default:knowledge-legacy-tech- writer:default:knowledge";
const SPACE_A = `embedding-space:v1:${"a".repeat(64)}`;
const SPACE_B = `embedding-space:v1:${"b".repeat(64)}`;

function makeUuid(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  const chars = hash.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "89ab"[Number.parseInt(hash[16]!, 16) % 4]!;
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sourceMarkdown(body: string): string {
  return ["---", "mengshu_envelope: QUJDREVGSGFHRw==", "---", "<!-- mengshu-content-preview-bytes: 12 -->", body].join("\n");
}

interface FreezeFixture {
  readonly base: string;
  readonly run: string;
  readonly knowledgeRoot: string;
  readonly deltaRoot: string;
  readonly ids: [string, string, string];
  readonly bodies: [string, string, string];
  readonly paths: [string, string, string];
}

/**
 * 最小 freeze fixture：2 个批次（n2 + n1）、3 个 source（2 个 knowledge 树 + 1 个 delta）、
 * 2 个 canonical scope。与真实数据同构：每行 = 绝对路径 + Tab + scope_key。
 */
function buildFreezeFixture(): FreezeFixture {
  const base = mkdtempSync(join(tmpdir(), "wiki-freeze-base-"));
  const run = mkdtempSync(join(tmpdir(), "wiki-freeze-run-"));
  const knowledgeRoot = join(base, "source", "knowledge");
  const deltaRoot = join(base, "delta");
  mkdirSync(knowledgeRoot, { recursive: true });
  mkdirSync(deltaRoot, { recursive: true });
  mkdirSync(join(base, "batches"), { recursive: true });

  const ids: [string, string, string] = [makeUuid("one"), makeUuid("two"), makeUuid("three")];
  const bodies: [string, string, string] = [
    "Agent collection path scope keeps every transcript inside the workspace boundary.",
    "The retrieval fusion formula weights recency less than semantic similarity overall.",
    "Switchgear 停送电操作票必须双人复核，操作前核对设备编号与双重命名。",
  ];
  const paths: [string, string, string] = [
    join(knowledgeRoot, `${ids[0]}.md`),
    join(knowledgeRoot, `${ids[1]}.md`),
    join(deltaRoot, `${ids[2]}.md`),
  ];
  paths.forEach((path, index) => writeFileSync(path, sourceMarkdown(bodies[index]!), "utf8"));

  writeFileSync(join(base, "batches", "batch-0000-n2.txt"), [
    `${paths[0]}\t${SCOPE_A}`,
    `${paths[1]}\t${SCOPE_A}`,
  ].join("\n"), "utf8");
  writeFileSync(join(base, "batches", "batch-0001-n1.txt"), `${paths[2]}\t${SCOPE_B}\n`, "utf8");

  writeFileSync(join(base, "manifest.json"), JSON.stringify({
    files: 3, batches: 2, fullBatchSize: 2, lastBatchSize: 1, scopes: 2,
  }), "utf8");
  writeFileSync(join(base, "before-ids.txt"), `${ids.join("\n")}\n`, "utf8");
  writeFileSync(join(base, "scope-templates.json"), JSON.stringify([
    { scopeKey: SCOPE_A, embeddingSpaceId: SPACE_A, embeddingSpaceState: "known-queryable" },
    { scopeKey: SCOPE_B, embeddingSpaceId: SPACE_B, embeddingSpaceState: "known-queryable" },
  ]), "utf8");
  writeFileSync(join(base, "manifest.txt"), [
    `source=${knowledgeRoot}`,
    "files=2",
    "batchSize=2",
    "batches=1",
  ].join("\n"), "utf8");
  return { base, run, knowledgeRoot, deltaRoot, ids, bodies, paths };
}

interface AnalysisFixture extends FreezeFixture {
  readonly analysis: string;
  readonly out: string;
}

function analysisLine(
  id: string,
  path: string,
  scopeKey: string,
  excerpt: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id, path, scopeKey,
    semanticType: "rules", memoryForm: "fact", treeType: "topic",
    topic: "t", title: "T", summary: "S", evidenceNote: "", excerpt, ...extra,
  });
}

/** freeze 后在 out 下构造 analysis 目录；overrides 允许每个测试定制行。 */
async function buildAnalysisFixture(
  overrides: (fixture: FreezeFixture) => Record<string, string[]>,
): Promise<AnalysisFixture> {
  const fixture = buildFreezeFixture();
  const analysis = join(fixture.run, "old-analysis");
  const out = mkdtempSync(join(tmpdir(), "wiki-audit-out-"));
  mkdirSync(analysis, { recursive: true });
  await runFreeze(fixture.base, fixture.run, { homeDir: mkdtempSync(join(tmpdir(), "wiki-home-")) });
  const defaults: Record<string, string[]> = {
    "batch-0000-n2.txt.jsonl": [
      analysisLine(fixture.ids[0]!, fixture.paths[0]!, SCOPE_A, "keeps every transcript"),
      analysisLine(fixture.ids[1]!, fixture.paths[1]!, SCOPE_A, "weights recency less than"),
    ],
    "batch-0001-n1.txt.jsonl": [
      analysisLine(fixture.ids[2]!, fixture.paths[2]!, SCOPE_B, "停送电操作票必须双人复核"),
    ],
  };
  const files = overrides(fixture);
  for (const [name, lines] of Object.entries({ ...defaults, ...files })) {
    writeFileSync(join(analysis, name), lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  }
  return { ...fixture, analysis, out };
}

function manifestEntryFromLine(line: string): SourceManifestEntry {
  return JSON.parse(line) as SourceManifestEntry;
}

async function frozenManifest(fixture: FreezeFixture): Promise<Map<string, SourceManifestEntry>> {
  const lines = readFileSync(join(fixture.run, "source-manifest.jsonl"), "utf8").split("\n").filter(Boolean);
  return new Map(lines.map((line) => {
    const entry = manifestEntryFromLine(line);
    return [entry.id, entry];
  }));
}

function pageMarkdown(scopeKey: string, body: string, overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    scope_key: scopeKey,
    semantic_type: "resource",
    memory_form: "semantic",
    tree_type: "topic",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "---",
    body,
  ].join("\n");
}

function writeConfig(tmp: string): string {
  const path = join(tmp, "config.json");
  writeFileSync(path, JSON.stringify({
    embedding: { apiKey: "sk-TEST-SECRET-KEY", baseURL: "https://embedding.example.test/v1", model: "BAAI/bge-m3" },
    postgres: { host: "db.example.test", port: 5432, database: "mengshu", user: "pguser", password: "pgpass-SECRET" },
  }), "utf8");
  return path;
}

function writeTemplates(path: string): void {
  writeFileSync(path, JSON.stringify([
    { scopeKey: SCOPE_A, embeddingSpaceId: SPACE_A, embeddingSpaceState: "known-queryable" },
    { scopeKey: SCOPE_B, embeddingSpaceId: SPACE_B, embeddingSpaceState: "known-queryable" },
  ]), "utf8");
}

describe("wiki knowledge replace gates", () => {
  test("reads the workset body and ignores the envelope", () => {
    const markdown = [
      "---",
      "mengshu_envelope: abcdef",
      "---",
      "<!-- mengshu-content-preview-bytes: 12 -->",
      "这是一段知识正文，用来校验摘录。",
    ].join("\n");
    expect(extractWorksetBody(markdown)).toBe("这是一段知识正文，用来校验摘录。");
    expect(excerptMatches(extractWorksetBody(markdown), "一段知识正文，用来校验摘录")).toBe(true);
    expect(excerptMatches(extractWorksetBody(markdown), "abcdef")).toBe(false);
    expect(excerptMatches(extractWorksetBody(markdown), "这是一段知识正文")).toBe(false); // <12 字符的摘录对长正文无效
  });

  test("空/超短正文的摘录必须与全文逐字相等", () => {
    expect(excerptMatches("", "")).toBe(true);
    expect(excerptMatches("", "有内容")).toBe(false);
    expect(excerptMatches("## ✅ 优化完成", "## ✅ 优化完成")).toBe(true);
    expect(excerptMatches("## ✅ 优化完成", "优化完成")).toBe(false);
    expect(excerptMatches("## ✅ 优化完成", "## ✅ 优化完成\n\n凑长度的尾巴")).toBe(false);
  });

  test("requires every source id once", () => {
    const report = coverageReport(
      ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      [
        { id: "11111111-1111-4111-8111-111111111111", scopeKey: "s", excerpt: "知识正文", path: "/a.md" },
        { id: "11111111-1111-4111-8111-111111111111", scopeKey: "s", excerpt: "知识正文", path: "/a.md" },
      ],
    );
    expect(report.missing).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(report.duplicate).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  test("keeps protocol fields from frontmatter when the body repeats them", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-page-"));
    const page = join(dir, "page.md");
    const id = "11111111-1111-4111-8111-111111111111";
    writeFileSync(page, [
      "---",
      "scope_key: local:mengshu:default:project:default:knowledge",
      "semantic_type: resource",
      "memory_form: semantic",
      "tree_type: topic",
      "---",
      "这是一段足够长的知识正文，用来通过页面长度校验。",
      "semantic_type: profile",
    ].join("\n"));
    writeFileSync(page.replace(/\.md$/, ".sources"), `${id}\n`);
    const parsed = parseWikiPage(page, readFileSync(page, "utf8"));
    expect(parsed.semanticType).toBe("resource");
    expect(parsed.treeType).toBe("topic");
    expect(parsed.sourceIds).toEqual([id]);
  });

  test("parseBatchFileName accepts real batch names and rejects everything else", () => {
    expect(parseBatchFileName("batch-0336-n60.txt")).toEqual({ index: 336, expected: 60 });
    expect(parseBatchFileName("batch-0825-n9.txt")).toEqual({ index: 825, expected: 9 });
    expect(parseBatchFileName("batch-0336-n60.txt.jsonl")).toBeNull();
    expect(parseBatchFileName("notes.txt")).toBeNull();
  });

  test("resolveEmbeddingDims refuses defaults without a source and rejects conflicts", () => {
    const resolved = resolveEmbeddingDims({ registry: { dims: 1024 }, configModel: "BAAI/bge-m3" });
    expect(resolved.dims).toBe(1024);
    expect(resolved.source).toBe("postgres:mengshu_active_embedding_space.dimensions");
    expect(resolved.candidates).toHaveLength(2);
    const configOnly = resolveEmbeddingDims({ registry: null, configModel: "BAAI/bge-m3" });
    expect(configOnly.dims).toBe(1024);
    expect(configOnly.source).toBe("config:vectorDimsForModel(model=BAAI/bge-m3)");
    expect(() => resolveEmbeddingDims({ registry: { dims: 1536 }, configModel: "BAAI/bge-m3" }))
      .toThrow(/embedding dims conflict/);
    expect(() => resolveEmbeddingDims({ registry: null, configModel: "no-such-model" }))
      .toThrow(/could not be sourced/);
  });

  test("buildInputsDiff reports the manifest.txt vs manifest.json differences", () => {
    const diff = buildInputsDiff(
      { source: "/k/root", files: "47963", batchSize: "25", batches: "1919" },
      { files: 49509, batches: 826, fullBatchSize: 60, lastBatchSize: 9, scopes: 21 },
    );
    const fields = Object.fromEntries(diff.differences.map((item) => [item.field, item]));
    expect(fields.files).toMatchObject({ manifestTxt: 47963, manifestJson: 49509 });
    expect(fields.batches).toMatchObject({ manifestTxt: 1919, manifestJson: 826 });
    expect(fields.batchSize).toMatchObject({ manifestTxt: 25, manifestJson: 60 });
    expect(fields.source).toMatchObject({ manifestTxt: "/k/root", manifestJson: null });
  });

  test("evaluateKnownIssues verifies the plan-named defects against observations", () => {
    const batchName = (n: number): string => `batch-${n.toString().padStart(4, "0")}-n60.txt`;
    const batches: string[] = [];
    for (let n = 439; n <= 825; n += 1) batches.push(batchName(n));
    const batchValid = new Map<string, number>(batches.map((name) => [name, 60]));
    batchValid.set(batchName(440), 0);
    for (let n = 448; n <= 825; n += 1) batchValid.set(batchName(n), 0);
    const issues = evaluateKnownIssues({
      malformedLines: [{ file: "/old/analysis/batch-0336-n60.txt.jsonl", line: 55 }],
      batchValid,
      expectedBatches: batches,
      excerptMisses: 1119,
      unknownScopeRecords: 1,
      nonCanonicalScopes: [SCOPE_TYPO],
      distinctAnalysisScopes: 22,
      templateScopeCount: 21,
    });
    expect(issues.batch0336ConcatenatedJson.confirmed).toBe(true);
    expect(issues.missingBatches.confirmed).toBe(true);
    expect(issues.missingBatches.claimedCount).toBe(379);
    expect(issues.missingBatches.actualMissingBatchNumbers).toEqual([440, ...Array.from({ length: 825 - 448 + 1 }, (_, i) => 448 + i)]);
    expect(issues.excerptMisses).toMatchObject({ claimedApprox: 1117, confirmed: true, actual: 1119 });
    expect(issues.scopeTypo.confirmed).toBe(true);
    expect(issues.scopeTypo.nonCanonicalScopes).toEqual([SCOPE_TYPO]);
    expect(issues.scopeCountMismatch).toMatchObject({ confirmed: true, analysisScopes: 22, templateScopes: 21 });
    batchValid.set(batchName(500), 60);
    const healed = evaluateKnownIssues({
      malformedLines: [], batchValid, expectedBatches: batches, excerptMisses: 0,
      unknownScopeRecords: 0, nonCanonicalScopes: [], distinctAnalysisScopes: 21, templateScopeCount: 21,
    });
    expect(healed.missingBatches.confirmed).toBe(false);
    expect(healed.batch0336ConcatenatedJson.confirmed).toBe(false);
  });

  test("auditRecordReason and mergeRecordError expose the deciding reason", () => {
    const manifest = new Map<string, SourceManifestEntry>([
      ["11111111-1111-4111-8111-111111111111", {
        id: "11111111-1111-4111-8111-111111111111", path: "/k/a.md", sourceRoot: "/k",
        scopeKey: SCOPE_A, bytes: 1, sha256: "0".repeat(64), batchFile: "batch-0000-n60.txt",
      }],
    ]);
    const ctx = {
      canonicalScopes: new Set([SCOPE_A, SCOPE_B]),
      beforeIds: new Set(["11111111-1111-4111-8111-111111111111"]),
      manifest,
      analysisBatchFile: "batch-0000-n60.txt",
    };
    const base = {
      id: "11111111-1111-4111-8111-111111111111", path: "/k/a.md", scopeKey: SCOPE_A,
      semanticType: "rules", memoryForm: "fact", treeType: "topic", excerpt: "a long enough excerpt",
    };
    expect(auditRecordReason(base, ctx)).toBeNull();
    expect(auditRecordReason({ ...base, scopeKey: SCOPE_TYPO }, ctx)).toBe("unknown-scope");
    expect(auditRecordReason({ ...base, scopeKey: SCOPE_B }, ctx)).toBe("scope-mismatch");
    expect(auditRecordReason({ ...base, treeType: "none" }, ctx)).toBeNull(); // 读取阶段允许 none
    expect(auditRecordReason({ ...base, excerpt: "too short" }, ctx)).toBeNull(); // 摘录长度由正文感知的 excerptMatches 裁决
    expect(auditRecordReason({ ...base, excerpt: "" }, ctx)).toBeNull(); // 空正文记录的摘录就是空串
    const entry = manifest.get("11111111-1111-4111-8111-111111111111")!;
    const merged = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...base, sourceSha256: "0".repeat(64), batchFile: "batch-0000-n60.txt", ...extra,
    });
    expect(mergeRecordError(merged(), entry)).toBeNull();
    expect(mergeRecordError(merged({ sourceSha256: "1".repeat(64) }), entry)).toBe("source-hash-drift");
    expect(mergeRecordError(merged({ scopeKey: SCOPE_B }), entry)).toBe("cross-scope-record");
    // merge 现在同样复核协议枚举与摘录质量（回读由 runMerge 重读补充）。
    expect(mergeRecordError(merged({ semanticType: "spam" }), entry)).toBe("semantic-type");
    expect(mergeRecordError(merged({ memoryForm: "vibe" }), entry)).toBe("memory-form");
    expect(mergeRecordError(merged({ treeType: "L3" }), entry)).toBe("tree-type");
    expect(mergeRecordError(merged({ excerpt: 42 }), entry)).toBe("invalid-excerpt");
    expect(mergeRecordError(merged({ excerpt: "too short" }), entry)).toBeNull(); // 长度由 excerptMatches 正文回读裁决
  });

  test("detectContentHashConflicts flags only cross-scope duplicates", () => {
    const hash = "f".repeat(64);
    const conflicts = detectContentHashConflicts([
      { textHash: hash, scopeKey: SCOPE_A, page: "page-001.md" },
      { textHash: hash, scopeKey: SCOPE_A, page: "page-002.md" },
      { textHash: hash, scopeKey: SCOPE_B, page: "page-003.md" },
      { textHash: "0".repeat(64), scopeKey: SCOPE_B, page: "page-004.md" },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ textHash: hash, scopes: [SCOPE_A, SCOPE_B] });
  });

  test("dedupeWikiPages merges sourceIds so dropped pages keep provenance", () => {
    const page = (scopeKey: string, text: string, sourceIds: string[]): WikiPage => ({
      path: `/w/${scopeKey}-${sourceIds[0]}.md`,
      scopeKey,
      text,
      semanticType: "rules",
      memoryForm: "fact",
      treeType: "topic",
      sourceIds,
    });
    const s1 = makeUuid("dup-s1");
    const s2 = makeUuid("dup-s2");
    const s3 = makeUuid("dup-s3");
    const a1 = page(SCOPE_A, "identical fused body", [s1]);
    const a2 = page(SCOPE_A, "identical fused body", [s2]);
    const b = page(SCOPE_B, "identical fused body", [s3]);
    const deduped = dedupeWikiPages([a1, a2, b]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.path).toBe(a1.path);
    expect(deduped[0]!.sourceIds).toEqual([s1, s2]);
    expect(deduped[1]!.scopeKey).toBe(SCOPE_B);
    expect(deduped[1]!.sourceIds).toEqual([s3]);
    // 重复出现的 source id 不重复进入集合。
    expect(dedupeWikiPages([a1, { ...a1, sourceIds: [s1, s1] }])).toHaveLength(1);
    expect(dedupeWikiPages([a1, { ...a1, sourceIds: [s1, s1] }])[0]!.sourceIds).toEqual([s1]);
  });

  test("claimPathViolation enforces containment and frozen manifest path equality", () => {
    const id = makeUuid("cp");
    const entry: SourceManifestEntry = {
      id, path: "/k/dir/file.md", sourceRoot: "/k", scopeKey: SCOPE_A,
      bytes: 1, sha256: "0".repeat(64), batchFile: "batch-0000-n60.txt",
    };
    const manifest = new Map([[id, entry]]);
    const claim = (path: string): AnalysisRecord => ({ id, scopeKey: SCOPE_A, excerpt: "excerpt text here", path });
    expect(claimPathViolation(claim("/k/dir/file.md"), manifest)).toBeNull();
    expect(claimPathViolation(claim("/k/dir/file.md"), null)).toBeNull();
    expect(claimPathViolation(claim("k/dir/file.md"), null)).toBe("path-not-absolute");
    expect(claimPathViolation(claim("/k/../dir/file.md"), null)).toBe("path-escape");
    expect(claimPathViolation(claim("/k/./dir/file.md"), null)).toBe("path-escape");
    expect(claimPathViolation(claim("/etc/passwd"), manifest)).toBe("path-mismatch");
    expect(claimPathViolation(claim("/k/dir/file.md"), new Map<string, SourceManifestEntry>())).toBe("unknown-id");
  });

  test("embeddingSpaceQueryFallback only tolerates a missing registry table", () => {
    expect(embeddingSpaceQueryFallback(Object.assign(new Error("relation does not exist"), { code: "42P01" }))).toBe("no-registry");
    expect(embeddingSpaceQueryFallback(Object.assign(new Error("permission denied for table"), { code: "42501" }))).toBe("rethrow");
    expect(embeddingSpaceQueryFallback(new Error("connection terminated unexpectedly"))).toBe("rethrow");
    expect(embeddingSpaceQueryFallback("boom")).toBe("rethrow");
    expect(embeddingSpaceQueryFallback(null)).toBe("rethrow");
  });
});

describe("freeze", () => {
  test("freezes inputs, hashes, source manifest, diff and evidence receipts", async () => {
    const home = mkdtempSync(join(tmpdir(), "wiki-home-"));
    const fixture = buildFreezeFixture();
    const summary = await runFreeze(fixture.base, fixture.run, { homeDir: home });
    expect(summary).toEqual({ manifestFiles: 3, beforeIds: 3, uniqueBeforeIds: 3, batches: 2 });
    for (const subdir of ["read", "merged", "by-scope", "wiki/final", "receipts", "failures"]) {
      expect(existsSync(join(fixture.run, subdir))).toBe(true);
    }
    const shaLines = readFileSync(join(fixture.run, "input-sha256.txt"), "utf8").trim().split("\n");
    expect(shaLines).toHaveLength(3);
    for (const line of shaLines) {
      expect(line).toMatch(/^[0-9a-f]{64}  (manifest\.json|before-ids\.txt|scope-templates\.json)$/);
    }
    const manifestLines = readFileSync(join(fixture.run, "source-manifest.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(manifestLines).toHaveLength(3);
    const first = manifestEntryFromLine(manifestLines[0]!);
    expect(first.id).toBe(fixture.ids[0]);
    expect(first.path).toBe(fixture.paths[0]);
    expect(first.sourceRoot).toBe(fixture.knowledgeRoot);
    expect(first.scopeKey).toBe(SCOPE_A);
    expect(first.bytes).toBe(Buffer.byteLength(sourceMarkdown(fixture.bodies[0]!), "utf8"));
    expect(first.sha256).toBe(sha256(readFileSync(fixture.paths[0]!)));
    expect(manifestEntryFromLine(manifestLines[2]!).sourceRoot).toBe(fixture.deltaRoot);
    const diff = JSON.parse(readFileSync(join(fixture.run, "receipts", "inputs-diff.json"), "utf8")) as {
      differences: Array<{ field: string }>; sourceRoots: { deltaRoot: string };
    };
    expect(diff.differences.some((item) => item.field === "files")).toBe(true);
    expect(diff.sourceRoots.deltaRoot).toBe(fixture.deltaRoot);
    const evidence = JSON.parse(readFileSync(join(fixture.run, "receipts", "old-run-evidence.json"), "utf8")) as { status: string };
    expect(evidence.status).toBe("not-found");
  });

  test("locates old-run evidence under ~/.grok when it exists", () => {
    const home = mkdtempSync(join(tmpdir(), "wiki-home-"));
    mkdirSync(join(home, ".grok", "sessions", "wf_01a10234494d711087a165cd94916fca"), { recursive: true });
    writeFileSync(join(home, ".grok", "sessions", "wf_01a10234494d711087a165cd94916fca", "state.json"), "{}", "utf8");
    const evidence = searchOldRunEvidence(home, "wf_01a10234494d711087a165cd94916fca");
    expect(evidence.status).toBe("found");
    expect(evidence.evidencePaths[0]).toContain("wf_01a10234494d711087a165cd94916fca");
  });

  test("rejects a source path outside both declared roots", async () => {
    const fixture = buildFreezeFixture();
    const evil = join(fixture.base, "elsewhere", `${makeUuid("evil")}.md`);
    writeFileSync(join(fixture.base, "batches", "batch-0001-n1.txt"), `${evil}\t${SCOPE_B}\n`, "utf8");
    writeFileSync(join(fixture.base, "before-ids.txt"), `${[fixture.ids[0], fixture.ids[1], makeUuid("evil")].join("\n")}\n`, "utf8");
    await expect(runFreeze(fixture.base, fixture.run, { homeDir: mkdtempSync(join(tmpdir(), "h-")) }))
      .rejects.toThrow(/outside both declared source roots/);
  });

  test("rejects symlinked source files", async () => {
    const fixture = buildFreezeFixture();
    rmSync(fixture.paths[1]!);
    symlinkSync(fixture.paths[0]!, fixture.paths[1]!);
    await expect(runFreeze(fixture.base, fixture.run, { homeDir: mkdtempSync(join(tmpdir(), "h-")) }))
      .rejects.toThrow(/source is a symlink/);
  });

  test("rejects a source reached through a symlinked directory inside the knowledge root", async () => {
    const fixture = buildFreezeFixture();
    const outside = mkdtempSync(join(tmpdir(), "wiki-outside-"));
    const id = makeUuid("linked");
    writeFileSync(
      join(outside, `${id}.md`),
      sourceMarkdown("A body that physically lives outside the declared knowledge root but is reachable via a symlinked directory."),
      "utf8",
    );
    // knowledgeRoot/linked -> outside：词法上在声明根内，lstat 最终组件也是普通文件。
    symlinkSync(outside, join(fixture.knowledgeRoot, "linked"));
    const linkedPath = join(fixture.knowledgeRoot, "linked", `${id}.md`);
    writeFileSync(join(fixture.base, "batches", "batch-0001-n1.txt"), `${linkedPath}\t${SCOPE_B}\n`, "utf8");
    writeFileSync(join(fixture.base, "before-ids.txt"), `${[fixture.ids[0], fixture.ids[1], id].join("\n")}\n`, "utf8");
    await expect(runFreeze(fixture.base, fixture.run, { homeDir: mkdtempSync(join(tmpdir(), "h-")) }))
      .rejects.toThrow(/symlink directory inside the declared root/);
  });

  test("rejects duplicate ids and batch line counts that contradict the batch name", async () => {
    const duplicate = buildFreezeFixture();
    writeFileSync(join(duplicate.base, "batches", "batch-0001-n1.txt"), `${duplicate.paths[0]}\t${SCOPE_B}\n`, "utf8");
    await expect(runFreeze(duplicate.base, duplicate.run, { homeDir: mkdtempSync(join(tmpdir(), "h-")) }))
      .rejects.toThrow(/duplicate id/);

    const miscount = buildFreezeFixture();
    writeFileSync(join(miscount.base, "batches", "batch-0001-n1.txt"), [
      `${miscount.paths[2]}\t${SCOPE_B}`,
      `${miscount.paths[0]}\t${SCOPE_B}`,
    ].join("\n"), "utf8");
    await expect(runFreeze(miscount.base, miscount.run, { homeDir: mkdtempSync(join(tmpdir(), "h-")) }))
      .rejects.toThrow(/lines != declared/);
  });

  test("rejects before-ids that disagree with batch ids", async () => {
    const fixture = buildFreezeFixture();
    writeFileSync(join(fixture.base, "before-ids.txt"), `${[fixture.ids[0], fixture.ids[1], makeUuid("intruder")].join("\n")}\n`, "utf8");
    await expect(runFreeze(fixture.base, fixture.run, { homeDir: mkdtempSync(join(tmpdir(), "h-")) }))
      .rejects.toThrow(/before-ids and batch ids differ/);
  });
});

describe("audit", () => {
  test("keeps valid records and registers a batch-0336-style concatenated line only for that line", async () => {
    const fixture = await buildAnalysisFixture((f) => ({
      "batch-0000-n2.txt.jsonl": [
        analysisLine(f.ids[0]!, f.paths[0]!, SCOPE_A, "keeps every transcript"),
        `${analysisLine(f.ids[1]!, f.paths[1]!, SCOPE_A, "weights recency less than")}${analysisLine(f.ids[1]!, f.paths[1]!, SCOPE_A, "semantic similarity overall")}`,
      ],
    }));
    const summary = await runAudit(fixture.analysis, join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    expect(summary).toMatchObject({ files: 2, claims: 3, valid: 2, invalid: 1, missingIds: 1 });
    const retry = readFileSync(join(fixture.out, "failures", "retry-records.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { reason: string; file: string; line: number });
    expect(retry[0]).toMatchObject({ reason: "malformed-json", line: 2 });
    expect(retry[0]!.file).toContain("batch-0000-n2.txt.jsonl");
    const reused = readFileSync(join(fixture.out, "read", "reused.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(reused).toHaveLength(2);
    expect((JSON.parse(reused[0]!) as { sourceSha256: string }).sourceSha256).toBe(sha256(readFileSync(fixture.paths[0]!)));
    const report = JSON.parse(readFileSync(join(fixture.out, "read", "audit-summary.json"), "utf8")) as {
      reasons: Record<string, number>; knownIssues: { excerptMisses: { actual: number } };
    };
    expect(report.reasons["malformed-json"]).toBe(1);
  });

  test("rejects preview markers and frontmatter posing as excerpts", async () => {
    const fixture = await buildAnalysisFixture((f) => ({
      "batch-0000-n2.txt.jsonl": [
        analysisLine(f.ids[0]!, f.paths[0]!, SCOPE_A, "mengshu-content-preview-bytes: 12"),
        analysisLine(f.ids[1]!, f.paths[1]!, SCOPE_A, "mengshu_envelope: QUJDREVGSGFHRw=="),
      ],
    }));
    const summary = await runAudit(fixture.analysis, join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    // 两条 excerpt 伪装都被打回；batch-0001 的默认记录保持有效。
    expect(summary).toMatchObject({ valid: 1, invalid: 2, missingIds: 2 });
    const report = JSON.parse(readFileSync(join(fixture.out, "read", "audit-summary.json"), "utf8")) as { reasons: Record<string, number> };
    expect(report.reasons["excerpt-miss"]).toBe(2);
  });

  test("rejects the knowledge-legacy-tech- writer scope typo", async () => {
    const fixture = await buildAnalysisFixture((f) => ({
      "batch-0000-n2.txt.jsonl": [
        analysisLine(f.ids[0]!, f.paths[0]!, SCOPE_TYPO, "keeps every transcript"),
        analysisLine(f.ids[1]!, f.paths[1]!, SCOPE_A, "weights recency less than"),
      ],
    }));
    await runAudit(fixture.analysis, join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    const report = JSON.parse(readFileSync(join(fixture.out, "read", "audit-summary.json"), "utf8")) as {
      reasons: Record<string, number>;
      knownIssues: { scopeTypo: { confirmed: boolean; nonCanonicalScopes: string[] } };
    };
    expect(report.reasons["unknown-scope"]).toBe(1);
    expect(report.knownIssues.scopeTypo.confirmed).toBe(true);
    expect(report.knownIssues.scopeTypo.nonCanonicalScopes).toEqual([SCOPE_TYPO]);
  });

  test("rejects short excerpts, bad enums, batch misattribution and source hash drift", async () => {
    const fixture = await buildAnalysisFixture((f) => ({
      "batch-0000-n2.txt.jsonl": [
        analysisLine(f.ids[0]!, f.paths[0]!, SCOPE_A, "too short!"), // 10 chars
        analysisLine(f.ids[1]!, f.paths[1]!, SCOPE_A, "weights recency less than", { semanticType: "spam" }),
      ],
      "batch-0001-n1.txt.jsonl": [
        analysisLine(f.ids[2]!, f.paths[2]!, SCOPE_B, "停送电操作票必须双人复核", { treeType: "none" }),
      ],
    }));
    // hash drift：冻结后改写第三个 source。
    writeFileSync(fixture.paths[2]!, sourceMarkdown("Switchgear 停送电操作票必须双人复核，正文被篡改用于 hash drift。"), "utf8");
    const summary = await runAudit(fixture.analysis, join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    expect(summary).toMatchObject({ valid: 0, invalid: 3, missingIds: 3 });
    const report = JSON.parse(readFileSync(join(fixture.out, "read", "audit-summary.json"), "utf8")) as { reasons: Record<string, number> };
    expect(report.reasons["excerpt-miss"]).toBe(1); // 10 字符摘录对长正文不再单独记 short-excerpt
    expect(report.reasons["semantic-type"]).toBe(1);
    expect(report.reasons["source-hash-drift"]).toBe(1);
  });

  test("reports a batch that asked for more records than it got, and dedupes by first valid record", async () => {
    const fixture = await buildAnalysisFixture((f) => ({
      // batch-0000 请求 2 条但第 2 条是别批次的记录（batch-mismatch）→ 有效 1 < 2。
      "batch-0000-n2.txt.jsonl": [
        analysisLine(f.ids[0]!, f.paths[0]!, SCOPE_A, "keeps every transcript"),
        analysisLine(f.ids[2]!, f.paths[2]!, SCOPE_B, "停送电操作票必须双人复核"),
      ],
      // 同 id 第二条完整有效记录在正确批次文件里重复出现 → duplicate-id（首个有效者保留）。
      "batch-0001-n1.txt.jsonl": [
        analysisLine(f.ids[2]!, f.paths[2]!, SCOPE_B, "停送电操作票必须双人复核"),
        analysisLine(f.ids[2]!, f.paths[2]!, SCOPE_B, "停送电操作票必须双人复核"),
      ],
    }));
    const summary = await runAudit(fixture.analysis, join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    expect(summary).toMatchObject({ claims: 4, valid: 2, invalid: 2, missingIds: 1, retryBatches: 1 });
    const retryBatches = readFileSync(join(fixture.out, "failures", "retry-batches.txt"), "utf8").trim().split("\n");
    expect(retryBatches).toEqual(["batch-0000-n2.txt\tvalid=1\texpected=2"]);
    const retry = readFileSync(join(fixture.out, "failures", "retry-records.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { reason: string });
    expect(retry.map((item) => item.reason).sort()).toEqual(["batch-mismatch", "duplicate-id"]);
  });

  test("audits merged-style files via the record batchFile field and rejects batch drift", async () => {
    const fixture = await buildAnalysisFixture(() => ({}));
    const manifest = await frozenManifest(fixture);
    const excerpts: Record<string, string> = {
      [fixture.ids[0]!]: "keeps every transcript",
      [fixture.ids[1]!]: "weights recency less than",
      [fixture.ids[2]!]: "停送电操作票必须双人复核",
    };
    const line = (id: string, batchFile: string): string => JSON.stringify({
      id,
      path: manifest.get(id)!.path,
      scopeKey: manifest.get(id)!.scopeKey,
      semanticType: "rules", memoryForm: "fact", treeType: "topic",
      topic: "t", title: "T", summary: "S", evidenceNote: "",
      excerpt: excerpts[id],
      sourceSha256: manifest.get(id)!.sha256,
      batchFile,
    });
    // merged.jsonl 不是 batch 命名文件：audit 信任记录自带 batchFile，但仍要求与冻结 manifest 一致。
    const mergedDir = join(fixture.run, "merged-style");
    mkdirSync(mergedDir, { recursive: true });
    writeFileSync(join(mergedDir, "merged.jsonl"), [
      line(fixture.ids[0]!, manifest.get(fixture.ids[0]!)!.batchFile),
      line(fixture.ids[2]!, "batch-0000-n2.txt"),
    ].join("\n") + "\n", "utf8");
    const summary = await runAudit(mergedDir, join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    expect(summary).toMatchObject({ claims: 2, valid: 1, invalid: 1 });
    const report = JSON.parse(readFileSync(join(fixture.out, "read", "audit-summary.json"), "utf8")) as { reasons: Record<string, number> };
    expect(report.reasons["batch-mismatch"]).toBe(1);
  });

  test("audit rejects a source reached through a symlinked directory", async () => {
    const fixture = await buildAnalysisFixture(() => ({}));
    const manifest = await frozenManifest(fixture);
    const outside = mkdtempSync(join(tmpdir(), "wiki-outside-"));
    const id = fixture.ids[2]!;
    // 与冻结时同字节的内容：hash 校验通过，问题只在路径穿过符号链接目录。
    writeFileSync(join(outside, `${id}.md`), readFileSync(fixture.paths[2]!), "utf8");
    symlinkSync(outside, join(fixture.knowledgeRoot, "linked"));
    const linkedPath = join(fixture.knowledgeRoot, "linked", `${id}.md`);
    const manifestPath = join(fixture.run, "manifest-linked.jsonl");
    writeFileSync(
      manifestPath,
      `${[...manifest.values()].map((entry) => JSON.stringify(
        entry.id === id ? { ...entry, path: linkedPath, sourceRoot: fixture.knowledgeRoot } : entry,
      )).join("\n")}\n`,
      "utf8",
    );
    const analysisDir = join(fixture.run, "linked-analysis");
    mkdirSync(analysisDir, { recursive: true });
    writeFileSync(
      join(analysisDir, "batch-0001-n1.txt.jsonl"),
      `${analysisLine(id, linkedPath, SCOPE_B, "停送电操作票必须双人复核")}\n`,
      "utf8",
    );
    const summary = await runAudit(analysisDir, manifestPath, join(fixture.base, "before-ids.txt"), join(fixture.base, "scope-templates.json"), fixture.out);
    expect(summary.valid).toBe(0);
    expect(summary.invalid).toBe(1);
    const retry = readFileSync(join(fixture.out, "failures", "retry-records.jsonl"), "utf8");
    expect(retry).toContain("source-read-failed");
    expect(retry).toContain("symlink directory inside the declared root");
  });
});

describe("merge", () => {
  async function mergeFixture() {
    const fixture = await buildAnalysisFixture(() => ({}));
    const manifest = await frozenManifest(fixture);
    // merge 现在会重读源文件复核 hash 与 excerpt 回读，摘录必须逐 id 与正文匹配。
    const excerpts: Record<string, string> = {
      [fixture.ids[0]!]: "keeps every transcript",
      [fixture.ids[1]!]: "weights recency less than",
      [fixture.ids[2]!]: "停送电操作票必须双人复核",
    };
    const record = (id: string): Record<string, unknown> => {
      const entry = manifest.get(id)!;
      return {
        id: entry.id, path: entry.path, scopeKey: entry.scopeKey,
        semanticType: "rules", memoryForm: "fact", treeType: "topic",
        topic: "t", title: "T", summary: "S", evidenceNote: "",
        excerpt: excerpts[id],
        sourceSha256: entry.sha256, batchFile: entry.batchFile,
      };
    };
    const inputA = join(fixture.run, "input-a.jsonl");
    const inputB = join(fixture.run, "input-b.jsonl");
    writeFileSync(inputA, [record(fixture.ids[1]!), record(fixture.ids[0]!)].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    writeFileSync(inputB, `${JSON.stringify(record(fixture.ids[2]!))}\n`, "utf8");
    return { fixture, manifest, record, inputA, inputB };
  }

  test("combines inputs sorted by id and records the merged manifest hash", async () => {
    const { fixture, inputA, inputB } = await mergeFixture();
    const out = mkdtempSync(join(tmpdir(), "wiki-merge-"));
    const summary = await runMerge([inputA, inputB], join(fixture.run, "source-manifest.jsonl"), join(fixture.base, "before-ids.txt"), out);
    expect(summary.records).toBe(3);
    expect(summary.inputs).toBe(2);
    const merged = readFileSync(join(out, "merged", "analysis", "merged.jsonl"), "utf8");
    expect(merged.endsWith("\n")).toBe(true);
    const ids = merged.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
    expect(summary.mergedManifestHash).toBe(sha256(merged));
    const mergedManifest = JSON.parse(readFileSync(join(out, "merged", "manifest.json"), "utf8")) as { records: number; mergedManifestHash: string };
    expect(mergedManifest).toMatchObject({ records: 3, mergedManifestHash: summary.mergedManifestHash });
  });

  test("rejects duplicate ids, unknown ids, cross-scope records and hash drift", async () => {
    const { fixture, record, inputA, inputB } = await mergeFixture();
    const manifestPath = join(fixture.run, "source-manifest.jsonl");
    const beforePath = join(fixture.base, "before-ids.txt");
    const out = mkdtempSync(join(tmpdir(), "wiki-merge-"));

    const duplicate = join(fixture.run, "dup.jsonl");
    writeFileSync(duplicate, `${JSON.stringify(record(fixture.ids[2]!))}\n`, "utf8");
    await expect(runMerge([inputB, duplicate], manifestPath, beforePath, out)).rejects.toThrow(/duplicate id/);

    const unknown = join(fixture.run, "unknown.jsonl");
    const alien = { ...record(fixture.ids[2]!), id: makeUuid("alien") };
    writeFileSync(unknown, `${JSON.stringify(alien)}\n`, "utf8");
    await expect(runMerge([unknown], manifestPath, beforePath, out)).rejects.toThrow(/unknown id/);

    const crossScope = join(fixture.run, "cross.jsonl");
    const drifted = record(fixture.ids[2]!) as Record<string, unknown>;
    writeFileSync(crossScope, `${JSON.stringify({ ...drifted, scopeKey: SCOPE_A })}\n`, "utf8");
    await expect(runMerge([crossScope], manifestPath, beforePath, out)).rejects.toThrow(/cross-scope-record/);

    const driftedHash = join(fixture.run, "drift.jsonl");
    writeFileSync(driftedHash, `${JSON.stringify({ ...drifted, sourceSha256: "9".repeat(64) })}\n`, "utf8");
    await expect(runMerge([driftedHash], manifestPath, beforePath, out)).rejects.toThrow(/source-hash-drift/);

    expect(existsSync(join(out, "merged", "analysis", "merged.jsonl"))).toBe(false);
  });

  test("re-reads frozen sources and rejects real hash drift, excerpt misses and bad enums", async () => {
    const { fixture, record, inputA } = await mergeFixture();
    const manifestPath = join(fixture.run, "source-manifest.jsonl");
    const beforePath = join(fixture.base, "before-ids.txt");
    const out = mkdtempSync(join(tmpdir(), "wiki-merge-"));

    // 冻结后源文件被改写：记录声明的 sourceSha256 仍等于冻结值，重读才能发现真实漂移。
    writeFileSync(
      fixture.paths[0]!,
      sourceMarkdown("Agent collection path scope keeps every transcript inside the workspace boundary, but mutated after freeze."),
      "utf8",
    );
    await expect(runMerge([inputA], manifestPath, beforePath, out)).rejects.toThrow(/source-hash-drift/);

    // 恢复字节相同的内容后，声明一个无法在正文中回读的摘录。
    writeFileSync(fixture.paths[0]!, sourceMarkdown(fixture.bodies[0]!), "utf8");
    const badExcerpt = join(fixture.run, "bad-excerpt.jsonl");
    writeFileSync(badExcerpt, `${JSON.stringify({ ...record(fixture.ids[0]!), excerpt: "this sentence is not in the body" })}\n`, "utf8");
    await expect(runMerge([badExcerpt], manifestPath, beforePath, out)).rejects.toThrow(/excerpt-miss/);

    // 枚举坏值（treeType 不在白名单）在纯校验层被拒，进不了 merged.jsonl。
    const badEnum = join(fixture.run, "bad-enum.jsonl");
    writeFileSync(badEnum, `${JSON.stringify({ ...record(fixture.ids[0]!), treeType: "L3" })}\n`, "utf8");
    await expect(runMerge([badEnum], manifestPath, beforePath, out)).rejects.toThrow(/tree-type/);

    // 健康输入仍能通过重读复核。
    const healthy = await runMerge([inputA], manifestPath, beforePath, out);
    expect(healthy.records).toBe(2);
  });
});

describe("preflight", () => {
  function buildWikiFixture(options: {
    readonly pages?: Array<{ part: string; page: string; scopeKey: string; body: string; sources: string[]; extra?: Record<string, string> }>;
    readonly analysisRecords?: Array<{ id: string; scopeKey: string }>;
    readonly beforeIds?: string[];
    readonly injectRootFiles?: string[];
    readonly symlinkPage?: { part: string; page: string; target: string };
    readonly dropSources?: boolean;
  } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), "wiki-preflight-"));
    const wikiRoot = join(tmp, "wiki", "final");
    const id1 = makeUuid("p1");
    const id2 = makeUuid("p2");
    const id3 = makeUuid("p3");
    const pages = options.pages ?? [
      { part: "part-001", page: "page-001", scopeKey: SCOPE_A, body: "Agent collection path scope keeps every transcript inside the workspace boundary.", sources: [id1, id2] },
    ];
    for (const page of pages) {
      mkdirSync(join(wikiRoot, page.part), { recursive: true });
      writeFileSync(join(wikiRoot, page.part, `${page.page}.md`), pageMarkdown(page.scopeKey, page.body, page.extra), "utf8");
      if (!(options.dropSources && page.page === "page-001")) {
        writeFileSync(join(wikiRoot, page.part, `${page.page}.sources`), `${page.sources.join("\n")}\n`, "utf8");
      }
    }
    for (const name of options.injectRootFiles ?? []) {
      mkdirSync(wikiRoot, { recursive: true });
      writeFileSync(join(wikiRoot, name), "extra", "utf8");
    }
    if (options.symlinkPage) {
      mkdirSync(join(wikiRoot, options.symlinkPage.part), { recursive: true });
      symlinkSync(options.symlinkPage.target, join(wikiRoot, options.symlinkPage.part, options.symlinkPage.page));
    }
    const analysisDir = join(tmp, "merged", "analysis");
    mkdirSync(analysisDir, { recursive: true });
    const analysisRecords = options.analysisRecords ?? [
      { id: id1, scopeKey: SCOPE_A },
      { id: id2, scopeKey: SCOPE_A },
    ];
    writeFileSync(join(analysisDir, "merged.jsonl"), analysisRecords.map((recordItem) => JSON.stringify({
      id: recordItem.id, scopeKey: recordItem.scopeKey, excerpt: "keeps every transcript", path: `/k/${recordItem.id}.md`,
    })).join("\n") + "\n", "utf8");
    const beforeIdsPath = join(tmp, "before-ids.txt");
    writeFileSync(beforeIdsPath, `${(options.beforeIds ?? [id1, id2]).join("\n")}\n`, "utf8");
    const templatesPath = join(tmp, "scope-templates.json");
    writeTemplates(templatesPath);
    const configPath = writeConfig(tmp);
    return { tmp, wikiRoot, analysisDir, beforeIdsPath, templatesPath, configPath, id1, id2, id3 };
  }

  test("scanWikiRoot enforces page filenames, pairing and symlinks", () => {
    const healthy = buildWikiFixture();
    const scan = scanWikiRoot(healthy.wikiRoot);
    expect(scan.violations).toEqual([]);
    expect(scan.pages).toEqual([join(healthy.wikiRoot, "part-001", "page-001.md")]);

    const rootFile = buildWikiFixture({ injectRootFiles: ["index.md"] });
    expect(scanWikiRoot(rootFile.wikiRoot).violations[0]).toMatch(/unexpected file in wiki root/);

    const extra = buildWikiFixture({ injectRootFiles: [] });
    writeFileSync(join(extra.wikiRoot, "part-001", "notes.md"), "x", "utf8");
    expect(scanWikiRoot(extra.wikiRoot).violations[0]).toMatch(/undeclared wiki file/);

    const missingSources = buildWikiFixture({ dropSources: true });
    expect(scanWikiRoot(missingSources.wikiRoot).violations[0]).toMatch(/missing paired \.sources/);

    const linked = buildWikiFixture({});
    symlinkSync(join(linked.wikiRoot, "part-001", "page-001.md"), join(linked.wikiRoot, "part-001", "page-002.md"));
    expect(scanWikiRoot(linked.wikiRoot).violations[0]).toMatch(/symlink wiki entry/);
  });

  test("offline preflight passes a healthy fixture and leaks no credentials", async () => {
    const fixture = buildWikiFixture();
    const outPath = join(fixture.tmp, "receipts", "preflight.json");
    const summary = await runPreflight({
      wikiRoot: fixture.wikiRoot, analysisDir: fixture.analysisDir, configPath: fixture.configPath,
      templatesPath: fixture.templatesPath, beforeIdsPath: fixture.beforeIdsPath, outPath, offline: true,
    });
    expect(summary.status).toBe("ready");
    expect(summary.embeddingDims).toBe(1024);
    expect(summary.embeddingDimsSource).toContain("vectorDimsForModel(model=BAAI/bge-m3)");
    const receipt = readFileSync(outPath, "utf8");
    expect(receipt).not.toContain("sk-TEST-SECRET-KEY");
    expect(receipt).not.toContain("pgpass-SECRET");
    expect(receipt).not.toContain("db.example.test");
    expect(receipt).not.toContain("pguser");
  });

  test("blocks final pages with tree_type none and batch-scope chain breaks", async () => {
    const nonePage = buildWikiFixture({
      pages: [{ part: "part-001", page: "page-001", scopeKey: SCOPE_A, body: "Agent collection path scope keeps every transcript inside the workspace boundary.", sources: [makeUuid("p1")], extra: { tree_type: "none" } }],
      analysisRecords: [{ id: makeUuid("p1"), scopeKey: SCOPE_A }],
      beforeIds: [makeUuid("p1")],
    });
    const noneSummary = await runPreflight({
      wikiRoot: nonePage.wikiRoot, analysisDir: nonePage.analysisDir, configPath: nonePage.configPath,
      templatesPath: nonePage.templatesPath, beforeIdsPath: nonePage.beforeIdsPath, offline: true,
    });
    expect(noneSummary.status).toBe("blocked");

    // page 与 analysis 的 scope 一致，但冻结 manifest（batch 侧）声明了另一个 scope。
    const fixture = buildWikiFixture();
    const manifestPath = join(fixture.tmp, "source-manifest.jsonl");
    writeFileSync(manifestPath, [fixture.id1, fixture.id2].map((id) => JSON.stringify({
      id, path: `/k/${id}.md`, sourceRoot: "/k", scopeKey: SCOPE_B,
      bytes: 1, sha256: "0".repeat(64), batchFile: "batch-0000-n60.txt",
    })).join("\n") + "\n", "utf8");
    const outPath = join(fixture.tmp, "receipts", "preflight.json");
    const brokenChain = await runPreflight({
      wikiRoot: fixture.wikiRoot,
      analysisDir: fixture.analysisDir,
      configPath: fixture.configPath,
      templatesPath: fixture.templatesPath,
      beforeIdsPath: fixture.beforeIdsPath,
      manifestPath,
      outPath,
      offline: true,
    });
    expect(brokenChain.status).toBe("blocked");
    const receipt = JSON.parse(readFileSync(outPath, "utf8")) as { violationDetails: string[] };
    expect(receipt.violationDetails.some((line) => line.includes("scope chain broken at batch"))).toBe(true);
  });

  test("blocks a page whose analysis scope disagrees and cross-scope source reuse", async () => {
    const fixture = buildWikiFixture({
      analysisRecords: [
        { id: makeUuid("p1"), scopeKey: SCOPE_B },
        { id: makeUuid("p2"), scopeKey: SCOPE_A },
      ],
    });
    const outPath = join(fixture.tmp, "receipts", "preflight.json");
    const summary = await runPreflight({
      wikiRoot: fixture.wikiRoot, analysisDir: fixture.analysisDir, configPath: fixture.configPath,
      templatesPath: fixture.templatesPath, beforeIdsPath: fixture.beforeIdsPath, outPath, offline: true,
    });
    expect(summary.status).toBe("blocked");
    const receipt = JSON.parse(readFileSync(outPath, "utf8")) as { violationDetails: string[] };
    expect(receipt.violationDetails.some((line) => line.includes("scope chain broken at analysis"))).toBe(true);

    const shared = makeUuid("shared");
    const crossing = buildWikiFixture({
      pages: [
        { part: "part-001", page: "page-001", scopeKey: SCOPE_A, body: "Agent collection path scope keeps every transcript inside the workspace boundary.", sources: [shared] },
        { part: "part-002", page: "page-001", scopeKey: SCOPE_B, body: "A different body about switchgear operation review and naming conventions.", sources: [shared] },
      ],
      analysisRecords: [{ id: shared, scopeKey: SCOPE_A }],
      beforeIds: [shared],
    });
    const crossed = await runPreflight({
      wikiRoot: crossing.wikiRoot, analysisDir: crossing.analysisDir, configPath: crossing.configPath,
      templatesPath: crossing.templatesPath, beforeIdsPath: crossing.beforeIdsPath, offline: true,
    });
    expect(crossed.status).toBe("blocked");
    expect(crossed.duplicate).toBe(1);
  });

  test("blocks cross-scope identical text content hash conflicts", async () => {
    const body = "Identical fused body text shared by two scopes must be flagged as a content hash conflict.";
    const idA = makeUuid("ca");
    const idB = makeUuid("cb");
    const fixture = buildWikiFixture({
      pages: [
        { part: "part-001", page: "page-001", scopeKey: SCOPE_A, body, sources: [idA] },
        { part: "part-002", page: "page-001", scopeKey: SCOPE_B, body, sources: [idB] },
      ],
      analysisRecords: [
        { id: idA, scopeKey: SCOPE_A },
        { id: idB, scopeKey: SCOPE_B },
      ],
      beforeIds: [idA, idB],
    });
    const summary = await runPreflight({
      wikiRoot: fixture.wikiRoot, analysisDir: fixture.analysisDir, configPath: fixture.configPath,
      templatesPath: fixture.templatesPath, beforeIdsPath: fixture.beforeIdsPath, offline: true,
    });
    expect(summary.status).toBe("blocked");
    expect(summary.conflicts).toBe(1);
  });

  test("blocks incomplete before-ids coverage", async () => {
    const fixture = buildWikiFixture({ beforeIds: [makeUuid("p1"), makeUuid("p2"), makeUuid("ghost")] });
    const summary = await runPreflight({
      wikiRoot: fixture.wikiRoot, analysisDir: fixture.analysisDir, configPath: fixture.configPath,
      templatesPath: fixture.templatesPath, beforeIdsPath: fixture.beforeIdsPath, offline: true,
    });
    expect(summary.status).toBe("blocked");
    expect(summary.missing).toBe(1);
  });
});

describe("baseline receipt", () => {
  test("exposes only whitelisted fields without credentials", () => {
    const receipt = buildBaselineReceipt(
      {
        knowledgeCount: 49509, beforeIdHits: 49509, memoriesCount: 1200,
        embeddingModel: "BAAI/bge-m3", embeddingDims: 1024,
        embeddingDimsSource: "postgres:mengshu_active_embedding_space.dimensions",
      },
      {
        configPath: "/Users/x/.mengshu/config.json",
        beforeIdsPath: "/run/before-ids.txt",
        templatesPath: "/run/scope-templates.json",
        beforeIds: 49509,
        scopeTemplates: 21,
        activeEmbeddingSpace: { embeddingSpaceId: `embedding-space:v1:${"c".repeat(64)}`, state: "known-queryable" },
      },
    );
    const serialized = JSON.stringify(receipt);
    expect(serialized).toContain("embeddingDimsSource");
    expect(serialized).toContain("postgres:mengshu_active_embedding_space.dimensions");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("host");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]+/);
    expect(Object.keys(receipt).sort()).toEqual([
      "activeEmbeddingSpace", "beforeIdHits", "beforeIds", "beforeIdsPath", "configPath",
      "embeddingDims", "embeddingDimsSource", "embeddingModel", "generatedAt", "knowledgeCount",
      "memoriesCount", "scopeTemplates", "templatesPath",
    ].sort());
  });
});

// parseAnalysisLine 兼容性：verify 命令仍用它做严格解析。
describe("analysis line compatibility", () => {
  test("parseAnalysisLine keeps verify-era strictness", () => {
    const id = makeUuid("compat");
    const line = JSON.stringify({ id, scopeKey: SCOPE_A, excerpt: "知识正文摘录", path: "/k/a.md" });
    expect(parseAnalysisLine(line)).toEqual({ id, scopeKey: SCOPE_A, excerpt: "知识正文摘录", path: "/k/a.md" });
    expect(() => parseAnalysisLine(JSON.stringify({ id: "not-a-uuid", scopeKey: "s", excerpt: "x", path: "/a" }))).toThrow(/invalid/);
    expect(() => parseAnalysisLine(line + line)).toThrow(); // 拼接 JSON 必须炸
  });
});
