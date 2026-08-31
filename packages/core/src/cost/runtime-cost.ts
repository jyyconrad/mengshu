import { createHash } from "node:crypto";

export const RUNTIME_COST_EVENT_VERSION = 1 as const;

export const RUNTIME_COST_CATEGORIES = [
  "native_memory",
  "session_summary",
  "task_outline",
  "skill_review",
  "policy_overlay",
  "asset_promotion",
  "prewarm",
  "asset_tool",
  "operator",
  "unknown",
] as const;

export type RuntimeCostCategory = typeof RUNTIME_COST_CATEGORIES[number];
export type RuntimeCostStatus = "succeeded" | "failed" | "rejected";
export type EmbeddingUnitKind = "tokens" | "inputs";

export type RuntimeCostPolicyLayer =
  | "candidate_extraction"
  | "tree_summary"
  | "skill_review"
  | "document_organization";

/** Fixed, content-free projection of a policy resolution receipt. */
export interface RuntimeCostPolicyResolution {
  readonly scopeFingerprint: string;
  readonly layer: RuntimeCostPolicyLayer;
  readonly overlayId?: string;
  readonly overlayVersion?: number;
  readonly contentHash?: string;
  readonly guardVersion: "memory-policy-guard-v1";
  readonly resolutionHash: string;
}

export interface RuntimeCostContext {
  category: RuntimeCostCategory;
  scopeFingerprint: string;
  operation?: string;
  policyResolution?: RuntimeCostPolicyResolution;
}

export interface RuntimeCostEvent {
  version: typeof RUNTIME_COST_EVENT_VERSION;
  timestamp: string;
  operation: string;
  category: RuntimeCostCategory;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  embeddingUnits: number | null;
  embeddingUnitKind: EmbeddingUnitKind | null;
  pricingSnapshotVersion: string;
  estimatedMinorUnits: number | null;
  currency: string;
  status: RuntimeCostStatus;
  rejectionReason: string | null;
  attempt: number;
  scopeFingerprint: string;
  policyResolution: RuntimeCostPolicyResolution | null;
}

export interface RuntimeCostEventSink {
  append(event: RuntimeCostEvent): Promise<void>;
}

export interface RuntimeCostLedger extends RuntimeCostEventSink {
  query(): Promise<readonly RuntimeCostEvent[]>;
}

export interface RuntimeModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  embeddingPerMillion?: number;
}

export interface RuntimePricingSnapshot {
  version: string;
  provider: string;
  currency: string;
  minorUnitsPerMajor: number;
  models: Readonly<Record<string, Readonly<RuntimeModelPricing>>>;
}

export const UNPRICED_RUNTIME_PRICING_SNAPSHOT: RuntimePricingSnapshot = Object.freeze({
  version: "unpriced-v1",
  provider: "unknown",
  currency: "XXX",
  minorUnitsPerMajor: 100,
  models: Object.freeze({}),
});

export const UNSCOPED_RUNTIME_COST_FINGERPRINT =
  `sha256:${createHash("sha256").update("mengshu:runtime-cost:unscoped:v1").digest("hex")}`;

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Scope plaintext never leaves this function. */
export function fingerprintRuntimeScope(scope: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(scope)).digest("hex")}`;
}

export interface RuntimeCostUsage {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  embeddingUnits: number | null;
  embeddingUnitKind: EmbeddingUnitKind | null;
}

export interface RuntimeCostEstimate {
  pricingSnapshotVersion: string;
  currency: string;
  estimatedMinorUnits: number | null;
}

function finiteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundMinorUnits(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function estimateRuntimeCost(
  snapshot: RuntimePricingSnapshot,
  usage: RuntimeCostUsage,
): RuntimeCostEstimate {
  const modelPricing = snapshot.provider === usage.provider
    ? snapshot.models[usage.model]
    : undefined;
  if (!modelPricing) {
    return {
      pricingSnapshotVersion: snapshot.version,
      currency: snapshot.currency,
      estimatedMinorUnits: null,
    };
  }

  let majorUnits = 0;
  let hasBillableUsage = false;
  if (usage.inputTokens !== null) {
    if (!finiteNonNegative(modelPricing.inputPerMillion)) {
      return { pricingSnapshotVersion: snapshot.version, currency: snapshot.currency, estimatedMinorUnits: null };
    }
    majorUnits += usage.inputTokens / 1_000_000 * modelPricing.inputPerMillion;
    hasBillableUsage = true;
  }
  if (usage.outputTokens !== null) {
    if (!finiteNonNegative(modelPricing.outputPerMillion)) {
      return { pricingSnapshotVersion: snapshot.version, currency: snapshot.currency, estimatedMinorUnits: null };
    }
    majorUnits += usage.outputTokens / 1_000_000 * modelPricing.outputPerMillion;
    hasBillableUsage = true;
  }
  if (usage.embeddingUnits !== null) {
    if (usage.embeddingUnitKind !== "tokens" || !finiteNonNegative(modelPricing.embeddingPerMillion)) {
      return { pricingSnapshotVersion: snapshot.version, currency: snapshot.currency, estimatedMinorUnits: null };
    }
    majorUnits += usage.embeddingUnits / 1_000_000 * modelPricing.embeddingPerMillion;
    hasBillableUsage = true;
  }
  return {
    pricingSnapshotVersion: snapshot.version,
    currency: snapshot.currency,
    estimatedMinorUnits: hasBillableUsage
      ? roundMinorUnits(majorUnits * snapshot.minorUnitsPerMajor)
      : null,
  };
}

export interface CreateRuntimeCostEventInput extends RuntimeCostUsage {
  timestamp?: string;
  operation: string;
  category: RuntimeCostCategory;
  status: RuntimeCostStatus;
  rejectionReason?: string | null;
  attempt: number;
  scopeFingerprint: string;
  policyResolution?: RuntimeCostPolicyResolution;
  pricingSnapshot: RuntimePricingSnapshot;
}

export function createRuntimeCostEvent(input: CreateRuntimeCostEventInput): RuntimeCostEvent {
  const estimate = estimateRuntimeCost(input.pricingSnapshot, input);
  return {
    version: RUNTIME_COST_EVENT_VERSION,
    timestamp: input.timestamp ?? new Date().toISOString(),
    operation: input.operation,
    category: input.category,
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    embeddingUnits: input.embeddingUnits,
    embeddingUnitKind: input.embeddingUnitKind,
    pricingSnapshotVersion: estimate.pricingSnapshotVersion,
    estimatedMinorUnits: input.status === "failed" &&
        input.inputTokens === null && input.outputTokens === null && input.embeddingUnits === null
      ? null
      : estimate.estimatedMinorUnits,
    currency: estimate.currency,
    status: input.status,
    rejectionReason: input.rejectionReason ?? null,
    attempt: input.attempt,
    scopeFingerprint: input.scopeFingerprint,
    policyResolution: input.policyResolution ?? null,
  };
}

export async function appendRuntimeCostSafely(
  ledger: RuntimeCostEventSink | undefined,
  event: RuntimeCostEvent,
  onError?: (error: unknown) => void,
): Promise<void> {
  if (!ledger) return;
  try {
    await ledger.append(event);
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // Observability must never change provider retry behavior.
    }
  }
}

export interface RuntimeCostAggregateRow {
  events: number;
  providerAttempts: number;
  retries: number;
  succeeded: number;
  failed: number;
  rejected: number;
  inputTokens: number;
  outputTokens: number;
  embeddingUnits: number;
  estimatedMinorUnits: number;
  unpricedEvents: number;
}

export interface RuntimeCostAggregate {
  totals: RuntimeCostAggregateRow;
  byCategory: Record<RuntimeCostCategory, RuntimeCostAggregateRow>;
  pricingSnapshotVersions: string[];
  currencies: string[];
}

function emptyAggregateRow(): RuntimeCostAggregateRow {
  return {
    events: 0,
    providerAttempts: 0,
    retries: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    inputTokens: 0,
    outputTokens: 0,
    embeddingUnits: 0,
    estimatedMinorUnits: 0,
    unpricedEvents: 0,
  };
}

function addEvent(row: RuntimeCostAggregateRow, event: RuntimeCostEvent): void {
  row.events += 1;
  if (event.status !== "rejected") row.providerAttempts += 1;
  if (event.status !== "rejected" && event.attempt > 1) row.retries += 1;
  row[event.status] += 1;
  row.inputTokens += event.inputTokens ?? 0;
  row.outputTokens += event.outputTokens ?? 0;
  row.embeddingUnits += event.embeddingUnits ?? 0;
  if (event.estimatedMinorUnits === null) row.unpricedEvents += 1;
  else row.estimatedMinorUnits = roundMinorUnits(row.estimatedMinorUnits + event.estimatedMinorUnits);
}

export function aggregateRuntimeCost(events: readonly RuntimeCostEvent[]): RuntimeCostAggregate {
  const totals = emptyAggregateRow();
  const byCategory = Object.fromEntries(
    RUNTIME_COST_CATEGORIES.map((category) => [category, emptyAggregateRow()]),
  ) as Record<RuntimeCostCategory, RuntimeCostAggregateRow>;
  const versions = new Set<string>();
  const currencies = new Set<string>();
  for (const event of events) {
    addEvent(totals, event);
    addEvent(byCategory[event.category], event);
    versions.add(event.pricingSnapshotVersion);
    currencies.add(event.currency);
  }
  return {
    totals,
    byCategory,
    pricingSnapshotVersions: [...versions].sort(),
    currencies: [...currencies].sort(),
  };
}
