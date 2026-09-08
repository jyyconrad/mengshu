import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historySyntheticConnection, main, parseHistoryOperatorSpec } from "./operator-evolution-history.js";
import { HistoryArtifactReader, writeHistoryArtifactExclusive } from "../packages/core/src/evolution/history/operator-files.js";
import { historyContentSha256 } from "../packages/core/src/evolution/history/native-materials.js";

const roots: string[] = [];
const fixture = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), "history-operator-offline-"))); roots.push(root); return root; };
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("history operator offline boundary", () => {
  it("shows help without discovering config, connecting a database, or creating an output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--help"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Synthetic loopback databases only"));
  });
  it.each(["production", "historical", undefined])("rejects non-synthetic operator specifications: %s", dataClass => {
    expect(() => parseHistoryOperatorSpec({ schema: "mengshu.history-p16-operator/v1", dataClass, root: "/tmp", input: {}, projection: {} })).toThrow("HISTORY_SYNTHETIC_SPEC_REQUIRED");
  });
  it("accepts only an explicitly named loopback synthetic database", () => {
    const config = { urlEnvironment: "FIXTURE_PG_URL", expectedDatabaseName: "mengshu_history_fixture_unit" };
    expect(historySyntheticConnection(config, { FIXTURE_PG_URL: "postgres://fixture:secret@127.0.0.1/mengshu_history_fixture_unit" })).toContain("/mengshu_history_fixture_unit");
    for (const url of ["postgres://fixture:secret@db.example.test/mengshu_history_fixture_unit", "postgres://fixture:secret@localhost/mengshu", "postgres://localhost/mengshu_history_fixture_unit?host=remote", "file:///mengshu_history_fixture_unit"]) {
      expect(() => historySyntheticConnection(config, { FIXTURE_PG_URL: url })).toThrow("HISTORY_SYNTHETIC_DATABASE_REQUIRED");
    }
    expect(() => historySyntheticConnection({ ...config, expectedDatabaseName: "mengshu" }, {})).toThrow("HISTORY_SYNTHETIC_DATABASE_REQUIRED");
  });
  it("reads a hash-pinned immutable input and refuses mutation or overwrite", async () => {
    const root = await fixture(), path = join(root, "artifact.json");
    await writeHistoryArtifactExclusive(path, { synthetic: true });
    const text = await readFile(path, "utf8"), ref = { path, sha256: historyContentSha256(text) };
    expect(await new HistoryArtifactReader(root).read(ref)).toBe(text);
    await expect(writeHistoryArtifactExclusive(path, { overwrite: true })).rejects.toThrow();
    await writeFile(path, "changed");
    await expect(new HistoryArtifactReader(root).read(ref)).rejects.toThrow("HISTORY_ARTIFACT_DRIFT");
  });
  it("enforces containment, symlink rejection, and file/aggregate byte budgets", async () => {
    const root = await fixture(), text = "fixture-only", path = join(root, "fixture.txt"), ref = { path, sha256: historyContentSha256(text) };
    await writeFile(path, text);
    await symlink(path, join(root, "alias.txt"));
    await expect(new HistoryArtifactReader(root).read({ ...ref, path: "../elsewhere" })).rejects.toThrow("HISTORY_ARTIFACT_PATH_DENIED");
    await expect(new HistoryArtifactReader(root).read({ ...ref, path: "alias.txt" })).rejects.toThrow("HISTORY_ARTIFACT_SYMLINK_DENIED");
    await expect(new HistoryArtifactReader(root, 2).read(ref)).rejects.toThrow("HISTORY_ARTIFACT_READ_BUDGET");
    const files = new HistoryArtifactReader(root, 20, 20); await files.read(ref);
    await expect(files.read(ref)).rejects.toThrow("HISTORY_ARTIFACT_READ_BUDGET");
  });
  it("does not expose a supplied credential through URL rejection errors", () => {
    try { historySyntheticConnection({ urlEnvironment: "FIXTURE_PG_URL", expectedDatabaseName: "mengshu_history_fixture_unit" }, { FIXTURE_PG_URL: "postgres://fixture:private-credential@remote/mengshu_history_fixture_unit" }); }
    catch (error) { expect(String(error)).not.toContain("private-credential"); return; }
    throw new Error("expected rejection");
  });
});
