import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  analyzeDirectory,
  applyDirectoryScan,
  DIRECTORY_SCAN_MAX_FILE_BYTES,
  formatDirectoryScanReport,
  isDirectoryScanWritable,
} from "./directory-governance.js";

const apiBody = "The API base URL is https://example.test/v1 and the client retries 3 times.";
const rulesBody = "Agents must never commit API keys or tokens into the repository.";

describe("directory scan governance", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  async function fixture(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mengshu-scan-"));
    await fs.mkdir(path.join(tmpDir, "notes"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "rules"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "profile"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "bad"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "notes", "api.md"), apiBody, "utf8");
    await fs.writeFile(path.join(tmpDir, "notes", "copy-of-api.md"), apiBody, "utf8");
    await fs.writeFile(path.join(tmpDir, "rules", "policy.md"), rulesBody, "utf8");
    await fs.writeFile(
      path.join(tmpDir, "profile", "me.md"),
      "---\nsemanticType: profile\n---\nThe user prefers concise Chinese answers in this project.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "bad", "wrong.md"),
      "---\nsemanticType: memory\n---\nThis label is outside the five semantic types.\n",
      "utf8",
    );
    await fs.writeFile(path.join(tmpDir, "short.md"), "hi", "utf8");
    await fs.writeFile(path.join(tmpDir, "ignored.md"), "This file is ignored and must not be proposed.", "utf8");
    await fs.writeFile(path.join(tmpDir, "plain.txt"), "not markdown", "utf8");
    await fs.writeFile(path.join(tmpDir, ".hidden.md"), "Hidden markdown stays out unless requested.", "utf8");
    await fs.writeFile(path.join(tmpDir, "node_modules", "pkg", "readme.md"), "dependency notes", "utf8");
    return tmpDir;
  }

  test("dry-run reports 5type labels, rejections, and duplicates without a writer", async () => {
    const directory = await fixture();
    const write = vi.fn();
    const report = await analyzeDirectory({
      directory,
      ignorePaths: ["ignored.md"],
    });

    expect(write).not.toHaveBeenCalled();
    expect(report.databaseWrites).toBe(0);
    expect(report.mode).toBe("dry-run");
    expect(report.fileCount).toBe(6);
    expect(report.extensionDistribution[".md"]).toBe(6);
    expect(report.extensionDistribution[".mdx"]).toBe(0);
    expect(report.fingerprintSummary).toEqual({ unique: 5, duplicates: 1 });
    expect(report.annotationDistribution).toMatchObject({
      profile: 1,
      rules: 1,
      resource: 3,
      unlabeled: 1,
    });

    const byPath = new Map(report.proposals.map((proposal) => [proposal.relativePath, proposal]));
    expect(byPath.get("notes/api.md")).toMatchObject({
      annotatedSemanticType: "resource",
      annotationSource: "default_resource",
    });
    expect(byPath.get("rules/policy.md")?.annotatedSemanticType).toBe("rules");
    expect(byPath.get("rules/policy.md")?.semanticType).toBe("rules");
    expect(byPath.get("profile/me.md")?.admission.reasonCodes).toContain("profile_dimension_not_whitelisted");
    expect(byPath.get("bad/wrong.md")?.admission).toMatchObject({
      outcome: "skipped_invalid_type",
      reasonCodes: ["semantic_type_invalid"],
    });
    expect(byPath.get("short.md")?.admission.reasonCodes.join(" ")).toContain("text_too_short");
    expect(byPath.get("notes/copy-of-api.md")?.admission.outcome).toBe("skipped_duplicate");
    expect(byPath.get("notes/copy-of-api.md")?.duplicateOf).toBe("notes/api.md");
    expect(isDirectoryScanWritable(byPath.get("notes/api.md")!)).toBe(true);
    expect(isDirectoryScanWritable(byPath.get("rules/policy.md")!)).toBe(true);
    expect(isDirectoryScanWritable(byPath.get("profile/me.md")!)).toBe(false);
    expect(isDirectoryScanWritable(byPath.get("bad/wrong.md")!)).toBe(false);
    expect(isDirectoryScanWritable(byPath.get("short.md")!)).toBe(false);
    expect(isDirectoryScanWritable(byPath.get("notes/copy-of-api.md")!)).toBe(false);
    expect(report.semanticTypeDistribution.resource).toBe(1);
    expect(report.semanticTypeDistribution.rules).toBe(1);
    expect(report.rejectionPreview.map((item) => item.relativePath)).toEqual([
      "bad/wrong.md",
      "profile/me.md",
      "short.md",
    ]);

    const text = formatDirectoryScanReport(report);
    expect(text).toContain("Scan mode: dry-run");
    expect(text).toContain("Analyzer database writes: 0");
    expect(text).toContain("Apply: not requested");
    expect(text).toContain("Proposed semantic types:");
    expect(text).toContain("ms evolve scan --source-id");
    expect(text).toContain("P2 reads .md and .mdx only");
  });

  test("apply writes only admitted proposals and leaves the dry-run report unchanged", async () => {
    const directory = await fixture();
    const report = await analyzeDirectory({
      directory,
      ignorePaths: ["ignored.md"],
    });
    const written: string[] = [];
    const applyResult = await applyDirectoryScan(report, async (proposal) => {
      written.push(proposal.relativePath);
      return { status: "persisted", memoryId: `mem-${proposal.fingerprint.slice(0, 8)}` };
    });

    expect(written).toEqual(
      report.proposals.filter(isDirectoryScanWritable).map((proposal) => proposal.relativePath),
    );
    expect(applyResult.written).toBe(written.length);
    expect(applyResult.skipped).toBe(report.proposals.length - written.length);
    expect(report.databaseWrites).toBe(0);
    expect(formatDirectoryScanReport(report, applyResult)).toContain(`Apply: written=${written.length}`);
  });

  test("a writer failure is recorded and does not abort the rest of apply", async () => {
    const directory = await fixture();
    const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
    const applyResult = await applyDirectoryScan(report, async (proposal) => {
      if (proposal.relativePath === "notes/api.md") throw new Error("disk full");
      return { status: "rejected", reason: "admission_drop" };
    });
    expect(applyResult.errors).toBe(1);
    expect(applyResult.writerRejected).toBeGreaterThan(0);
    expect(applyResult.items.some((item) => item.reason === "disk full")).toBe(true);
  });

  test("redacts secrets before the report and before apply", async () => {
    const directory = await fixture();
    const secret = "sk-synthetickeyvalue1234567890";
    await fs.writeFile(
      path.join(directory, "notes", "leak.md"),
      `The service token is ${secret} and must not be stored in memory.`,
      "utf8",
    );
    const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
    const leak = report.proposals.find((proposal) => proposal.relativePath === "notes/leak.md");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(leak?.text).toContain("[REDACTED:api_key]");
    expect(leak?.admission.reasonCodes).toContain("secrets_redacted");
    const written: string[] = [];
    await applyDirectoryScan(report, async (proposal) => {
      written.push(proposal.text);
      return { status: "persisted" };
    });
    expect(written.join("\n")).not.toContain(secret);
  });

  test("does not read a markdown symlink that points outside the scan directory", async () => {
    const directory = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mengshu-scan-outside-"));
    const secret = "sk-outsidesymlinksecret1234567890";
    try {
      await fs.writeFile(path.join(outside, "secret.md"), `token ${secret} lives outside the scan root.`, "utf8");
      await fs.symlink(path.join(outside, "secret.md"), path.join(directory, "linked.md"));
      const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.proposals.some((proposal) => proposal.relativePath === "linked.md")).toBe(false);
      expect(report.errors).toContainEqual({
        filePath: path.join(directory, "linked.md"),
        error: "path_escapes_scan_root",
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("still reads a symlink whose target stays inside the scan directory", async () => {
    const directory = await fixture();
    await fs.symlink(path.join(directory, "rules", "policy.md"), path.join(directory, "policy-link.md"));
    const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
    const link = report.proposals.find((proposal) => proposal.relativePath === "policy-link.md");
    expect(link?.text).toBe(rulesBody);
    expect(link?.admission.outcome).not.toBeUndefined();
    expect(report.errors.some((error) => error.error === "path_escapes_scan_root")).toBe(false);
  });

  test("does not expand a scan root whose name contains glob brackets", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mengshu-scan-glob-"));
    const root = path.join(parent, "proj[ab]");
    const sibling = path.join(parent, "proja");
    const secret = "sk-globbracketsiblingsecret1234567890";
    try {
      await fs.mkdir(root);
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, "secret.md"), `token ${secret} is outside the named root.`, "utf8");
      await fs.writeFile(path.join(root, "inside.md"), "The inside note is long enough to stay a resource proposal.", "utf8");
      const report = await analyzeDirectory({ directory: root });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.proposals.some((proposal) => proposal.relativePath === "inside.md")).toBe(true);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  test("does not read a markdown file larger than the scan cap", async () => {
    const directory = await fixture();
    const huge = path.join(directory, "huge.md");
    await fs.writeFile(huge, Buffer.alloc(DIRECTORY_SCAN_MAX_FILE_BYTES + 1, 97));
    const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
    expect(report.proposals.some((proposal) => proposal.relativePath === "huge.md")).toBe(false);
    expect(report.errors).toContainEqual({ filePath: huge, error: "file_too_large" });
  });

  test("redacts secrets echoed by an apply failure", async () => {
    const directory = await fixture();
    const secret = "sk-applyerrorsecretvalue1234567890";
    const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
    const applyResult = await applyDirectoryScan(report, async () => {
      throw new Error(`disk full token ${secret}`);
    });
    expect(JSON.stringify(applyResult)).not.toContain(secret);
    expect(JSON.stringify(applyResult)).toContain("[REDACTED:api_key]");
  });

  test("does not read markdown reached through a directory symlink outside the scan root", async () => {
    const directory = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mengshu-scan-outside-dir-"));
    const secret = "sk-outsidedirsymlinksecret1234567";
    try {
      await fs.writeFile(path.join(outside, "secret.md"), `token ${secret} lives outside the scan root.`, "utf8");
      await fs.symlink(outside, path.join(directory, "outside-dir"));
      const report = await analyzeDirectory({ directory, ignorePaths: ["ignored.md"] });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.proposals.some((proposal) => proposal.relativePath.startsWith("outside-dir/"))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
