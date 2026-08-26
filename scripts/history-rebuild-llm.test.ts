import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import type { HistoryRebuildScanRow } from
  "../packages/core/src/db/migrations/history-rebuild.js";
import type { HistoryRebuildManifest } from "./operator-history-rebuild.js";
import {
  deriveHistoryRebuildLlmPins,
  HistoryRebuildLlmPlannerError,
  runHistoryRebuildLlmPlanner,
  type HistoryRebuildLlmAttemptIdentity,
  type HistoryRebuildLlmDurableAttemptResult,
  type HistoryRebuildLlmPlannerDependencies,
} from "./history-rebuild-llm.js";

const manifest = {
  version: 1, migrationId: "history-rebuild-llm-v1", requiredSchemaVersion: 23,
  source: { snapshotSha256: "1".repeat(64), sourceCount: 2, parserVersions: ["codex-v1"] },
  funnel: { mappingVersion: "kind-to-semantic-type/v1", conflictPolicy: "lookup_only", lifecyclePolicy: "preserve" },
  models: {
    extraction: { provider: "openai-compatible", baseURL: "https://model.test/v1", model: "extract-v1", promptPolicyVersion: "history-extract-v1", temperature: 0 },
    embedding: { provider: "openai-compatible", baseURL: "https://model.test/v1", model: "BAAI/bge-m3", dimensions: 1024, normalization: "l2" },
  },
  budget: { maxRecords: 10, maxModelCalls: 2, maxInputTokens: 10_000, maxOutputTokens: 1_000, maxCostMinorUnits: 100, currency: "CNY", pricingSnapshotVersion: "pricing-v1", inputCostPerMillionTokens: 100, outputCostPerMillionTokens: 300 },
  security: { remoteEgress: "redacted-only", redactionMapVersion: "redaction-v1", logContent: "hash-only", receiptContent: "hash-only" },
  tree: { policyVersion: "tree-v1", topicLabelVersion: "topic-v1", requireEvidence: true, requireSealed: true, ambiguousPolicy: "quarantine" },
} as const satisfies HistoryRebuildManifest;

function row(recordId: string, kind: HistoryRebuildScanRow["kind"]): HistoryRebuildScanRow {
  return {
    sourceTable: "memories", recordId,
    sourceHash: createHash("sha256").update(recordId).digest("hex"),
    text: `secret source ${recordId}`, kind, metadata: {}, lifecycleStatus: "active",
    scope: { tenantId: "tenant", userId: "user", appId: "codex", projectId: "project", agentId: "agent", namespace: "memory", visibility: "private" },
    evidenceIds: ["evidence-1"],
  };
}

function deps(response?: unknown) {
  const extractStructured = vi.fn<HistoryRebuildLlmPlannerDependencies["llm"]["extractStructured"]>(async () => response ?? ({
    recordId: "fact-1", sourceHash: createHash("sha256").update("fact-1").digest("hex"), semanticType: "experience",
    topicLabels: ["Migration Safety"], confidence: 0.91,
  }));
  const checkpoint = vi.fn(async () => undefined);
  const attempts = new Map<string,
    | { state: "reserved" }
    | { state: "completed"; result: HistoryRebuildLlmDurableAttemptResult }
  >();
  const attemptKey = (input: HistoryRebuildLlmAttemptIdentity) => [
    input.migrationId, input.manifestHash, input.runId, input.sourceTable,
    input.recordId, input.sourceHash, input.attempt, input.modelFingerprint,
    input.promptHash, input.schemaHash, input.inputHash,
  ].join("\0");
  const reserve = vi.fn<HistoryRebuildLlmPlannerDependencies["attempts"]["reserve"]>(async (input) => {
    const key = attemptKey(input);
    const existing = attempts.get(key);
    if (existing?.state === "completed") return { state: "completed" as const, result: existing.result };
    if (existing) return { state: "in_flight_or_unknown" as const };
    attempts.set(key, { state: "reserved" });
    return { state: "reserved" as const };
  });
  const complete = vi.fn<HistoryRebuildLlmPlannerDependencies["attempts"]["complete"]>(async (input) => {
    const key = attemptKey(input);
    const existing = attempts.get(key);
    if (existing?.state !== "reserved") throw new Error("attempt completion drift");
    attempts.set(key, { state: "completed", result: input.result });
  });
  return {
    extractStructured,
    checkpoint,
    attempts,
    reserve,
    complete,
    value: {
      llm: { available: true, extractStructured },
      redactor: { version: "redaction-v1", redact: (text: string) => ({ text: text.replace("secret", "[REDACTED]"), redactedCount: 1 }) },
      estimateTokens: (text: string) => Math.ceil(text.length / 4),
      estimateCostMinorUnits: (input: number, output: number) => Math.ceil((input + output) / 100),
      attempts: { reserve, complete },
      checkpoint,
      wait: vi.fn(async () => undefined),
    },
  };
}

describe("history rebuild live LLM planner", () => {
  test("derives domain-separated run pins from model, prompt and schema inputs", () => {
    const baseline = deriveHistoryRebuildLlmPins(manifest);
    const changedModel = deriveHistoryRebuildLlmPins({
      ...manifest,
      models: {
        ...manifest.models,
        extraction: { ...manifest.models.extraction, model: "extract-v2" },
      },
    });
    const changedPrompt = deriveHistoryRebuildLlmPins({
      ...manifest,
      models: {
        ...manifest.models,
        extraction: { ...manifest.models.extraction, promptPolicyVersion: "history-extract-v2" },
      },
    });
    const changedSchema = deriveHistoryRebuildLlmPins({
      ...manifest,
      source: { ...manifest.source, parserVersions: ["codex-v2"] },
    });
    expect(Object.values(baseline)).toSatisfy((values: string[]) =>
      values.every((value) => /^[0-9a-f]{64}$/.test(value)));
    expect(changedModel).toMatchObject({
      promptHash: baseline.promptHash,
      schemaHash: baseline.schemaHash,
    });
    expect(changedModel.modelFingerprint).not.toBe(baseline.modelFingerprint);
    expect(changedPrompt.promptHash).not.toBe(baseline.promptHash);
    expect(changedSchema.schemaHash).not.toBe(baseline.schemaHash);
  });

  test("calls the model only for deterministic unresolved rows with a strict identity-bound schema", async () => {
    const fake = deps();
    const result = await runHistoryRebuildLlmPlanner({
      rows: [{ ...row("decision-1", "decision"), topicLabels: ["release"] }, row("fact-1", "fact")],
      manifest, manifestSha256: "b".repeat(64),
    }, fake.value);

    expect(fake.extractStructured).toHaveBeenCalledOnce();
    const [messages, schema, options] = fake.extractStructured.mock.calls[0]!;
    expect(JSON.stringify(messages)).toContain("[REDACTED]");
    expect(JSON.stringify(messages)).not.toContain("secret source");
    expect(schema).toMatchObject({
      type: "object", additionalProperties: false,
      required: ["recordId", "sourceHash", "semanticType", "topicLabels", "confidence"],
    });
    expect(options).toMatchObject({ modelType: "extraction" });
    expect(result.plans).toHaveLength(2);
    expect(result.plans[0]).toMatchObject({ disposition: "backfill", reason: "deterministic_kind_mapping" });
    expect(result.plans[1]).toMatchObject({ semanticType: "experience", treeEligibility: { global: false } });
    expect(result.receipts[0]).toMatchObject({ recordId: "fact-1", sourceHash: createHash("sha256").update("fact-1").digest("hex") });
    expect(JSON.stringify(result.receipts)).not.toMatch(/secret source|\[REDACTED\]|tenant|project/);
    expect(fake.checkpoint).toHaveBeenCalledOnce();
  });

  test("uses the model for label-only enrichment without allowing it to change deterministic 5-type", async () => {
    const decision = row("decision-1", "decision");
    const fake = deps({
      recordId: decision.recordId,
      sourceHash: decision.sourceHash,
      semanticType: "rules",
      topicLabels: ["Release Safety"],
      confidence: 0.93,
    });
    const result = await runHistoryRebuildLlmPlanner({
      rows: [decision], manifest, manifestSha256: "b".repeat(64),
    }, fake.value);
    expect(fake.extractStructured).toHaveBeenCalledOnce();
    expect(result.plans[0]).toMatchObject({
      disposition: "backfill",
      reason: "deterministic_kind_mapping",
      semanticType: "rules",
      topicLabels: ["release-safety"],
      treeEligibility: { source: true, topic: true, global: false },
    });
    const request = JSON.parse(fake.extractStructured.mock.calls[0]![0].at(-1)!.content);
    expect(request).toMatchObject({
      mode: "topic_label_only",
      requiredSemanticType: "rules",
    });
    expect(result.receipts[0]).toMatchObject({
      ...deriveHistoryRebuildLlmPins(manifest),
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      confidence: 0.93,
      proposalCount: 1,
      planReceiptHash: result.plans[0]!.receiptHash,
    });
    expect(decision.topicLabels).toBeUndefined();
    expect(result.receipts).toHaveLength(1);
  });

  test.each([
    ["rules", "decision"],
    ["task_context", "task"],
    ["resource", "document"],
    ["experience", "observation"],
  ] as const)(
    "rejects topic-label-only enrichment that changes fixed %s 5-type",
    async (semanticType, kind) => {
      const source = semanticType === "experience"
        ? { ...row(`${semanticType}-1`, kind), metadata: { semanticType } }
        : row(`${semanticType}-1`, kind);
      const fake = deps({
        recordId: source.recordId,
        sourceHash: source.sourceHash,
        semanticType: semanticType === "rules" ? "task_context" : "rules",
        topicLabels: ["forbidden-reclassification"],
        confidence: 0.95,
      });
      await expect(runHistoryRebuildLlmPlanner({
        rows: [source],
        manifest: { ...manifest, budget: { ...manifest.budget, maxModelCalls: 3 } },
        manifestSha256: "b".repeat(64),
      }, fake.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_PROVIDER_FAILED" });
      expect(fake.extractStructured).toHaveBeenCalledTimes(2);
      expect(fake.checkpoint).not.toHaveBeenCalled();
    },
  );

  test("profile is fixed and never sent to topic-label enrichment", async () => {
    const profile = row("profile-1", "preference");
    const fake = deps();
    const result = await runHistoryRebuildLlmPlanner({
      rows: [profile], manifest, manifestSha256: "b".repeat(64),
    }, fake.value);
    expect(fake.extractStructured).not.toHaveBeenCalled();
    expect(result.plans[0]).toMatchObject({ semanticType: "profile", topicLabels: [] });
    expect(result.receipts).toEqual([]);
  });

  test("rejects duplicate frozen identities before model calls or receipts", async () => {
    const duplicate = row("fact-1", "fact");
    const fake = deps();
    await expect(runHistoryRebuildLlmPlanner({
      rows: [duplicate, { ...duplicate }], manifest, manifestSha256: "b".repeat(64),
    }, fake.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_INVALID_INPUT" });
    expect(fake.extractStructured).not.toHaveBeenCalled();
    expect(fake.checkpoint).not.toHaveBeenCalled();
  });

  test.each([
    {
      topicLabels: ["valid-topic"],
      extra: "schema-bypass",
    },
    {
      topicLabels: [42],
    },
    {
      topicLabels: Array.from({ length: 17 }, (_, index) => `topic-${index}`),
    },
  ])("rejects malformed topic-only output after the single schema retry", async (override) => {
    const decision = row("decision-1", "decision");
    const fake = deps({
      recordId: decision.recordId,
      sourceHash: decision.sourceHash,
      semanticType: "rules",
      confidence: 0.95,
      ...override,
    });
    await expect(runHistoryRebuildLlmPlanner({
      rows: [decision], manifest, manifestSha256: "b".repeat(64),
    }, fake.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_PROVIDER_FAILED" });
    expect(fake.extractStructured).toHaveBeenCalledTimes(2);
    expect(fake.checkpoint).not.toHaveBeenCalled();
  });

  test("retries invalid structured output and checkpoints only accepted model suggestions", async () => {
    const fake = deps();
    fake.extractStructured
      .mockResolvedValueOnce({ recordId: "wrong", sourceHash: "c".repeat(64), semanticType: "rules", topicLabels: [], confidence: 1 })
      .mockResolvedValueOnce({ recordId: "fact-1", sourceHash: createHash("sha256").update("fact-1").digest("hex"), semanticType: "rules", topicLabels: [], confidence: 0.9 });
    const result = await runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
    }, fake.value);
    expect(fake.extractStructured).toHaveBeenCalledTimes(2);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      proposalCount: 2,
      usage: {
        modelCalls: 2,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costMinorUnits: result.usage.costMinorUnits,
      },
    });
  });

  test("runs bounded model enrichment concurrently while preserving frozen row order", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const extractStructured = vi.fn<
      HistoryRebuildLlmPlannerDependencies["llm"]["extractStructured"]
    >();
    extractStructured.mockImplementation(async (messages) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      const request = JSON.parse(messages.at(-1)!.content) as {
        identity: { recordId: string; sourceHash: string };
      };
      return {
        ...request.identity,
        semanticType: "experience",
        topicLabels: [`topic-${request.identity.recordId}`],
        confidence: 0.95,
      };
    });
    const checkpoint = vi.fn<HistoryRebuildLlmPlannerDependencies["checkpoint"]>(
      async () => undefined,
    );
    const operation = runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact"), row("fact-2", "fact")],
      manifest,
      manifestSha256: "b".repeat(64),
    }, {
      ...deps().value,
      concurrency: 2,
      llm: { available: true, extractStructured },
      checkpoint,
    });

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.forEach((release) => release());
    const result = await operation;

    expect(maxActive).toBe(2);
    expect(result.plans.map((plan) => plan.recordId)).toEqual(["fact-1", "fact-2"]);
    expect(result.receipts.map((receipt) => receipt.recordId)).toEqual(["fact-1", "fact-2"]);
    expect(checkpoint.mock.calls.map(([value]) => value.afterIndex)).toEqual([1, 2]);
  });

  test("charges an unresolved reservation and continues with the next durable attempt", async () => {
    const fake = deps();
    fake.reserve.mockImplementationOnce(async () => ({ state: "retry_next_attempt" as const }));

    const result = await runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
    }, fake.value);

    expect(fake.reserve.mock.calls.map(([input]) => input.attempt)).toEqual([0, 1]);
    expect(fake.extractStructured).toHaveBeenCalledOnce();
    expect(fake.complete).toHaveBeenCalledOnce();
    expect(result.plans[0]).toMatchObject({ reason: "model_classification_accepted" });
    expect(result.receipts[0]?.proposalCount).toBe(1);
  });

  test("falls back to lookup-only after every durable attempt identity is unresolved", async () => {
    const fake = deps();
    fake.reserve.mockResolvedValue({ state: "retry_next_attempt" as const });

    const result = await runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
    }, fake.value);

    expect(fake.reserve.mock.calls.map(([input]) => input.attempt)).toEqual([0, 1]);
    expect(fake.extractStructured).not.toHaveBeenCalled();
    expect(fake.complete).not.toHaveBeenCalled();
    expect(result.plans[0]).toMatchObject({
      disposition: "lookup_only",
      reason: "model_attempts_exhausted",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
    });
    expect(result.receipts).toEqual([]);
  });

  test("live model remains advisory and confidence below 0.85 cannot become context/tree eligible", async () => {
    const fake = deps({
      recordId: "fact-1",
      sourceHash: createHash("sha256").update("fact-1").digest("hex"),
      semanticType: "rules",
      topicLabels: ["sensitive-rule"],
      confidence: 0.849999,
    });
    const result = await runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
    }, fake.value);
    expect(result.plans[0]).toMatchObject({
      disposition: "lookup_only",
      reason: "model_confidence_below_threshold",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      confidence: result.plans[0]!.modelConfidence,
      planReceiptHash: result.plans[0]!.receiptHash,
      ...deriveHistoryRebuildLlmPins(manifest),
    });
  });

  test("fails closed before remote calls for deny egress, checkpoint drift, unavailable model or budget exhaustion", async () => {
    const fake = deps();
    await expect(runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")],
      manifest: { ...manifest, security: { ...manifest.security, remoteEgress: "deny" } },
      manifestSha256: "b".repeat(64),
    }, fake.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_EGRESS_DENIED" });
    expect(fake.extractStructured).not.toHaveBeenCalled();

    await expect(runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
      checkpoint: { version: 1, manifestSha256: "c".repeat(64), sourceBatchSha256: "d".repeat(64), afterIndex: 0, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMinorUnits: 0 }, receiptHashes: [] },
    }, fake.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_CHECKPOINT_MISMATCH" });

    const unavailable = deps();
    unavailable.value.llm.available = false;
    await expect(runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
    }, unavailable.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_UNAVAILABLE" });

    const exhausted = deps();
    await expect(runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")],
      manifest: { ...manifest, budget: { ...manifest.budget, maxModelCalls: 0 } },
      manifestSha256: "b".repeat(64),
    }, exhausted.value)).rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_BUDGET_EXCEEDED" });
  });

  test("sanitizes provider failures without exposing source or provider details", async () => {
    const fake = deps();
    fake.extractStructured.mockRejectedValue(new Error("429 secret source api-key-value"));
    let failure: unknown;
    try {
      await runHistoryRebuildLlmPlanner({
        rows: [row("fact-1", "fact")],
        manifest: { ...manifest, budget: { ...manifest.budget, maxModelCalls: 3 } },
        manifestSha256: "b".repeat(64),
      }, fake.value);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HistoryRebuildLlmPlannerError);
    expect(failure).toMatchObject({ code: "HISTORY_REBUILD_LLM_ATTEMPT_UNRESOLVED" });
    expect((failure as Error).message).not.toMatch(/secret source|api-key-value/);
  });

  test("replays a completed durable attempt after a crash without a second provider call", async () => {
    const fake = deps();
    const crash = new Error("crash-after-durable-result");
    await expect(runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
      runId: "run-fact-1",
    }, {
      ...fake.value,
      afterAttemptCompleted: vi.fn(async () => { throw crash; }),
    })).rejects.toBe(crash);
    expect(fake.extractStructured).toHaveBeenCalledOnce();
    expect(fake.complete).toHaveBeenCalledOnce();

    const replay = await runHistoryRebuildLlmPlanner({
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
      runId: "run-fact-1",
    }, fake.value);
    expect(fake.extractStructured).toHaveBeenCalledOnce();
    expect(replay.plans[0]).toMatchObject({ semanticType: "experience" });
    expect(replay.receipts).toHaveLength(1);
    expect(replay.usage.modelCalls).toBe(1);
  });

  test("fails closed on an unknown provider outcome and never retries that durable attempt", async () => {
    const fake = deps();
    fake.extractStructured.mockRejectedValue(new Error("timeout after provider accepted request"));
    const input = {
      rows: [row("fact-1", "fact")],
      manifest: { ...manifest, budget: { ...manifest.budget, maxModelCalls: 3 } },
      manifestSha256: "b".repeat(64),
      runId: "run-fact-1",
    } as const;

    await expect(runHistoryRebuildLlmPlanner(input, fake.value))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_ATTEMPT_UNRESOLVED" });
    await expect(runHistoryRebuildLlmPlanner(input, fake.value))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_ATTEMPT_UNRESOLVED" });
    expect(fake.extractStructured).toHaveBeenCalledOnce();
  });

  test("permits only one actual egress when two planners race for the same attempt", async () => {
    const fake = deps();
    let release: (() => void) | undefined;
    fake.extractStructured.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        recordId: "fact-1", sourceHash: createHash("sha256").update("fact-1").digest("hex"),
        semanticType: "experience", topicLabels: ["migration-safety"], confidence: 0.91,
      };
    });
    const input = {
      rows: [row("fact-1", "fact")], manifest, manifestSha256: "b".repeat(64),
      runId: "run-fact-1",
    } as const;
    const first = runHistoryRebuildLlmPlanner(input, fake.value);
    await vi.waitFor(() => expect(fake.extractStructured).toHaveBeenCalledOnce());
    await expect(runHistoryRebuildLlmPlanner(input, fake.value))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_LLM_ATTEMPT_UNRESOLVED" });
    release?.();
    await expect(first).resolves.toMatchObject({ usage: { modelCalls: 1 } });
    expect(fake.extractStructured).toHaveBeenCalledOnce();
  });
});
