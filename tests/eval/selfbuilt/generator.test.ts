import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  buildSelfBuiltManifest,
  generateSelfBuiltCases,
  serializeSelfBuiltCases,
} from "./generator.js";

const registry = JSON.parse(readFileSync(
  path.resolve(import.meta.dirname, "registry.json"), "utf8",
)) as {
  targetCaseCount: number;
  casesPerCapability: number;
  casesPerScenario: number;
  casesPerCapabilityScenario: number;
  devCasesPerCapabilityScenario: number;
  capabilities: string[];
  scenarios: string[];
};

describe("self-built deterministic dataset generator", () => {
  test("produces the exact two-dimensional quota with deterministic ids and content", () => {
    const first = generateSelfBuiltCases();
    const second = generateSelfBuiltCases();

    expect(first).toEqual(second);
    expect(first).toHaveLength(registry.targetCaseCount);
    expect(new Set(first.map((item) => item.id))).toHaveLength(first.length);
    for (const capability of registry.capabilities) {
      expect(first.filter((item) => item.capability === capability)).toHaveLength(
        registry.casesPerCapability,
      );
      for (const scenario of registry.scenarios) {
        const cell = first.filter((item) => item.capability === capability &&
          item.scenario === scenario);
        expect(cell).toHaveLength(registry.casesPerCapabilityScenario);
        expect(cell.filter((item) => item.split === "dev")).toHaveLength(
          registry.devCasesPerCapabilityScenario,
        );
      }
    }
    for (const scenario of registry.scenarios) {
      expect(first.filter((item) => item.scenario === scenario)).toHaveLength(
        registry.casesPerScenario,
      );
    }
  });

  test("freezes a hash-addressed manifest without claiming GMS, PMS, or formal release status", () => {
    const cases = generateSelfBuiltCases();
    const jsonl = serializeSelfBuiltCases(cases);
    const manifest = buildSelfBuiltManifest(cases, jsonl);

    expect(manifest).toMatchObject({
      schemaVersion: "mengshu.selfbuilt-dataset/v1",
      datasetId: "mengshu-selfbuilt-v1",
      status: "frozen",
      sourceType: "deterministic-synthetic",
      scoreAuthority: "selfbuilt-diagnostic",
      formalReleaseEligible: false,
      caseCount: 360,
      splitCounts: { dev: 72, test: 288 },
    });
    expect(manifest.casesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(jsonl).not.toMatch(/LongMemEval|LoCoMo|MemoryAgentBench/);
  });

  test("covers every governance risk with explicit forbidden evidence", () => {
    const cases = generateSelfBuiltCases();
    for (const scenario of ["temporal-update", "scope-isolation", "lifecycle-block"] as const) {
      const selected = cases.filter((item) => item.scenario === scenario);
      expect(selected.every((item) => item.gold.forbiddenEvidenceRefs.length > 0)).toBe(true);
    }
    expect(cases.filter((item) => item.query.expectedMode === "abstain")).toHaveLength(60);
    expect(cases.filter((item) => item.scenario === "hydration-fallback")
      .every((item) => item.memoryStream.some((event) => event.hydrationState === "unavailable")))
      .toBe(true);
  });
});
