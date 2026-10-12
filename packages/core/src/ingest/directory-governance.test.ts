import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  analyzeDirectory,
  applyDirectoryScan,
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
});
