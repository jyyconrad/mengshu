/**
 * wiki-slim 离线 fixture 单测（不触碰真实树、不发网络请求、不写凭据）。
 *
 * 覆盖计划点名的五类形态：envelope / CRLF / 空正文 / 重复组 / 缺 envelope，
 * 外加铁律验证：先校验后写、原子 rename 落盘后的正文零变化（以
 * operator-wiki-knowledge-replace.ts 的 extractWorksetBody 语义对账）、
 * manifest/report 对账证据、slim 幂等与 fail-stop。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { extractWorksetBody } from "./operator-wiki-knowledge-replace.js";
import {
  buildEvidenceLine,
  buildMarkedMarkdown,
  buildSlimmedMarkdown,
  collectMarkdownFiles,
  decodeEnvelope,
  frontmatterCloseDiverges,
  resolveFileId,
  runCli,
  runDupes,
  runExtract,
  runSlim,
  sha256Hex,
  splitFrontmatter,
} from "./wiki-slim.js";

const SCOPE = "local:mengshu:default:knowledge-legacy-openclaw-workspace:default:knowledge";
const DELTA_SCOPE = "local:mengshu-eval:kb-pilot-eval:kb-pilot-283dc0a5b96f:e2e-runner:knowledge";
const SOURCE_HASH = "07e214cedbb750cc9820cce5d12368495914c7f3ef34415a9197c1bc7aa52ebb";

function encodeEnvelope(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fullEnvelope(id: string, scopeKey: string | null = SCOPE): Record<string, unknown> {
  return {
    createdAt: "2026-04-08T13:35:57.987Z",
    importance: 0.5,
    category: "other",
    contentHash: "0fcb7b5f6b66d0afc500883dcdff08dbb",
    dataType: "document",
    producerId: "openclaw",
    namespace: "knowledge",
    scopeKey,
    id,
    agentId: "default",
    vector: new Array(4).fill(0.25),
    text: "<p>旧原文</p>",
  };
}

interface RootFixture {
  readonly base: string;
  readonly sourceRoot: string;
  readonly deltaRoot: string;
}

const roots: RootFixture[] = [];

function freshRoots(): RootFixture {
  const base = mkdtempSync(join(tmpdir(), "wiki-slim-test-"));
  const fixture: RootFixture = {
    base,
    sourceRoot: join(base, "source", "knowledge"),
    deltaRoot: join(base, "delta"),
  };
  roots.push(fixture);
  mkdirSync(fixture.sourceRoot, { recursive: true });
  mkdirSync(fixture.deltaRoot, { recursive: true });
  return fixture;
}

afterEach(() => {
  for (const fixture of roots.splice(0)) rmSync(fixture.base, { recursive: true, force: true });
});

/** 按 C1 真实顺序先跑 extract 生成留证，返回留证路径（slim 的 --evidence 输入）。 */
async function buildEvidence(fixture: RootFixture): Promise<string> {
  const evidencePath = join(fixture.base, "legacy-row-meta.jsonl");
  await runExtract({ sourceRoot: fixture.sourceRoot, deltaRoot: fixture.deltaRoot, outPath: evidencePath });
  return evidencePath;
}

/** 仿真实 source/knowledge 文件：胖 frontmatter + envelope + preview 注释 + 正文。 */
function fatSourceMarkdown(id: string, envelope: Record<string, unknown>, body = "默认正文"): string {
  return [
    "---",
    "mengshu_workset_schema: mengshu.native-record-markdown/v1",
    "mengshu_phase: source",
    `mengshu_source_ref: knowledge:${id}`,
    `mengshu_source_hash: ${SOURCE_HASH}`,
    `mengshu_scope_fingerprint: ${"f".repeat(64)}`,
    "mengshu_envelope_encoding: base64url-json",
    `mengshu_envelope: ${encodeEnvelope(envelope)}`,
    "---",
    "<!-- mengshu-content-preview-bytes: 12 -->",
    body,
    "",
  ].join("\n");
}

/** 仿真实 delta 文件：source_id + scope_key，无 envelope，无 mengshu_source_hash。 */
function deltaMarkdown(id: string, body: string): string {
  return [
    "---",
    `source_id: ${id}`,
    `scope_key: ${DELTA_SCOPE}`,
    "category: fact",
    `created_at: 2026-08-31 13:51:56.379+00`,
    "---",
    body,
    "",
  ].join("\n");
}

function readLines(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("splitFrontmatter", () => {
  test("解析 key:value、保留正文原始字节、识别缺 envelope/无 frontmatter/未闭合", () => {
    const split = splitFrontmatter(`---\nid: a\nscope_key: ${SCOPE}\n---\r\nbody\r\nline2\r\n`);
    expect(split.hasFrontmatter).toBe(true);
    expect(split.unterminated).toBe(false);
    expect(split.keys.get("id")).toBe("a");
    expect(split.keys.get("scope_key")).toBe(SCOPE);
    expect(split.bodyRaw).toBe("body\r\nline2\r\n");

    expect(splitFrontmatter("just body").hasFrontmatter).toBe(false);
    expect(splitFrontmatter("just body").bodyRaw).toBe("just body");
    expect(splitFrontmatter("---\nid: a\nbody without close").unterminated).toBe(true);
    // 非 key:value 行不进 map，但保留在 lines 里（dupes 重写原样保留）。
    const withNoise = splitFrontmatter("---\nid: a\n  indented noise\n---\nbody");
    expect(withNoise.keys.has("indented")).toBe(false);
    expect(withNoise.lines).toContain("  indented noise");
  });

  test("值里含冒号（scope_key）不被截断；首个重复 key 生效", () => {
    const split = splitFrontmatter(`---\nscope_key: ${SCOPE}\nscope_key: other\n---\nx`);
    expect(split.keys.get("scope_key")).toBe(SCOPE);
  });
});

describe("frontmatterCloseDiverges（splitFrontmatter vs extractWorksetBody 边界分叉）", () => {
  test("闭合 --- 位于 EOF 且无行尾换行 / 裸 \\r 收尾 / 闭合行紧随开头行：分叉（extractWorksetBody 会把全文当正文）", () => {
    // 评审复现形态：splitFrontmatter 认为已闭合（正文为空），
    // extractWorksetBody 只认 "\n---\n"，闭合行后无换行 → end<0 → 全文当正文。
    const edge = "---\nid: a\n---";
    expect(frontmatterCloseDiverges(edge)).toBe(true);
    expect(extractWorksetBody(edge)).toBe(edge); // 全文（含旧 frontmatter）被当正文
    // 裸 \r 收尾的闭合行同样不被 "\n---\n" 识别。
    expect(frontmatterCloseDiverges("---\nid: a\n---\r")).toBe(true);
    // 闭合行紧随开头行（"---\n---\n…"）：唯一 "\n---\n" 起始于 index 3 < 4，extract 落空。
    expect(frontmatterCloseDiverges("---\n---\nbody")).toBe(true);
  });

  test("正常形态（闭合行后有换行、LF/CRLF、无 frontmatter、未闭合）不分叉", () => {
    expect(frontmatterCloseDiverges("---\nid: a\n---\n")).toBe(false);
    expect(frontmatterCloseDiverges("---\nid: a\n---\nbody")).toBe(false);
    expect(frontmatterCloseDiverges("---\r\nid: a\r\n---\r\nbody\r\n")).toBe(false);
    expect(frontmatterCloseDiverges("bare body")).toBe(false);
    // 未闭合由 unterminated 语义单独处理，不属于分叉态。
    expect(frontmatterCloseDiverges("---\nid: a\nbody without close")).toBe(false);
  });
});

describe("decodeEnvelope / buildEvidenceLine / resolveFileId", () => {
  test("base64url-json 往返；非 base64url 或坏 JSON 一律抛错", () => {
    const envelope = decodeEnvelope(encodeEnvelope(fullEnvelope("id-1")));
    expect((envelope as Record<string, unknown>).id).toBe("id-1");
    expect(() => decodeEnvelope("不是base64url!!")).toThrow();
    expect(() => decodeEnvelope(Buffer.from("{bad json", "utf8").toString("base64url"))).toThrow();
  });

  test("留证行按规范字段顺序输出 9 字段；缺失省略、null 原样、非原始值字符串化、envelope id 优先", () => {
    const line = buildEvidenceLine(fullEnvelope("env-id"), "fallback-id");
    expect(Object.keys(line)).toEqual([
      "id",
      "createdAt",
      "importance",
      "category",
      "contentHash",
      "dataType",
      "producerId",
      "namespace",
      "scopeKey",
    ]);
    expect(line.id).toBe("env-id");
    expect(line.importance).toBe(0.5);
    const partial = buildEvidenceLine({ id: "x", scopeKey: null, contentHash: ["a", "b"] }, "fallback-id");
    // 字段顺序固定为规范顺序：id → … → contentHash → … → scopeKey。
    expect(Object.keys(partial)).toEqual(["id", "contentHash", "scopeKey"]);
    expect(partial.scopeKey).toBeNull();
    expect(partial.contentHash).toBe('["a","b"]');
    // 留证字段白名单之外的信封字段（vector/text）一律不进留证行。
    expect(Object.keys(buildEvidenceLine(fullEnvelope("e"), "f"))).toHaveLength(9);
    expect(buildEvidenceLine({ category: "fact" }, "fallback-id").id).toBe("fallback-id");
  });

  test("id 解析优先级：frontmatter id > source_id > source_ref 尾段 > 文件名", () => {
    const keys = (entries: Record<string, string>) => new Map(Object.entries(entries));
    expect(resolveFileId({ keys: keys({ id: "a", source_id: "b", mengshu_source_ref: "knowledge:c" }), filenameStem: "d" })).toBe("a");
    expect(resolveFileId({ keys: keys({ source_id: "b", mengshu_source_ref: "knowledge:c" }), filenameStem: "d" })).toBe("b");
    expect(resolveFileId({ keys: keys({ mengshu_source_ref: "knowledge:c" }), filenameStem: "d" })).toBe("c");
    expect(resolveFileId({ keys: keys({}), filenameStem: "d" })).toBe("d");
    expect(resolveFileId({ keys: keys({}), filenameStem: "" })).toBe("");
  });
});

describe("buildSlimmedMarkdown / buildMarkedMarkdown", () => {
  test("最小 frontmatter 键序固定：id、scope_key、mengshu_source_hash、duplicate_of；缺省键不写", () => {
    expect(buildSlimmedMarkdown({
      id: "a",
      scopeKey: SCOPE,
      sourceHash: SOURCE_HASH,
      duplicateOf: "rep",
      body: "正文",
    })).toBe(`---\nid: a\nscope_key: ${SCOPE}\nmengshu_source_hash: ${SOURCE_HASH}\nduplicate_of: rep\n---\n正文\n`);
    expect(buildSlimmedMarkdown({ id: "a", scopeKey: null, sourceHash: null, duplicateOf: null, body: "B" }))
      .toBe("---\nid: a\n---\nB\n");
    expect(buildSlimmedMarkdown({ id: "a", scopeKey: null, sourceHash: null, duplicateOf: null, body: "" }))
      .toBe("---\nid: a\n---\n");
  });

  test("标记重写：追加 duplicate_of 且 frontmatter 其余行原样；已有标记则原位替换；正文逐字节保留", () => {
    const split = splitFrontmatter(`---\nid: a\nnote: keep me\n---\nbody bytes\r\n`);
    expect(buildMarkedMarkdown(split, "rep")).toBe(`---\nid: a\nnote: keep me\nduplicate_of: rep\n---\nbody bytes\r\n`);
    const marked = splitFrontmatter("---\nid: a\nduplicate_of: old\n---\nbody");
    expect(buildMarkedMarkdown(marked, "rep")).toBe("---\nid: a\nduplicate_of: rep\n---\nbody");
    const noFm = splitFrontmatter("bare body");
    expect(buildMarkedMarkdown(noFm, "rep")).toBe("---\nduplicate_of: rep\n---\nbare body");
  });
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

describe("runExtract", () => {
  test("envelope 文件抽 9 字段；缺 envelope 写 {id,envelope:absent}；scopeKey:null 原样留证", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.sourceRoot, "aaa.md"), fatSourceMarkdown("aaa", fullEnvelope("aaa")));
    writeFileSync(join(roots.sourceRoot, "bbb.md"), fatSourceMarkdown("bbb", fullEnvelope("bbb", null)));
    writeFileSync(join(roots.deltaRoot, "ccc.md"), deltaMarkdown("ccc", "# Delta body"));

    const outPath = join(roots.base, "evidence", "legacy-row-meta.jsonl");
    const summary = await runExtract({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      outPath,
      expectFiles: 3,
    });
    expect(summary).toEqual({ files: 3, extracted: 2, noEnvelope: 1 });

    const lines = readLines(outPath);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ id: "aaa", createdAt: "2026-04-08T13:35:57.987Z", importance: 0.5, category: "other", contentHash: "0fcb7b5f6b66d0afc500883dcdff08dbb", dataType: "document", producerId: "openclaw", namespace: "knowledge", scopeKey: SCOPE });
    expect(lines[1]).toMatchObject({ id: "bbb", scopeKey: null });
    expect(lines[2]).toEqual({ id: "ccc", envelope: "absent" });
    // 留证行不含旧向量与旧原文（不留凭据、不留大字段）。
    expect(Object.keys(lines[0]!)).toHaveLength(9);
  });

  test("--expect-files 不符时先校验后写：抛错且不产出文件", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.sourceRoot, "aaa.md"), fatSourceMarkdown("aaa", fullEnvelope("aaa")));
    const outPath = join(roots.base, "evidence", "legacy-row-meta.jsonl");
    await expect(runExtract({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      outPath,
      expectFiles: 49509,
    })).rejects.toThrow(/file count mismatch: walked 1, expected 49509/);
    expect(() => statSync(outPath)).toThrow();
  });

  test("envelope 存在但解不开：整体失败，不静默当 absent", async () => {
    const roots = freshRoots();
    const badJson = Buffer.from("{oops", "utf8").toString("base64url");
    writeFileSync(join(roots.sourceRoot, "aaa.md"), `---\nmengshu_envelope: ${badJson}\nid: aaa\n---\nbody`);
    await expect(runExtract({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      outPath: join(roots.base, "out.jsonl"),
    })).rejects.toThrow(/envelope undecodable/);
  });
});

// ---------------------------------------------------------------------------
// slim
// ---------------------------------------------------------------------------

describe("runSlim", () => {
  test("胖信封文件瘦身为最小 frontmatter + 原正文；manifest 逐文件对账；体积下降", async () => {
    const roots = freshRoots();
    const path = join(roots.sourceRoot, "aaa.md");
    const original = fatSourceMarkdown("aaa", fullEnvelope("aaa"), "正文第一行\n正文第二行");
    writeFileSync(path, original);
    const expectedBody = extractWorksetBody(original);

    const manifestPath = join(roots.base, "slimming-manifest.jsonl");
    const summary = await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath,
      expectFiles: 1,
    });
    expect(summary).toEqual({
      files: 1,
      rewritten: 1,
      bodyMismatches: 0,
      bytesBefore: Buffer.byteLength(original, "utf8"),
      bytesAfter: Buffer.byteLength(readFileSync(path, "utf8"), "utf8"),
    });
    expect(summary.bytesAfter).toBeLessThan(summary.bytesBefore);

    const slimmed = readFileSync(path, "utf8");
    expect(slimmed).toBe(
      `---\nid: aaa\nscope_key: ${SCOPE}\nmengshu_source_hash: ${SOURCE_HASH}\n---\n${expectedBody}\n`,
    );
    expect(slimmed).not.toContain("mengshu_envelope");
    expect(slimmed).not.toContain("preview-bytes");
    // 重写后重读的正文与 extractWorksetBody(original) 逐哈希一致。
    expect(sha256Hex(extractWorksetBody(slimmed))).toBe(sha256Hex(expectedBody));

    const manifest = readLines(manifestPath);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toEqual({
      id: "aaa",
      path,
      oldBytes: Buffer.byteLength(original, "utf8"),
      newBytes: Buffer.byteLength(slimmed, "utf8"),
      bodySha256: sha256Hex(expectedBody),
    });
  });

  test("delta 文件（缺 envelope）：scope_key 取旧 frontmatter；无旧 mengshu_source_hash 则不写该行", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "ccc.md");
    writeFileSync(path, deltaMarkdown("ccc", "# Delta body"));
    await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath: join(roots.base, "m.jsonl"),
    });
    expect(readFileSync(path, "utf8")).toBe(`---\nid: ccc\nscope_key: ${DELTA_SCOPE}\n---\n# Delta body\n`);
  });

  test("frontmatter 与 envelope 都没有 scope_key（真实树 26 个隔离行形态）：不写 scope_key 行", async () => {
    const roots = freshRoots();
    const path = join(roots.sourceRoot, "qqq.md");
    writeFileSync(path, fatSourceMarkdown("qqq", fullEnvelope("qqq", null), "隔离行正文"));
    await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath: join(roots.base, "m.jsonl"),
    });
    expect(readFileSync(path, "utf8")).toBe(
      `---\nid: qqq\nmengshu_source_hash: ${SOURCE_HASH}\n---\n隔离行正文\n`,
    );
  });

  test("空正文：重写后仍是合法最小文件，正文哈希为空串哈希且校验通过", async () => {
    const roots = freshRoots();
    const path = join(roots.sourceRoot, "empty.md");
    writeFileSync(path, fatSourceMarkdown("empty", fullEnvelope("empty"), "   "));
    const manifestPath = join(roots.base, "m.jsonl");
    const summary = await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath,
    });
    expect(summary.rewritten).toBe(1);
    expect(summary.bodyMismatches).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(
      `---\nid: empty\nscope_key: ${SCOPE}\nmengshu_source_hash: ${SOURCE_HASH}\n---\n`,
    );
    expect(readLines(manifestPath)[0]!.bodySha256).toBe(sha256Hex(""));
  });

  test("CRLF 文件：重写落 LF 最小件，extractWorksetBody 语义正文哈希一致（bodyMismatches=0）", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "crlf.md");
    const crlf = `---\r\nsource_id: crlf\r\nscope_key: ${DELTA_SCOPE}\r\n---\r\nline1\r\nline2\r\n`;
    writeFileSync(path, crlf);
    const before = extractWorksetBody(crlf);
    const summary = await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath: join(roots.base, "m.jsonl"),
    });
    expect(summary.bodyMismatches).toBe(0);
    const after = readFileSync(path, "utf8");
    expect(extractWorksetBody(after)).toBe(before);
    expect(after).toBe(`---\nid: crlf\nscope_key: ${DELTA_SCOPE}\n---\n${before}\n`);
  });

  test("无 frontmatter 文件：补最小 frontmatter，extractWorksetBody 语义正文不变", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "bare.md");
    writeFileSync(path, "bare body\n");
    const summary = await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath: join(roots.base, "m.jsonl"),
    });
    expect(summary.bodyMismatches).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("---\nid: bare\n---\nbare body\n");
  });

  test("幂等：对已瘦身文件重跑，产物字节不变（oldBytes == newBytes）", async () => {
    const roots = freshRoots();
    const path = join(roots.sourceRoot, "aaa.md");
    writeFileSync(path, fatSourceMarkdown("aaa", fullEnvelope("aaa"), "正文"));
    const manifestPath = join(roots.base, "m.jsonl");
    const evidencePath = await buildEvidence(roots);
    await runSlim({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, evidencePath, manifestPath });
    const once = readFileSync(path, "utf8");
    const second = await runSlim({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, evidencePath, manifestPath });
    expect(readFileSync(path, "utf8")).toBe(once);
    expect(second.rewritten).toBe(1);
    expect(second.bodyMismatches).toBe(0);
    const manifest = readLines(manifestPath);
    expect(manifest[0]!.oldBytes).toBe(manifest[0]!.newBytes);
  });

  test("已带 duplicate_of 的文件 slim 后保留标记（与 dupes 可组合）", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "dup.md");
    writeFileSync(path, `---\nsource_id: dup\nscope_key: ${DELTA_SCOPE}\nduplicate_of: rep\n---\nbody\n`);
    await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath: join(roots.base, "m.jsonl"),
    });
    expect(readFileSync(path, "utf8")).toBe(`---\nid: dup\nscope_key: ${DELTA_SCOPE}\nduplicate_of: rep\n---\nbody\n`);
  });

  test("未闭合 frontmatter：整体失败且原文件一字节不动（先校验后写）", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "broken.md");
    const broken = "---\nsource_id: broken\nno close ever\n";
    writeFileSync(path, broken);
    // extract 对未闭合文件同样拒写，故此处手写仅含该 id 的留证，验证 runSlim 自身的 fail-stop。
    const evidencePath = join(roots.base, "e.jsonl");
    writeFileSync(evidencePath, `${JSON.stringify({ id: "broken", envelope: "absent" })}\n`);
    await expect(runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath,
      manifestPath: join(roots.base, "m.jsonl"),
    })).rejects.toThrow(/frontmatter unterminated/);
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  test("fail-stop：某文件重写后正文哈希不一致即停止，后续文件不再重写，manifest 保留已完成行", async () => {
    const roots = freshRoots();
    const good = join(roots.deltaRoot, "0000-good.md");
    writeFileSync(good, deltaMarkdown("0000-good", "good body"));
    // 构造一个必然校验失败的文件：正文以两行 <!-- mengshu-content-preview-bytes: N --> 开头。
    // extractWorksetBody 只剥首个注释行，瘦身正文因此以注释开头；重写重读时该注释又被剥掉，
    // 正文哈希必然漂移 → 校验必败 → fail-stop（该文件必须保持原样）。
    const poisoned = join(roots.deltaRoot, "0001-poison.md");
    writeFileSync(
      poisoned,
      `---\nsource_id: 0001-poison\nscope_key: ${DELTA_SCOPE}\n---\n<!-- mengshu-content-preview-bytes: 3 -->\n<!-- mengshu-content-preview-bytes: 3 -->\nonly\n`,
    );
    const untouched = join(roots.deltaRoot, "0002-untouched.md");
    const untouchedOriginal = deltaMarkdown("0002-untouched", "later body");
    writeFileSync(untouched, untouchedOriginal);

    const manifestPath = join(roots.base, "m.jsonl");
    const summary = await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath,
    });
    expect(summary.bodyMismatches).toBe(1);
    expect(summary.rewritten).toBe(1);
    // 毒文件保持原样；后续文件完全未动。
    expect(readFileSync(poisoned, "utf8")).toContain("mengshu-content-preview-bytes");
    expect(readFileSync(untouched, "utf8")).toBe(untouchedOriginal);
    const manifest = readLines(manifestPath);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]!.id).toBe("0000-good");
  });

  test("分叉边界（闭合 --- 位于 EOF 且无行尾换行）：重写前报错拒写，绝不产出『新 frontmatter + 整个原文件』损坏件", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "edge.md");
    // 评审复现形态：splitFrontmatter 认为已闭合（正文为空），extractWorksetBody 把
    // 全文当正文；旧实现写出重复 frontmatter 且 bodyMismatches=0、退出码 0（fail-unsafe）。
    const edge = `---\nsource_id: edge\nscope_key: ${DELTA_SCOPE}\n---`;
    writeFileSync(path, edge);
    const evidencePath = join(roots.base, "e.jsonl");
    writeFileSync(evidencePath, `${JSON.stringify({ id: "edge", envelope: "absent" })}\n`);
    await expect(runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath,
      manifestPath: join(roots.base, "m.jsonl"),
    })).rejects.toThrow(/diverges from body extractor/);
    // 原文件一字节不动，绝无第二次 frontmatter 拼接。
    expect(readFileSync(path, "utf8")).toBe(edge);
  });

  test("C1 顺序门禁：留证缺失 / id 未覆盖 / 重复 id，一律在重写任何文件之前失败且文件不动", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "a.md");
    const original = deltaMarkdown("a", "body");
    writeFileSync(path, original);
    const manifestPath = join(roots.base, "m.jsonl");
    // 留证文件缺失（乱序：还没跑 extract）。
    await expect(runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: join(roots.base, "missing.jsonl"),
      manifestPath,
    })).rejects.toThrow(/evidence file is missing/);
    // 留证存在但不含该文件的 id。
    const evidencePath = join(roots.base, "e.jsonl");
    writeFileSync(evidencePath, `${JSON.stringify({ id: "someone-else" })}\n`);
    await expect(runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath,
      manifestPath,
    })).rejects.toThrow(/evidence coverage gate failed/);
    // 留证含重复 id（行数 ≠ id 数）。
    writeFileSync(evidencePath, `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "a" })}\n`);
    await expect(runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath,
      manifestPath,
    })).rejects.toThrow(/duplicate id/);
    // 三个失败路径都没有触发任何重写。
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("C1 顺序门禁：留证 id 集合与文件数不一致（留证与现场不同步）同样拒绝", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.deltaRoot, "a.md"), deltaMarkdown("a", "body"));
    const evidencePath = join(roots.base, "e.jsonl");
    writeFileSync(evidencePath, `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "stale" })}\n`);
    await expect(runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath,
      manifestPath: join(roots.base, "m.jsonl"),
    })).rejects.toThrow(/evidence coverage gate failed.*files=1 evidenceIds=2 uncovered=0/);
  });
});

// ---------------------------------------------------------------------------
// dupes
// ---------------------------------------------------------------------------

describe("runDupes", () => {
  test("非空重复组：最小组员 id 为代表，其余标记 duplicate_of；代表不标记；空正文只计数", async () => {
    const roots = freshRoots();
    const bodyDup = "完全相同的正文\n第二行";
    writeFileSync(join(roots.sourceRoot, "b-file.md"), fatSourceMarkdown("b-file", fullEnvelope("b-file"), bodyDup));
    writeFileSync(join(roots.sourceRoot, "a-file.md"), fatSourceMarkdown("a-file", fullEnvelope("a-file"), bodyDup));
    writeFileSync(join(roots.sourceRoot, "c-unique.md"), fatSourceMarkdown("c-unique", fullEnvelope("c-unique"), "独一无二的正文"));
    writeFileSync(join(roots.deltaRoot, "d-empty1.md"), deltaMarkdown("d-empty1", "  "));
    writeFileSync(join(roots.deltaRoot, "d-empty2.md"), deltaMarkdown("d-empty2", ""));

    const reportPath = join(roots.base, "dup-report.jsonl");
    const summary = await runDupes({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      reportPath,
      expectFiles: 5,
    });
    expect(summary).toEqual({ nonEmptyDupGroups: 1, marked: 1, emptyBodyFiles: 2 });

    // 代表（最小 id a-file）不标记；b-file 被标记且 frontmatter 其余行保留、正文逐字节不变。
    const rep = readFileSync(join(roots.sourceRoot, "a-file.md"), "utf8");
    expect(rep).not.toContain("duplicate_of");
    const marked = splitFrontmatter(readFileSync(join(roots.sourceRoot, "b-file.md"), "utf8"));
    expect(marked.keys.get("duplicate_of")).toBe("a-file");
    expect(marked.keys.get("mengshu_source_hash")).toBe(SOURCE_HASH);
    expect(marked.keys.get("mengshu_envelope")?.length ?? 0).toBeGreaterThan(0);
    expect(marked.bodyRaw).toBe(`<!-- mengshu-content-preview-bytes: 12 -->\n${bodyDup}\n`);
    // 空正文文件绝不标记；唯一正文文件不受影响。
    expect(readFileSync(join(roots.deltaRoot, "d-empty1.md"), "utf8")).not.toContain("duplicate_of");
    expect(readFileSync(join(roots.deltaRoot, "d-empty2.md"), "utf8")).not.toContain("duplicate_of");
    expect(readFileSync(join(roots.sourceRoot, "c-unique.md"), "utf8")).not.toContain("duplicate_of");

    const report = readLines(reportPath);
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ size: 2, representative: "a-file" });
    expect(report[0]!.members).toEqual([
      { id: "a-file", path: join(roots.sourceRoot, "a-file.md"), marked: false },
      { id: "b-file", path: join(roots.sourceRoot, "b-file.md"), marked: true },
    ]);
    expect(report[0]!.bodySha256).toBe(sha256Hex(bodyDup));
  });

  test("标记保持正文原始字节（含 CRLF 正文）", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.deltaRoot, "z-crlf.md"), `---\r\nsource_id: z-crlf\r\nscope_key: ${DELTA_SCOPE}\r\n---\r\nsame body\r\n`);
    writeFileSync(join(roots.deltaRoot, "a-crlf.md"), `---\r\nsource_id: a-crlf\r\nscope_key: ${DELTA_SCOPE}\r\n---\r\nsame body\r\n`);
    const summary = await runDupes({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      reportPath: join(roots.base, "r.jsonl"),
    });
    expect(summary).toEqual({ nonEmptyDupGroups: 1, marked: 1, emptyBodyFiles: 0 });
    const after = splitFrontmatter(readFileSync(join(roots.deltaRoot, "z-crlf.md"), "utf8"));
    expect(after.keys.get("duplicate_of")).toBe("a-crlf");
    expect(after.bodyRaw).toBe("same body\r\n");
  });

  test("幂等重跑：已正确标记的文件不再重写（mtime 不变），摘要一致", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.deltaRoot, "b.md"), deltaMarkdown("b", "dup body"));
    writeFileSync(join(roots.deltaRoot, "a.md"), deltaMarkdown("a", "dup body"));
    const reportPath = join(roots.base, "r.jsonl");
    const first = await runDupes({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, reportPath });
    expect(first.marked).toBe(1);
    const markedPath = join(roots.deltaRoot, "b.md");
    const statsAfterFirst = statSync(markedPath);
    const bytesAfterFirst = readFileSync(markedPath, "utf8");
    const second = await runDupes({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, reportPath });
    expect(second).toEqual(first);
    expect(readFileSync(markedPath, "utf8")).toBe(bytesAfterFirst);
    expect(statSync(markedPath).mtimeMs).toBe(statsAfterFirst.mtimeMs);
  });

  test("旧标记指向别的代表时原位更新为当前代表", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.deltaRoot, "b.md"), `---\nsource_id: b\nscope_key: ${DELTA_SCOPE}\nduplicate_of: somebody-else\n---\ndup body\n`);
    writeFileSync(join(roots.deltaRoot, "a.md"), deltaMarkdown("a", "dup body"));
    await runDupes({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, reportPath: join(roots.base, "r.jsonl") });
    const after = splitFrontmatter(readFileSync(join(roots.deltaRoot, "b.md"), "utf8"));
    expect(after.keys.get("duplicate_of")).toBe("a");
    expect(after.bodyRaw).toBe("dup body\n");
  });

  test("--expect-files 不符时抛错且不改任何文件", async () => {
    const roots = freshRoots();
    const path = join(roots.deltaRoot, "a.md");
    const original = deltaMarkdown("a", "body");
    writeFileSync(path, original);
    await expect(runDupes({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      reportPath: join(roots.base, "r.jsonl"),
      expectFiles: 49509,
    })).rejects.toThrow(/file count mismatch/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("分叉边界（闭合 --- 位于 EOF 且无行尾换行）：dupes 同样报错拒写，不把全文当非空正文分组", async () => {
    const roots = freshRoots();
    const edge = "---\nsource_id: edge\n---";
    writeFileSync(join(roots.deltaRoot, "edge.md"), edge);
    await expect(runDupes({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      reportPath: join(roots.base, "r.jsonl"),
    })).rejects.toThrow(/diverges from body extractor/);
    expect(readFileSync(join(roots.deltaRoot, "edge.md"), "utf8")).toBe(edge);
  });
});

// ---------------------------------------------------------------------------
// 组合与 CLI 契约
// ---------------------------------------------------------------------------

describe("组合与 CLI", () => {
  test("dupes 先标记、slim 后瘦身：duplicate_of 保留、正文哈希全程一致", async () => {
    const roots = freshRoots();
    const bodyDup = "共享正文";
    writeFileSync(join(roots.deltaRoot, "b.md"), deltaMarkdown("b", bodyDup));
    writeFileSync(join(roots.deltaRoot, "a.md"), deltaMarkdown("a", bodyDup));
    const beforeA = extractWorksetBody(deltaMarkdown("a", bodyDup));
    const beforeB = extractWorksetBody(deltaMarkdown("b", bodyDup));
    await runDupes({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, reportPath: join(roots.base, "r.jsonl") });
    const manifestPath = join(roots.base, "m.jsonl");
    await runSlim({
      sourceRoot: roots.sourceRoot,
      deltaRoot: roots.deltaRoot,
      evidencePath: await buildEvidence(roots),
      manifestPath,
    });
    const a = splitFrontmatter(readFileSync(join(roots.deltaRoot, "a.md"), "utf8"));
    const b = splitFrontmatter(readFileSync(join(roots.deltaRoot, "b.md"), "utf8"));
    expect(a.keys.get("duplicate_of")).toBeUndefined();
    expect(b.keys.get("duplicate_of")).toBe("a");
    expect(extractWorksetBody(readFileSync(join(roots.deltaRoot, "a.md"), "utf8"))).toBe(beforeA);
    expect(extractWorksetBody(readFileSync(join(roots.deltaRoot, "b.md"), "utf8"))).toBe(beforeB);
    const manifest = readLines(manifestPath);
    expect(new Set(manifest.map((line) => (line.bodySha256 as string)))).toEqual(
      new Set([sha256Hex(beforeA), sha256Hex(beforeB)]),
    );
  });

  test("CLI：stdout 末行是 {files,extracted,noEnvelope} 摘要 JSON", async () => {
    const roots = freshRoots();
    writeFileSync(join(roots.sourceRoot, "aaa.md"), fatSourceMarkdown("aaa", fullEnvelope("aaa")));
    writeFileSync(join(roots.deltaRoot, "ccc.md"), deltaMarkdown("ccc", "body"));
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      await runCli([
        "extract",
        "--source", roots.sourceRoot,
        "--delta", roots.deltaRoot,
        "--out", join(roots.base, "evidence", "legacy-row-meta.jsonl"),
        "--expect-files", "2",
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(logged[logged.length - 1]!)).toEqual({ files: 2, extracted: 1, noEnvelope: 1 });
  });

  test("CLI：未知子命令报 usage；--expect-files 非法值拒绝", async () => {
    await expect(runCli(["nope"])).rejects.toThrow(/usage/);
    const roots = freshRoots();
    writeFileSync(join(roots.sourceRoot, "aaa.md"), fatSourceMarkdown("aaa", fullEnvelope("aaa")));
    await expect(runCli([
      "extract", "--source", roots.sourceRoot, "--delta", roots.deltaRoot,
      "--out", join(roots.base, "o.jsonl"), "--expect-files", "zero",
    ])).rejects.toThrow(/invalid --expect-files/);
  });

  test("CLI slim：缺 --evidence 拒绝；带 --evidence 时 stdout 末行为摘要 JSON", async () => {
    const roots = freshRoots();
    const original = deltaMarkdown("a", "body");
    writeFileSync(join(roots.deltaRoot, "a.md"), original);
    await expect(runCli([
      "slim", "--source", roots.sourceRoot, "--delta", roots.deltaRoot,
      "--manifest", join(roots.base, "m.jsonl"),
    ])).rejects.toThrow(/missing --evidence/);
    expect(readFileSync(join(roots.deltaRoot, "a.md"), "utf8")).toBe(original);

    const evidencePath = join(roots.base, "e.jsonl");
    await runExtract({ sourceRoot: roots.sourceRoot, deltaRoot: roots.deltaRoot, outPath: evidencePath });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    try {
      await runCli([
        "slim", "--source", roots.sourceRoot, "--delta", roots.deltaRoot,
        "--evidence", evidencePath, "--manifest", join(roots.base, "m.jsonl"),
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(logged[logged.length - 1]!)).toEqual({
      files: 1,
      rewritten: 1,
      bodyMismatches: 0,
      bytesBefore: Buffer.byteLength(original, "utf8"),
      bytesAfter: Buffer.byteLength(readFileSync(join(roots.deltaRoot, "a.md"), "utf8"), "utf8"),
    });
  });

  test("collectMarkdownFiles：source 在前 delta 在后，路径排序确定；空树抛错", () => {
    const roots = freshRoots();
    mkdirSync(join(roots.sourceRoot, "00"), { recursive: true });
    writeFileSync(join(roots.sourceRoot, "00", "b.md"), "x");
    writeFileSync(join(roots.sourceRoot, "a.md"), "x");
    writeFileSync(join(roots.deltaRoot, "d.md"), "x");
    expect(collectMarkdownFiles(roots.sourceRoot, roots.deltaRoot)).toEqual([
      join(roots.sourceRoot, "00", "b.md"),
      join(roots.sourceRoot, "a.md"),
      join(roots.deltaRoot, "d.md"),
    ]);
    const empty = freshRoots();
    expect(() => collectMarkdownFiles(empty.sourceRoot, empty.deltaRoot)).toThrow(/no markdown files/);
  });

  test("collectMarkdownFiles：source 与 delta 相等或任意方向嵌套 → 拒绝（防同文件重复重写/自标记）", () => {
    const roots = freshRoots();
    writeFileSync(join(roots.sourceRoot, "a.md"), "x");
    writeFileSync(join(roots.deltaRoot, "d.md"), "x");
    // 相等。
    expect(() => collectMarkdownFiles(roots.sourceRoot, roots.sourceRoot)).toThrow(/must be disjoint/);
    // delta 嵌套在 source 内（部分子集形态，--expect-files 拦不住）。
    expect(() => collectMarkdownFiles(roots.sourceRoot, join(roots.sourceRoot, "nested"))).toThrow(/must be disjoint/);
    // source 嵌套在 delta 内。
    expect(() => collectMarkdownFiles(join(roots.deltaRoot, "sub"), roots.deltaRoot)).toThrow(/must be disjoint/);
  });

  test("sha256Hex 与 node:crypto 一致", () => {
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc", "utf8").digest("hex"));
  });
});
