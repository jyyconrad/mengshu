import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  JsonlRuntimeCostLedger,
  RuntimeCostLedgerCorruptError,
} from "./runtime-cost-ledger.js";
import {
  aggregateRuntimeCost,
  estimateRuntimeCost,
  fingerprintRuntimeScope,
  type RuntimeCostEvent,
  type RuntimePricingSnapshot,
} from "./runtime-cost.js";

const tempDirs: string[] = [];

async function tempLedgerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mengshu-cost-ledger-"));
  tempDirs.push(dir);
  return join(dir, "audit", "runtime-cost.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const pricing: RuntimePricingSnapshot = Object.freeze({
  version: "pricing-test-v1",
  provider: "openai",
  currency: "USD",
  minorUnitsPerMajor: 100,
  models: Object.freeze({
    "gpt-test": Object.freeze({ inputPerMillion: 2, outputPerMillion: 4 }),
    "embed-test": Object.freeze({ embeddingPerMillion: 1 }),
  }),
});

function event(overrides: Partial<RuntimeCostEvent> = {}): RuntimeCostEvent {
  return {
    version: 1,
    timestamp: "2026-08-16T01:02:03.000Z",
    operation: "llm.complete",
    category: "native_memory",
    provider: "openai",
    model: "gpt-test",
    inputTokens: 100,
    outputTokens: 20,
    embeddingUnits: null,
    embeddingUnitKind: null,
    pricingSnapshotVersion: "pricing-test-v1",
    estimatedMinorUnits: 0.028,
    currency: "USD",
    status: "succeeded",
    rejectionReason: null,
    attempt: 1,
    scopeFingerprint: fingerprintRuntimeScope({ tenantId: "tenant-a", userId: "user-a" }),
    policyResolution: null,
    ...overrides,
  };
}

describe("JsonlRuntimeCostLedger", () => {
  test("uses append-only JSONL across instances and tightens filesystem permissions", async () => {
    const path = await tempLedgerPath();
    const first = new JsonlRuntimeCostLedger(path);
    const second = new JsonlRuntimeCostLedger(path);

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).append(event({ attempt: index + 1 }))));

    const rows = await new JsonlRuntimeCostLedger(path).query();
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.attempt)).size).toBe(20);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
  });

  test("serializes only the fixed schema and never identity/content/key plaintext", async () => {
    const path = await tempLedgerPath();
    const ledger = new JsonlRuntimeCostLedger(path);
    await ledger.append({
      ...event(),
      tenantId: "tenant-plain",
      userId: "user-plain",
      text: "private body",
      apiKey: "sk-secret",
    } as RuntimeCostEvent);

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("tenant-plain");
    expect(raw).not.toContain("user-plain");
    expect(raw).not.toContain("private body");
    expect(raw).not.toContain("sk-secret");
    expect(raw).toContain("sha256:");
  });

  test("persists a fixed policy resolution receipt without policy hint plaintext", async () => {
    const path = await tempLedgerPath();
    const ledger = new JsonlRuntimeCostLedger(path);
    const scopeFingerprint = fingerprintRuntimeScope({ tenantId: "tenant-a", userId: "user-a" });
    await ledger.append(event({
      scopeFingerprint,
      category: "policy_overlay",
      policyResolution: {
        scopeFingerprint: scopeFingerprint.slice("sha256:".length),
        layer: "candidate_extraction",
        overlayId: "policy-1",
        overlayVersion: 2,
        contentHash: "b".repeat(64),
        guardVersion: "memory-policy-guard-v1",
        resolutionHash: "c".repeat(64),
      },
    }));

    const [row] = await ledger.query();
    expect(row?.policyResolution).toMatchObject({
      overlayId: "policy-1",
      overlayVersion: 2,
      contentHash: "b".repeat(64),
    });
    expect(await readFile(path, "utf8")).not.toContain("focusHints");
  });

  test("normalizes legacy v1 events without policy attribution to null", async () => {
    const path = await tempLedgerPath();
    const legacy = { ...event() } as Record<string, unknown>;
    delete legacy.policyResolution;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    await expect(new JsonlRuntimeCostLedger(path).query()).resolves.toMatchObject([
      { version: 1, policyResolution: null },
    ]);
  });

  test("fails closed and reports the exact line when JSONL is corrupt", async () => {
    const path = await tempLedgerPath();
    const ledger = new JsonlRuntimeCostLedger(path);
    await ledger.append(event());
    await writeFile(path, `${await readFile(path, "utf8")}{broken-json}\n`, { mode: 0o600 });

    await expect(ledger.query()).rejects.toMatchObject({
      name: "RuntimeCostLedgerCorruptError",
      lineNumber: 2,
    } satisfies Partial<RuntimeCostLedgerCorruptError>);
  });
});

describe("runtime cost pricing and aggregation", () => {
  test("pins the pricing version and returns unpriced for unknown models", () => {
    expect(estimateRuntimeCost(pricing, {
      provider: "openai",
      model: "gpt-test",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      embeddingUnits: null,
      embeddingUnitKind: null,
    })).toEqual({
      pricingSnapshotVersion: "pricing-test-v1",
      currency: "USD",
      estimatedMinorUnits: 400,
    });

    expect(estimateRuntimeCost(pricing, {
      provider: "openai",
      model: "unknown",
      inputTokens: 1,
      outputTokens: 1,
      embeddingUnits: null,
      embeddingUnitKind: null,
    })).toEqual({
      pricingSnapshotVersion: "pricing-test-v1",
      currency: "USD",
      estimatedMinorUnits: null,
    });
  });

  test("preserves event totals while separating failures, retries, and rejections", () => {
    const events = [
      event({ inputTokens: null, outputTokens: null, status: "failed", attempt: 1, estimatedMinorUnits: null }),
      event({ inputTokens: 100, outputTokens: 20, status: "succeeded", attempt: 2 }),
      event({ operation: "budget.reject", inputTokens: 0, outputTokens: 0, status: "rejected", rejectionReason: "daily_budget_exceeded", estimatedMinorUnits: 0 }),
      event({ category: "asset_tool", operation: "embedding.batch", model: "embed-test", inputTokens: null, outputTokens: null, embeddingUnits: 50, embeddingUnitKind: "tokens", estimatedMinorUnits: 0.005 }),
    ];

    const result = aggregateRuntimeCost(events);
    expect(result.totals).toMatchObject({
      events: 4,
      providerAttempts: 3,
      retries: 1,
      succeeded: 2,
      failed: 1,
      rejected: 1,
      inputTokens: 100,
      outputTokens: 20,
      embeddingUnits: 50,
      estimatedMinorUnits: 0.033,
      unpricedEvents: 1,
    });
    expect(result.byCategory.native_memory.events + result.byCategory.asset_tool.events)
      .toBe(result.totals.events);
  });
});
