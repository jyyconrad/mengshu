import { createHash } from "node:crypto";

export type EvalTrack = "general" | "private" | "quality";
export type EffectEvalTrack = Exclude<EvalTrack, "quality">;

export interface EvalGovernanceSnapshot {
  runId: string;
  state: "verified" | "deployed";
  policyVersion: string;
  sourceManifestSha256: string;
  canonicalManifestSha256: string;
  cutoffAt: string;
}

export interface EvalRunSpec {
  candidateVersion: string;
  baselineVersion: string;
  datasetVersions: Readonly<Record<string, string>>;
  governanceSnapshot: Readonly<EvalGovernanceSnapshot> | null;
  configFingerprint: string;
  dbSchemaVersion: string;
  embeddingModel: string;
  readerModel: string;
  judgeModel: string;
  promptHashes: Readonly<Record<string, string>>;
  randomSeed: number;
  contextTokenBudget: number;
  topK: number;
  cacheMode: "cold" | "warm";
}

export interface EffectCaseScore {
  caseId: string;
  capability: string;
  score: number;
}

export interface PairedBootstrapInterval {
  readonly lower: number;
  readonly upper: number;
  readonly samples: 10_000;
  readonly confidenceLevel: 0.95;
  readonly randomSeed: number;
}

export interface PairedCapabilityComparison {
  capability: string;
  caseCount: number;
  baselineScore: number;
  candidateScore: number;
  delta: number;
  regressionTolerance: number;
  confidenceInterval: PairedBootstrapInterval;
  gatePassed: boolean;
}

export interface PairedEffectComparison {
  track: EffectEvalTrack;
  scoreName: "GMS" | "PMS";
  datasetVersion: string;
  baselineVersion: string;
  candidateVersion: string;
  caseCount: number;
  baselineScore: number;
  candidateScore: number;
  delta: number;
  regressionTolerance: number;
  capabilityRegressionTolerance: number;
  confidenceInterval: PairedBootstrapInterval;
  gatePassed: boolean;
  byCapability: readonly PairedCapabilityComparison[];
}

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_TEXT.test(value)) {
    throw new Error(`${field} must be a non-empty safe string`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  field: string,
  options: { nonEmpty?: boolean; sha256Values?: boolean } = {},
): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (options.nonEmpty && entries.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
  const normalized = Object.fromEntries(entries
    .map(([key, raw]) => {
      const safeKey = requireText(key, `${field} key`);
      const safeValue = requireText(raw, `${field}.${safeKey}`);
      if (options.sha256Values && !SHA256.test(safeValue)) {
        throw new Error(`${field}.${safeKey} must be a SHA-256 digest`);
      }
      return [safeKey, safeValue] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right)));
  return Object.freeze(normalized);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function governanceSnapshot(value: unknown): Readonly<EvalGovernanceSnapshot> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("governanceSnapshot must be null or an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.state !== "verified" && raw.state !== "deployed") {
    throw new Error("governanceSnapshot.state must be verified or deployed");
  }
  const sourceManifestSha256 = requireText(
    raw.sourceManifestSha256,
    "governanceSnapshot.sourceManifestSha256",
  );
  const canonicalManifestSha256 = requireText(
    raw.canonicalManifestSha256,
    "governanceSnapshot.canonicalManifestSha256",
  );
  if (!SHA256.test(sourceManifestSha256) || !SHA256.test(canonicalManifestSha256)) {
    throw new Error("governanceSnapshot manifest hashes must be SHA-256 digests");
  }
  const snapshot: EvalGovernanceSnapshot = {
    runId: requireText(raw.runId, "governanceSnapshot.runId"),
    state: raw.state,
    policyVersion: requireText(raw.policyVersion, "governanceSnapshot.policyVersion"),
    sourceManifestSha256,
    canonicalManifestSha256,
    cutoffAt: requireText(raw.cutoffAt, "governanceSnapshot.cutoffAt"),
  };
  if (!Number.isFinite(Date.parse(snapshot.cutoffAt))) {
    throw new Error("governanceSnapshot.cutoffAt must be an ISO timestamp");
  }
  return Object.freeze(snapshot);
}

export function createEvalRunSpec(input: EvalRunSpec): Readonly<EvalRunSpec> {
  const candidateVersion = requireText(input?.candidateVersion, "candidateVersion");
  const baselineVersion = requireText(input?.baselineVersion, "baselineVersion");
  if (candidateVersion === baselineVersion) {
    throw new Error("candidateVersion and baselineVersion must differ");
  }
  if (input.cacheMode !== "cold" && input.cacheMode !== "warm") {
    throw new Error("cacheMode must be cold or warm");
  }
  if (!Number.isSafeInteger(input.randomSeed)) {
    throw new Error("randomSeed must be a safe integer");
  }
  return Object.freeze({
    candidateVersion,
    baselineVersion,
    datasetVersions: requireRecord(input.datasetVersions, "datasetVersions", { nonEmpty: true }),
    governanceSnapshot: governanceSnapshot(input.governanceSnapshot),
    configFingerprint: requireText(input.configFingerprint, "configFingerprint"),
    dbSchemaVersion: requireText(input.dbSchemaVersion, "dbSchemaVersion"),
    embeddingModel: requireText(input.embeddingModel, "embeddingModel"),
    readerModel: requireText(input.readerModel, "readerModel"),
    judgeModel: requireText(input.judgeModel, "judgeModel"),
    promptHashes: requireRecord(input.promptHashes, "promptHashes", {
      nonEmpty: true,
      sha256Values: true,
    }),
    randomSeed: input.randomSeed,
    contextTokenBudget: requirePositiveInteger(input.contextTokenBudget, "contextTokenBudget"),
    topK: requirePositiveInteger(input.topK, "topK"),
    cacheMode: input.cacheMode,
  });
}

export function fingerprintEvalRunSpec(input: EvalRunSpec): string {
  return createHash("sha256").update(canonicalJson(createEvalRunSpec(input))).digest("hex");
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function mean(values: readonly number[]): number {
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function randomGenerator(seed: number): () => number {
  let state = (seed | 0) || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function bootstrapInterval(
  groups: readonly (readonly number[])[],
  randomSeed: number,
): PairedBootstrapInterval {
  const random = randomGenerator(randomSeed);
  const deltas = new Array<number>(10_000);
  for (let sample = 0; sample < deltas.length; sample += 1) {
    const groupMeans = groups.map((values) => {
      let total = 0;
      for (let index = 0; index < values.length; index += 1) {
        total += values[Math.floor(random() * values.length)]!;
      }
      return total / values.length;
    });
    deltas[sample] = groupMeans.reduce((sum, value) => sum + value, 0) / groupMeans.length;
  }
  deltas.sort((left, right) => left - right);
  return Object.freeze({
    lower: round(percentile(deltas, 0.025)),
    upper: round(percentile(deltas, 0.975)),
    samples: 10_000,
    confidenceLevel: 0.95,
    randomSeed,
  });
}

function scoreMap(values: readonly EffectCaseScore[], side: string): Map<string, EffectCaseScore> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${side} effect cases must not be empty`);
  }
  const result = new Map<string, EffectCaseScore>();
  for (const value of values) {
    const caseId = requireText(value?.caseId, `${side}.caseId`);
    const capability = requireText(value?.capability, `${side}.${caseId}.capability`);
    if (typeof value.score !== "number" || !Number.isFinite(value.score) ||
        value.score < 0 || value.score > 100) {
      throw new Error(`${side}.${caseId}.score must be between 0 and 100`);
    }
    if (result.has(caseId)) throw new Error(`${side} contains duplicate case '${caseId}'`);
    result.set(caseId, { caseId, capability, score: value.score });
  }
  return result;
}

export function comparePairedEffectRuns(input: {
  track: EvalTrack;
  datasetVersion: string;
  baselineVersion: string;
  candidateVersion: string;
  regressionTolerance: number;
  capabilityRegressionTolerance?: number;
  randomSeed?: number;
  baseline: readonly EffectCaseScore[];
  candidate: readonly EffectCaseScore[];
}): PairedEffectComparison {
  if (input.track !== "general" && input.track !== "private") {
    throw new Error("quality track is a gate and cannot produce an effect score");
  }
  const datasetVersion = requireText(input.datasetVersion, "datasetVersion");
  const baselineVersion = requireText(input.baselineVersion, "baselineVersion");
  const candidateVersion = requireText(input.candidateVersion, "candidateVersion");
  if (baselineVersion === candidateVersion) {
    throw new Error("candidateVersion and baselineVersion must differ");
  }
  if (!Number.isFinite(input.regressionTolerance) || input.regressionTolerance > 0) {
    throw new Error("regressionTolerance must be a finite non-positive number");
  }
  const capabilityRegressionTolerance = input.capabilityRegressionTolerance ?? -2;
  if (!Number.isFinite(capabilityRegressionTolerance) || capabilityRegressionTolerance > 0) {
    throw new Error("capabilityRegressionTolerance must be a finite non-positive number");
  }
  const randomSeed = input.randomSeed ?? 42;
  if (!Number.isSafeInteger(randomSeed)) throw new Error("randomSeed must be a safe integer");
  const baseline = scoreMap(input.baseline, "baseline");
  const candidate = scoreMap(input.candidate, "candidate");
  if (baseline.size !== candidate.size ||
      [...baseline.keys()].some((caseId) => !candidate.has(caseId))) {
    throw new Error("paired effect runs must contain exactly the same case ids");
  }

  const capabilityPairs = new Map<string, Array<{ baseline: number; candidate: number }>>();
  for (const [caseId, baselineCase] of baseline) {
    const candidateCase = candidate.get(caseId)!;
    if (baselineCase.capability !== candidateCase.capability) {
      throw new Error(`paired case '${caseId}' capability changed`);
    }
    const pairs = capabilityPairs.get(baselineCase.capability) ?? [];
    pairs.push({ baseline: baselineCase.score, candidate: candidateCase.score });
    capabilityPairs.set(baselineCase.capability, pairs);
  }
  const byCapability = [...capabilityPairs.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability, pairs]): PairedCapabilityComparison => {
      const baselineScore = mean(pairs.map((pair) => pair.baseline));
      const candidateScore = mean(pairs.map((pair) => pair.candidate));
      const delta = round(candidateScore - baselineScore);
      const confidenceInterval = bootstrapInterval([
        pairs.map((pair) => pair.candidate - pair.baseline),
      ], randomSeed + byCapabilitySeed(capability));
      return Object.freeze({
        capability,
        caseCount: pairs.length,
        baselineScore,
        candidateScore,
        delta,
        regressionTolerance: capabilityRegressionTolerance,
        confidenceInterval,
        gatePassed: confidenceInterval.lower >= capabilityRegressionTolerance,
      });
    });
  const baselineScore = mean(byCapability.map((item) => item.baselineScore));
  const candidateScore = mean(byCapability.map((item) => item.candidateScore));
  const delta = round(candidateScore - baselineScore);
  const confidenceInterval = bootstrapInterval(
    [...capabilityPairs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, pairs]) => pairs.map((pair) => pair.candidate - pair.baseline)),
    randomSeed,
  );
  return Object.freeze({
    track: input.track,
    scoreName: input.track === "general" ? "GMS" : "PMS",
    datasetVersion,
    baselineVersion,
    candidateVersion,
    caseCount: baseline.size,
    baselineScore,
    candidateScore,
    delta,
    regressionTolerance: input.regressionTolerance,
    capabilityRegressionTolerance,
    confidenceInterval,
    gatePassed: confidenceInterval.lower >= input.regressionTolerance &&
      byCapability.every((item) => item.gatePassed),
    byCapability: Object.freeze(byCapability),
  });
}

function byCapabilitySeed(capability: string): number {
  const digest = createHash("sha256").update(capability).digest();
  return digest.readInt32BE(0);
}
