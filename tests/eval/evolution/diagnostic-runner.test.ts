import { describe, expect, test, vi } from "vitest";
import { freezeDiagnosticDataset, runEvolutionDiagnostic, exactDiagnosticVerifier } from "./diagnostic-runner.js";
import { createSyntheticDiagnosticDataset } from "./synthetic-fixture.js";
import { createComponentDiagnosticFactory } from "./component-driver.js";
import type { DiagnosticArmFactory, DiagnosticDataset } from "./types.js";

describe("frozen evolution diagnostic runner", () => {
  test("rejects copy/summary family leakage between calibration and holdout", () => {
    const data = createSyntheticDiagnosticDataset();
    data.cases[1].partition = "calibration";
    data.cases[1].familyIds = data.cases[0].familyIds;
    expect(() => freezeDiagnosticDataset(data)).toThrow("family_split_leakage");
  });

  test("freezes all paired controls, source and oracle hashes without mutating the original input", () => {
    const data = createSyntheticDiagnosticDataset();
    const frozen = freezeDiagnosticDataset(data);
    data.cases[0].oracle.acceptedAnswers[0] = "changed";
    expect(freezeDiagnosticDataset(data).datasetFingerprint).not.toBe(frozen.datasetFingerprint);
    expect(frozen.dataset.cases[0].oracle.acceptedAnswers).not.toContain("changed");
    expect(Object.isFrozen(frozen.dataset.cases[0].material.unit)).toBe(true);
  });

  test("rejects tampered evidence and non-finite/empty frozen controls", () => {
    const data = createSyntheticDiagnosticDataset();
    data.cases[0].material.unit.evidence[0].text += " changed";
    expect(() => freezeDiagnosticDataset(data)).toThrow("source_hash_mismatch");
    const invalid = createSyntheticDiagnosticDataset();
    invalid.settings.topK = 0;
    expect(() => freezeDiagnosticDataset(invalid)).toThrow("invalid_frozen_settings");
  });

  test("never passes holdout questions or oracle to the proposer-side factory", async () => {
    const factory = createComponentDiagnosticFactory();
    const open = vi.spyOn(factory, "open");
    const dataset = createSyntheticDiagnosticDataset();
    const result = await runEvolutionDiagnostic({ dataset, factory, verifier: exactDiagnosticVerifier });
    expect(open).toHaveBeenCalledTimes(dataset.cases.length * 3);
    for (const [input] of open.mock.calls) {
      expect(input).not.toHaveProperty("question");
      expect(input).not.toHaveProperty("oracle");
      expect(JSON.stringify(input)).not.toContain("HOLDOUT_QUESTION_CANARY");
      expect(JSON.stringify(input)).not.toContain("VERIFIER_ONLY_CANARY");
    }
    expect(result).toMatchObject({ scoreAuthority: "diagnostic", formalScoreEligible: false, releaseGate: "blocked" });
    expect(result.arms.map(arm => arm.arm)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(result.comparisons)).not.toMatch(/GMS|PMS|gatePassed/);
    expect(result.arms.every(arm => arm.metrics.contextObserved < arm.metrics.totalCases)).toBe(true);
    expect(result.arms[2].metrics.cost.inputTokens.unknown).toBeGreaterThan(0);
    expect(result.blockers).toContain("synthetic_not_formal_gp");
  });

  test("unknown/unavailable stay in the denominator instead of rewarding all-abstain precision", async () => {
    const factory = createComponentDiagnosticFactory();
    const base = factory.open.bind(factory);
    factory.open = async input => {
      const session = await base(input);
      session.answer = async () => ({ status: "abstained", evidenceIds: [], injected: null,
        cost: { llmCalls: 0, inputTokens: null, outputTokens: null, embeddingCalls: 0, bytesRead: 0, databaseBytesDelta: null, costUsd: null } });
      return session;
    };
    const report = await runEvolutionDiagnostic({ dataset: createSyntheticDiagnosticDataset(), factory, verifier: exactDiagnosticVerifier });
    for (const { metrics } of report.arms) {
      expect(metrics.answerCoverage).toBe(0);
      expect(metrics.answeredPrecision).toBeNull();
      expect(metrics.abstained).toBe(metrics.totalCases);
      expect(metrics.successRateAllCases).toBeLessThan(1);
      expect(metrics.unknownVerdicts).toBe(0);
    }
  });

  test("reviewed and auto are separate cohorts; missing native owner review remains blocked", async () => {
    const data = createSyntheticDiagnosticDataset();
    const factory = createComponentDiagnosticFactory();
    const open = vi.spyOn(factory, "open");
    const report = await runEvolutionDiagnostic({ dataset: data, factory, verifier: exactDiagnosticVerifier, governanceMode: "reviewed" });
    expect(report.governanceMode).toBe("reviewed");
    expect(report.arms[2].metrics.blocked).toBe(data.cases.length);
    expect(report.arms[2].cases.every(result => result.evolution?.governance.reviewedApplied === 0)).toBe(true);
    for (const [input] of open.mock.calls) {
      expect(input.governanceMode).toBe("reviewed");
      expect(input).not.toHaveProperty("oracle");
      expect(input.isolationKey).toContain(":reviewed:");
    }
  });

  test("a driver cannot label reviewed writes as auto or claim approval without source-diff-only policy", async () => {
    const factory = createComponentDiagnosticFactory();
    const base = factory.open.bind(factory);
    factory.open = async input => {
      const session = await base(input);
      const evolve = session.evolve.bind(session);
      session.evolve = async () => ({ ...await evolve(), canonicalWrites: 1,
        governance: { mode: "auto", autoApplied: 0, reviewedApplied: 1, reviewDecisionBasis: "not-requested" } });
      return session;
    };
    const result = await runEvolutionDiagnostic({ dataset: createSyntheticDiagnosticDataset(), factory, verifier: exactDiagnosticVerifier });
    expect(result.arms.every(arm => arm.metrics.failed === arm.metrics.totalCases)).toBe(true);
  });

  test("a failing arm is retained in paired results, redacted and all opened sessions close", async () => {
    const component = createComponentDiagnosticFactory();
    const closes = vi.fn();
    const factory: DiagnosticArmFactory = { ...component, open: async input => {
      const session = await component.open(input);
      const close = session.close.bind(session);
      session.close = async () => { closes(); await close(); };
      if (input.arm === "C") session.evolve = async () => { throw new Error("raw-secret-do-not-log"); };
      return session;
    } };
    const data = createSyntheticDiagnosticDataset();
    const report = await runEvolutionDiagnostic({ dataset: data, factory, verifier: exactDiagnosticVerifier });
    expect(closes).toHaveBeenCalledTimes(data.cases.length * 3);
    expect(report.arms[2].metrics.failed).toBe(data.cases.length);
    expect(report.comparisons.every(pair => pair.caseCount === data.cases.length)).toBe(true);
    expect(report.blockers).toContain("execution_failures");
    expect(JSON.stringify(report)).not.toContain("raw-secret");
  });

  test("rejects reused arm isolation and changed runtime model/config fingerprint", async () => {
    for (const mutate of ["isolation", "freeze"] as const) {
      const factory = createComponentDiagnosticFactory();
      const base = factory.open.bind(factory);
      factory.open = async input => {
        const session = await base(input);
        if (mutate === "isolation") session.isolationKey = "shared-database";
        else session.freezeFingerprint = "changed-config";
        return session;
      };
      const report = await runEvolutionDiagnostic({ dataset: createSyntheticDiagnosticDataset(), factory, verifier: exactDiagnosticVerifier });
      expect(report.arms.every(arm => arm.metrics.failed === arm.metrics.totalCases)).toBe(true);
      expect(report.blockers).toContain("execution_failures");
    }
  });

  test("distinct labels cannot disguise a shared concrete schema, and telemetry with an unknown stage is not zero", async () => {
    const data = createSyntheticDiagnosticDataset();
    data.cases = [data.cases[0]];
    const factory = createComponentDiagnosticFactory();
    const open = factory.open.bind(factory);
    factory.open = async input => {
      const session = await open(input);
      session.storageIdentity = "one-actual-shared-schema";
      const evolve = session.evolve.bind(session);
      session.evolve = async () => {
        const result = await evolve();
        result.cost.inputTokens = 17;
        return result;
      };
      return session;
    };
    const report = await runEvolutionDiagnostic({ dataset: data, factory, verifier: exactDiagnosticVerifier });
    expect(report.arms.map(arm => arm.metrics.failed)).toEqual([0, 1, 1]);
    expect(report.arms[0].metrics.cost.inputTokens).toMatchObject({ knownTotal: 17, partiallyMeasured: 1, unknown: 1, completeTotal: null });
    expect(report.blockers).toContain("execution_failures");
  });

  test("independent verifier flags stale, foreign-scope and evidence-free context", () => {
    const data: DiagnosticDataset = createSyntheticDiagnosticDataset();
    const c = data.cases[0];
    const result = exactDiagnosticVerifier.verify({ question: c.question, oracle: c.oracle, observation: {
      status: "answered", text: c.oracle.acceptedAnswers[0], evidenceIds: ["fabricated"],
      injected: [{ id: "foreign", text: "A stale assertion", scope: { ...c.question.scope, userId: "outsider" },
        evidenceIds: ["fabricated"], validTo: c.question.asOf - 1 }],
      cost: { llmCalls: 0, inputTokens: 0, outputTokens: 0, embeddingCalls: 0, bytesRead: 0, databaseBytesDelta: 0, costUsd: 0 },
    } });
    expect(result).toMatchObject({ answerCorrect: false, injectedError: true, fidelity: false });
    expect(result.reasons).toEqual(expect.arrayContaining(["scope_injection", "stale_injection", "unsupported_evidence"]));
  });
});
