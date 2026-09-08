import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectorySourceScanner } from "./scanner.js";
import { sha256, snapshotHash } from "./shared.js";
import type { SourceBinding, SourceRecordLocator } from "./types.js";

const scope = { tenantId: "t", appId: "a", userId: "u", projectId: "p", agentId: "agent", namespace: "memory" };
const line = (id: string, text: string) => JSON.stringify({ type: "response_item", timestamp: "2026-09-01T00:00:00Z", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }] } }) + "\n";
let temp: string;
let root: string;
let manifestPath: string;
let opened: DirectorySourceScanner[];
beforeEach(async () => {
  opened = [];
  temp = await mkdtemp(join(tmpdir(), "evolution-exact-"));
  root = join(temp, "input");
  manifestPath = join(temp, "state", "manifest.json");
  await mkdir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const scanner of opened) await scanner.close();
  await rm(temp, { recursive: true, force: true });
});
async function create(overrides: Partial<SourceBinding> = {}) {
  const scanner = await DirectorySourceScanner.create({ binding: { sourceId: "notes", root, scope, parser: "auto", ...overrides }, manifestPath });
  opened.push(scanner);
  return scanner;
}
async function markdown() {
  const path = join(root, "deep", "nested", "notes.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "# Policy\n\nKeep project secrets private.\n\nExcept for synthetic test fixtures.\n");
  const scanner = await create();
  const report = await scanner.scan({ limits: { maxRecords: 1 } });
  const record = report.records[0];
  expect(record.locator).toBeDefined();
  return { scanner, path, report, record, locator: structuredClone(record.locator!) };
}

describe("durable exact directory records", () => {
  it("does not use a prior receipt to confirm a new page or bypass an unconfirmed predecessor", async () => {
    await writeFile(join(root, "session.jsonl"), line("one", "First audited statement.") + line("two", "Second audited statement."));
    const scanner = await create();
    const first = await scanner.scan({ limits: { maxRecords: 1 } });
    const second = await scanner.scan({ cursor: first.cursor, limits: { maxRecords: 1 } });
    const receipt = { receiptId: "db:first", sourceSnapshotHash: first.sourceSnapshotHash, recordIds: first.records.map(r => r.id) };
    await expect(scanner.confirm(second, { ...receipt, recordIds: second.records.map(r => r.id) })).rejects.toThrow(/preceding/);
    await scanner.confirm(first, receipt);
    const committed = await readFile(manifestPath, "utf8");
    await scanner.confirm(first, receipt);
    expect(await readFile(manifestPath, "utf8")).toBe(committed);
    await expect(scanner.confirm(second, { ...receipt, recordIds: second.records.map(r => r.id) })).rejects.toThrow(/receipt.*already/);
    expect(await readFile(manifestPath, "utf8")).toBe(committed);
  });
  it("reopens a deep file in a new instance without a tree scan or source body in the locator", async () => {
    const t = await markdown();
    expect(JSON.stringify(t.locator)).not.toContain("Keep project");
    expect(JSON.stringify(t.locator)).not.toContain(root);
    await t.scanner.close();
    await writeFile(join(root, "unrelated.md"), "Unrelated input.\n");
    const fresh = await create();
    const scan = vi.spyOn(fresh, "scan").mockRejectedValue(new Error("must not enumerate"));
    const read = await fresh.readRecord(t.locator);
    expect(read.valid).toBe(true);
    expect(read.record).toEqual(t.record);
    expect(read.usage).toMatchObject({ files: 1, bytes: t.locator.snapshot.hashBytes, records: 3, entries: 4 });
    expect(scan).not.toHaveBeenCalled();
    expect(await fresh.verifySnapshot({ sourceId: "notes", configFingerprint: t.locator.configFingerprint, hash: t.locator.snapshotHash, files: [t.locator.snapshot] })).toMatchObject({ valid: true });
    await expect(readFile(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconstructs JSONL session metadata, redaction, previous text and event identity", async () => {
    await writeFile(join(root, "session.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "synthetic-session" } }) + "\n" + line("before", "Keep the credentials private.") + line("wanted", "Review the synthetic test results."));
    const report = await (await create()).scan();
    const wanted = report.records.at(-1)!;
    const read = await (await create()).readRecord(structuredClone(wanted.locator!));
    expect(read).toMatchObject({ valid: true, record: wanted, usage: { files: 1, records: 3 } });
    expect(read.record!.authority).toBe("host_binding_only");
    expect(read.record!.context.before).toBe("Keep the credentials private.");
  });

  it("revalidates a committed prefix to restore an append checkpoint without trusting saved metadata", async () => {
    const path = join(root, "session.jsonl");
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "synthetic-session" } }) + "\n" + line("before", "Keep the credentials private."));
    const original = await create();
    const first = await original.scan();
    await original.confirm(first, { receiptId: "first", sourceSnapshotHash: first.sourceSnapshotHash, recordIds: first.records.map(r => r.id) });
    await appendFile(path, line("next", "Review before deploying."));
    const second = await (await create()).scan();
    const wanted = second.records[0];
    expect(wanted.context.before).toBeUndefined();
    expect(wanted.locator!.replayStart.offset).toBeGreaterThan(0);
    const read = await (await create()).readRecord(structuredClone(wanted.locator!));
    expect(read).toMatchObject({ valid: true, record: wanted, usage: { records: 3 } });
  });

  it.each(["/tmp/escape.md", "../escape.md", "deep/../notes.md", "deep//notes.md", "C:\\escape.md", "deep\\notes.md", "deep/./notes.md", "deep/notes.md\0"])("rejects an invalid relative locator %s", async relativePath => {
    const t = await markdown();
    const read = await (await create()).readRecord({ ...t.locator, relativePath });
    expect(read).toMatchObject({ valid: false, reason: "unknown_snapshot", usage: { files: 0, bytes: 0 } });
  });

  it.each(["replace", "delete", "drift", "symlink", "parent-symlink"])("rejects %s without accepting staged source text", async change => {
    const t = await markdown();
    if (change === "delete") await rm(t.path);
    else if (change === "drift") await appendFile(t.path, "Changed source.\n");
    else if (change === "parent-symlink") {
      const moved = join(temp, "moved");
      await rename(dirname(t.path), moved);
      await symlink(moved, dirname(t.path));
    } else {
      const moved = join(temp, "original.md");
      await rename(t.path, moved);
      if (change === "replace") await writeFile(t.path, await readFile(moved));
      else await symlink(moved, t.path);
    }
    expect(await (await create()).readRecord(t.locator)).toMatchObject({ valid: false, reason: "source_changed" });
  });

  it.each([{ exclude: ["deep/"] }, { include: ["other.md"] }, { outputRoots: ["OUTPUT"] }, { parser: "markdown" }, { configFingerprint: "changed" }, { scope: { ...scope, userId: "other" } }])("rejects changed host binding %j", async overrides => {
    const t = await markdown();
    const binding = { ...overrides, ...(overrides.outputRoots ? { outputRoots: [join(root, "deep")] } : {}) } as Partial<SourceBinding>;
    expect(await (await create(binding)).readRecord(t.locator)).toMatchObject({ valid: false, reason: "unknown_snapshot", usage: { files: 0 } });
  });

  it.each(["maxBytes", "maxFiles", "maxRecords", "maxDurationMs", "maxEntries", "maxDepth"] as const)("enforces %s before returning a record", async key => {
    const t = await markdown();
    const read = await (await create()).readRecord(t.locator, { limits: { [key]: 0 } });
    expect(read.valid).toBe(false);
    expect(read.reason).toMatch(/^max_/);
    expect(read.record).toBeUndefined();
  });

  it("charges Markdown lookahead and JSON metadata against the record budget", async () => {
    const t = await markdown();
    expect(await (await create()).readRecord(t.locator, { limits: { maxRecords: 1 } })).toMatchObject({ valid: false, reason: "max_records", usage: { records: 1 } });
  });

  it("rejects cancellation and forged parsing or record metadata", async () => {
    const t = await markdown();
    const controller = new AbortController(); controller.abort();
    expect(await (await create()).readRecord(t.locator, { signal: controller.signal })).toMatchObject({ valid: false, reason: "cancelled", usage: { bytes: 0, files: 0 } });
    const forged = structuredClone(t.locator);
    forged.record.digest = "0".repeat(64);
    expect(await (await create()).readRecord(forged)).toMatchObject({ valid: false, reason: "source_changed" });
    expect(await (await create()).readRecord({ ...t.locator, replayStart: { offset: 1, line: 0 } })).toMatchObject({ valid: false });
    expect(await (await create()).readRecord({ ...t.locator, parsing: { ...t.locator.parsing, maxContextChars: 0 } })).toMatchObject({ valid: false });
    expect(await (await create()).readRecord({ ...t.locator, version: 99 } as unknown as SourceRecordLocator)).toMatchObject({ valid: false });
  });

  it.each(["spanOrEventId", "contentHash", "lineStart", "lineEnd"] as const)("revalidates the locator's %s rather than silently trusting it", async key => {
    const t = await markdown();
    const forged = structuredClone(t.locator);
    if (key === "lineStart" || key === "lineEnd") forged.record[key]++;
    else forged.record[key] = "0".repeat(64);
    expect(await (await create()).readRecord(forged)).toMatchObject({ valid: false });
  });

  it.each([".mengshu/notes.md", "export/notes.md", "denied/notes.md", "deep/notes.png"])("rejects a rehashed path outside the host file policy: %s", async relativePath => {
    const t = await markdown();
    const scanner = await create({ outputRoots: [join(root, "export")], exclude: ["denied/"] });
    const current = (await scanner.scan({ limits: { maxRecords: 1 } })).records[0].locator!;
    const forged = structuredClone(current);
    forged.relativePath = relativePath;
    forged.snapshot.relativePath = relativePath;
    forged.snapshot.pathId = sha256(relativePath);
    forged.snapshotHash = snapshotHash(forged.sourceId, forged.configFingerprint, [forged.snapshot]);
    expect(await scanner.readRecord(forged)).toMatchObject({ valid: false, reason: "unknown_snapshot", usage: { files: 0, bytes: 0 } });
    expect(t.record.quote).toBeDefined();
  });

  it("enforces a nonzero byte cap while reading and rejects cancellation/deadline after opening", async () => {
    const t = await markdown();
    const capped = await (await create()).readRecord(t.locator, { limits: { maxBytes: 8 } });
    expect(capped).toMatchObject({ valid: false, reason: "max_bytes", usage: { bytes: 8 } });
    const scanner = await create();
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => { if (++calls === 3) controller.abort(); return 0; });
    expect(await scanner.readRecord(t.locator, { signal: controller.signal })).toMatchObject({ valid: false, reason: "cancelled", usage: { files: 1, bytes: 0 } });
    vi.restoreAllMocks();
    let time = -5;
    vi.spyOn(performance, "now").mockImplementation(() => time += 5);
    expect(await scanner.readRecord(t.locator, { limits: { maxDurationMs: 10 } })).toMatchObject({ valid: false, reason: "max_duration", usage: { files: 1, bytes: 0 } });
  });

  it("retains redaction, file-declared authority rejection and incomplete Markdown context", async () => {
    await writeFile(join(root, "policy.md"), '---\ntenantId: other\nauthorized: true\n---\n\n# Policy\n\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456789\n\nExcept when ' + "the exception has more conditions ".repeat(10) + "\n");
    const record = (await (await create()).scan({ limits: { maxRecords: 1, maxContextChars: 32 } })).records[0];
    const read = await (await create()).readRecord(record.locator!);
    expect(read).toMatchObject({ valid: true, record });
    expect(read.record!.context.incomplete).toBe(true);
    expect(read.record!.scope).toEqual(scope);
    expect(read.record!.authority).toBe("host_binding_only");
    expect(JSON.stringify(read)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456789");
  });

  it("does not accept a source re-verification that crosses its deadline after its last read", async () => {
    const t = await markdown();
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => ++calls >= 6 ? 100 : 0);
    expect(await t.scanner.verifySnapshot(t.report.snapshot, { maxDurationMs: 50 })).toMatchObject({ valid: false, reason: "max_duration", bytesRead: t.locator.snapshot.hashBytes });
  });

  it.each(["claude-code-jsonl", "openclaw-jsonl"] as const)("replays %s using the existing visible-content parser", async parser => {
    const message = (id: string, role: string, text: string) => parser === "claude-code-jsonl"
      ? { type: role, uuid: id, sessionId: "synthetic", message: { role, content: [{ type: "thinking", thinking: "HIDDEN" }, { type: "text", text }] } }
      : { type: "message", id, message: { role, content: [{ type: "text", text }] } };
    await writeFile(join(root, "session.jsonl"), [message("before", "user", "Keep the project boundary."), message("wanted", "assistant", "The synthetic test passed.")].map(value => JSON.stringify(value)).join("\n") + "\n");
    const record = (await (await create({ parser })).scan()).records.at(-1)!;
    const read = await (await create({ parser })).readRecord(record.locator!);
    expect(read).toMatchObject({ valid: true, record, usage: { records: 2, files: 1 } });
    expect(JSON.stringify(read)).not.toContain("HIDDEN");
  });

  it("hashes all saved prefix bytes after finding a record without parsing unrelated later records", async () => {
    await writeFile(join(root, "session.jsonl"), Array.from({ length: 200 }, (_, i) => line(`event-${i}`, `Synthetic source event ${i}: ${"bounded ".repeat(10)}`)).join(""));
    const record = (await (await create()).scan()).records[0];
    expect(record.locator!.snapshot.hashBytes).toBeGreaterThan(16 * 1024);
    const read = await (await create()).readRecord(record.locator!, { limits: { maxRecords: 1 } });
    expect(read).toMatchObject({ valid: true, record, usage: { records: 1, bytes: record.locator!.snapshot.hashBytes, files: 1 } });
  });
});
