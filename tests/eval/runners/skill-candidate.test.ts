import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InMemoryCandidateRepository } from "../../../packages/core/src/lifecycle/candidate-repository.js";
import { SkillCandidateAggregator } from "../../../packages/core/src/lifecycle/skill-candidate-aggregator.js";
import { loadExtensionSuite } from "./extension-loaders.js";
import { runSkillCandidateSuite } from "./skill-candidate.js";

const fixture = path.resolve(import.meta.dirname, "../goldens/mengshu-skill-candidate.jsonl");
const tempDirs: string[] = [];

function writeFixture(cases: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-skill-candidate-"));
  tempDirs.push(dir);
  const file = path.join(dir, "fixture.jsonl");
  writeFileSync(file, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("skill-candidate-v1 production aggregator contract", () => {
  test("8 case 全部调用真实 SkillCandidateAggregator，fixture timestamps/evidence 原样入库", async () => {
    const aggregate = vi.spyOn(SkillCandidateAggregator.prototype, "runAggregation");
    const enqueue = vi.spyOn(InMemoryCandidateRepository.prototype, "enqueue");
    const loaded = loadExtensionSuite(fixture, "mengshu-skill-candidate");

    const run = await runSkillCandidateSuite(fixture);

    expect(run.total).toBe(8);
    expect(aggregate).toHaveBeenCalledTimes(8);
    expect(enqueue).toHaveBeenCalledTimes(37);
    expect(enqueue.mock.calls.map(([input]) => input.text)).toEqual(
      loaded.cases.flatMap((item) => item.experiences.map((experience) => experience.body)),
    );
    expect(enqueue.mock.calls.every(([input]) => input.evidenceIds[0] === input.id)).toBe(true);
  });

  test("真实阈值生成 6 个 pending candidate，metric denominator 非零并达门槛", async () => {
    const run = await runSkillCandidateSuite(fixture);
    const generated = run.results.filter((result) => result.actual.candidate !== null);

    expect(generated).toHaveLength(6);
    expect(generated.every((result) =>
      result.actual.candidate?.schema === "skill_candidate" &&
      result.actual.candidate.status === "pending" &&
      result.actual.executableSkill === null,
    )).toBe(true);
    expect(run.metrics).toEqual([
      expect.objectContaining({ name: "skill_candidate_only", numerator: 6, denominator: 6, value: 1, passed: true }),
      expect.objectContaining({ name: "no_executable_skill", numerator: 8, denominator: 8, value: 1, passed: true }),
    ]);
  });

  test("时间窗、evidence 与聚类结果来自 production actual", async () => {
    const run = await runSkillCandidateSuite(fixture);
    const vite = run.results.find((result) => result.caseId === "skill-001")!;
    const insufficient = run.results.find((result) => result.caseId === "skill-003")!;
    const split = run.results.find((result) => result.caseId === "skill-008")!;

    expect(vite.actual.analyses).toEqual([
      expect.objectContaining({
        topicLabel: "vite",
        evidenceCount: 5,
        timeSpanDays: 4,
        successOutcomeCount: 5,
        meetsThreshold: true,
      }),
    ]);
    expect(vite.actual.candidate).toMatchObject({
      title: "经验候选：vite",
      evidenceMemoryIds: ["e5", "e4", "e3", "e2", "e1"],
      evidenceChunkIds: ["e5", "e4", "e3", "e2", "e1"],
      confidence: 1,
    });
    expect(insufficient.actual.candidate).toBeNull();
    expect(insufficient.actual.analyses[0]).toMatchObject({ evidenceCount: 2, meetsThreshold: false });
    expect(split.actual.analyses.map((item) => item.evidenceCount).sort()).toEqual([2, 3]);
  });

  test("golden contract 与真实 aggregator 全部匹配", async () => {
    const run = await runSkillCandidateSuite(fixture);

    expect(run.passed).toBe(8);
    expect(run.failed).toBe(0);
    expect(run.contractIssues).toEqual([]);
    expect(run.gateFailures).toEqual([]);
    expect(run.qualityGatePassed).toBe(true);
    expect(run.componentBoundary.productionEntry).toBe("SkillCandidateAggregator.runAggregation");
  });

  test("expected 候选 title 被篡改时不会回填 expected", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-skill-candidate");
    const cases = loaded.cases.map((item, index) => index === 0
      ? {
          ...item,
          expected: {
            ...item.expected,
            skill_candidate: { ...item.expected.skill_candidate, title: "伪造 title" },
          },
        }
      : item);

    const run = await runSkillCandidateSuite(writeFixture(cases));

    expect(run.results[0]?.failures).toContain("skill_candidate.title:mismatch");
    expect(run.gateFailures).toContain("case_contract_failures:1");
  });

  test("缺 timestamp fixture 明确 fail-closed", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-skill-candidate");
    const cases = loaded.cases.map((item, index) => index === 0
      ? { ...item, experiences: item.experiences.map(({ createdAt: _createdAt, ...experience }) => experience) }
      : item);

    const run = await runSkillCandidateSuite(writeFixture(cases));

    expect(run.results[0]?.unsupportedContracts).toContain("createdAt_required");
    expect(run.results[0]?.passed).toBe(false);
  });

  test("固定输入连续运行语义输出确定", async () => {
    expect(await runSkillCandidateSuite(fixture)).toEqual(await runSkillCandidateSuite(fixture));
  });

  test("case 数不是 8 时拒绝", async () => {
    const loaded = loadExtensionSuite(fixture, "mengshu-skill-candidate");
    await expect(runSkillCandidateSuite(writeFixture(loaded.cases.slice(0, 7))))
      .rejects.toThrow("expected 8 cases, got 7");
  });
});
