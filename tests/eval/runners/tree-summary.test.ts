import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InMemoryTreeRepository } from "../../../packages/core/src/tree/buffer.js";
import { loadExtensionSuite } from "./extension-loaders.js";
import { runTreeSummarySuite } from "./tree-summary.js";

const fixture = path.resolve(import.meta.dirname, "../goldens/mengshu-tree-summary.jsonl");
const tempDirs: string[] = [];

function writeFixture(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-tree-summary-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tree-summary-v1 production contract", () => {
  test("8 case 全部走真实 leaf/buffer/seal，并生成非零 evidence denominator", async () => {
    const upsertLeaf = vi.spyOn(InMemoryTreeRepository.prototype, "upsertLeaf");
    const upsertSummary = vi.spyOn(InMemoryTreeRepository.prototype, "upsertSummary");

    const run = await runTreeSummarySuite(fixture);

    expect(run.total).toBe(8);
    expect(upsertLeaf).toHaveBeenCalledTimes(23);
    expect(upsertSummary).toHaveBeenCalledTimes(8);
    expect(run.results.every((result) =>
      result.productionInvocations.sealBuffer === 1 &&
      result.productionInvocations.validateFaithfulness === 1,
    )).toBe(true);
    expect(run.metrics).toEqual([
      expect.objectContaining({ name: "faithfulness", numerator: 8, denominator: 8, value: 1, passed: true }),
      expect.objectContaining({ name: "key_fact_evidence_rate", numerator: 23, denominator: 23, value: 1, passed: true }),
    ]);
  });

  test("actual key facts 仅来自 sealed extractive fragments，并引用真实 leaf/chunk", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-tree-summary");
    const run = await runTreeSummarySuite(fixture);

    for (const result of run.results) {
      const goldenCase = loaded.cases.find((item) => item.id === result.caseId)!;
      const bodies = new Set((goldenCase.leaves ?? []).flatMap((leaf) =>
        "body" in leaf ? [leaf.body] : [],
      ));
      expect(result.actual.node?.summaryMode).toBe("extractive");
      expect(result.actual.faithfulness).toMatchObject({ valid: true, usedLlmJudge: false });
      expect(result.actual.groundedExtractive).toBe(true);
      for (const fact of result.actual.structuredKeyFacts) {
        expect(bodies.has(fact.fact)).toBe(true);
        expect(fact.evidence).toHaveLength(1);
        expect(result.actual.node?.leafIds).toContain(fact.evidence[0]);
        expect(result.actual.node?.evidenceChunkIds).toContain(`eval-chunk:${fact.evidence[0]}`);
      }
    }
  });

  test("golden 与 production actual 全部匹配，contract/gate 无失败", async () => {
    const run = await runTreeSummarySuite(fixture);

    expect(run.passed).toBe(8);
    expect(run.failed).toBe(0);
    expect(run.contractIssues).toEqual([]);
    expect(run.gateFailures).toEqual([]);
    expect(run.qualityGatePassed).toBe(true);
    expect(run.componentBoundary.productionEntry).toBe(
      "appendLeafToBuffer/sealBuffer/validateFaithfulness",
    );
  });

  test("expected 被篡改时真实 actual 不回填 expected", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-tree-summary");
    const cases = loaded.cases.map((item, index) => index === 0
      ? { ...item, expected: { ...item.expected, summary: "伪造摘要" } }
      : item);

    const run = await runTreeSummarySuite(writeFixture(cases));

    expect(run.results[0]?.failures).toContain("summary:mismatch");
    expect(run.gateFailures).toContain("case_contract_failures:1");
  });

  test("旧 synthetic fold 变体仍 fail-closed，不冒充 production output", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-tree-summary");
    const cases = loaded.cases.map((item, index) => index === 0
      ? { ...item, leaves: [{ L0: "synthetic" }], expected: { folding_correct: true } }
      : item);

    const run = await runTreeSummarySuite(writeFixture(cases));

    expect(run.results[0]?.unsupportedContracts).toContain("text_leaves_required");
    expect(run.results[0]?.passed).toBe(false);
  });

  test("固定 scope/clock，连续运行完全确定", async () => {
    expect(await runTreeSummarySuite(fixture)).toEqual(await runTreeSummarySuite(fixture));
  });

  test("case 数不是 8 时拒绝", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-tree-summary");
    await expect(runTreeSummarySuite(writeFixture(loaded.cases.slice(0, 7))))
      .rejects.toThrow("expected 8 cases, got 7");
  });
});
