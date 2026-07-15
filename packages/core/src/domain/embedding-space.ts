import { createHash } from "node:crypto";

export const EMBEDDING_SPACE_ID_VERSION = "v1" as const;
export const UNKNOWN_EMBEDDING_SPACE_ID =
  `embedding-space:${EMBEDDING_SPACE_ID_VERSION}:unknown` as const;

export type EmbeddingVectorNormalization = "none" | "l2";
export type KnownEmbeddingSpaceState = "known-queryable" | "reembedded";
export type EmbeddingSpaceState =
  | KnownEmbeddingSpaceState
  | "unknown-unqueryable";

export interface EmbeddingSpaceFingerprintInput {
  provider: string;
  baseURL: string;
  model: string;
  dim: number;
  normalization: EmbeddingVectorNormalization;
}

export interface EmbeddingSpaceFingerprint {
  readonly provider: string;
  readonly baseURL: string;
  readonly model: string;
  readonly dim: number;
  readonly normalization: EmbeddingVectorNormalization;
}

export interface KnownEmbeddingSpace {
  readonly embeddingSpaceId: string;
  readonly state: KnownEmbeddingSpaceState;
  readonly fingerprint: EmbeddingSpaceFingerprint;
}

export interface UnknownEmbeddingSpace {
  readonly embeddingSpaceId: typeof UNKNOWN_EMBEDDING_SPACE_ID;
  readonly state: "unknown-unqueryable";
  readonly fingerprint?: never;
}

export type EmbeddingSpace = KnownEmbeddingSpace | UnknownEmbeddingSpace;

export type EmbeddingSpaceCompatibilityReason =
  | "same-space"
  | "space-mismatch"
  | "unknown-space"
  | "invalid-space";

export interface EmbeddingSpaceCompatibility {
  readonly compatible: boolean;
  readonly reason: EmbeddingSpaceCompatibilityReason;
}

export interface EmbeddingQueryCompatibility
  extends EmbeddingSpaceCompatibility {
  readonly annAllowed: boolean;
  readonly rawSimilarityComparable: boolean;
}

const UNKNOWN_SENTINELS = new Set(["unknown", "unspecified", "legacy", "n/a"]);
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const EMBEDDING_SPACE_ID_PATTERN = new RegExp(
  `^embedding-space:${EMBEDDING_SPACE_ID_VERSION}:[a-f0-9]{64}$`,
);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("embedding fingerprint 必须为对象");
  }
  return value as Record<string, unknown>;
}

function requireString(
  input: Record<string, unknown>,
  field: "provider" | "baseURL" | "model" | "normalization",
): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`embedding fingerprint 字段 ${field} 不能为空`);
  }
  return value.trim().normalize("NFC");
}

function normalizeProvider(input: Record<string, unknown>): string {
  const provider = requireString(input, "provider").toLowerCase();
  if (UNKNOWN_SENTINELS.has(provider)) {
    throw new Error(`unknown provider '${provider}' 不能创建已知 embedding space`);
  }
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error(`embedding fingerprint 字段 provider 非法：${provider}`);
  }
  return provider;
}

function normalizeBaseURL(input: Record<string, unknown>): string {
  const raw = requireString(input, "baseURL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("embedding fingerprint 字段 baseURL 必须为绝对 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("embedding fingerprint 字段 baseURL 只允许 http/https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "embedding fingerprint 字段 baseURL 禁止 credentials、query 或 fragment",
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

function normalizeModel(input: Record<string, unknown>): string {
  const model = requireString(input, "model");
  if (/\s/.test(model)) {
    throw new Error("embedding fingerprint 字段 model 不能包含空白字符");
  }
  if (UNKNOWN_SENTINELS.has(model.toLowerCase())) {
    throw new Error(`unknown/legacy model '${model}' 不能创建已知 embedding space`);
  }
  return model;
}

function normalizeDim(input: Record<string, unknown>): number {
  const dim = input.dim;
  if (!Number.isSafeInteger(dim) || (dim as number) <= 0) {
    throw new Error("embedding fingerprint 字段 dim 必须为正安全整数");
  }
  return dim as number;
}

function normalizeVectorNormalization(
  input: Record<string, unknown>,
): EmbeddingVectorNormalization {
  const normalization = requireString(input, "normalization").toLowerCase();
  if (normalization !== "none" && normalization !== "l2") {
    throw new Error(
      `embedding fingerprint 字段 normalization 不支持：${normalization}`,
    );
  }
  return normalization;
}

export function normalizeEmbeddingSpaceFingerprint(
  input: EmbeddingSpaceFingerprintInput,
): EmbeddingSpaceFingerprint {
  const record = asRecord(input);
  return Object.freeze({
    provider: normalizeProvider(record),
    baseURL: normalizeBaseURL(record),
    model: normalizeModel(record),
    dim: normalizeDim(record),
    normalization: normalizeVectorNormalization(record),
  });
}

function createEmbeddingSpaceId(fingerprint: EmbeddingSpaceFingerprint): string {
  const canonical = JSON.stringify({
    version: EMBEDDING_SPACE_ID_VERSION,
    provider: fingerprint.provider,
    baseURL: fingerprint.baseURL,
    model: fingerprint.model,
    dim: fingerprint.dim,
    normalization: fingerprint.normalization,
  });
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `embedding-space:${EMBEDDING_SPACE_ID_VERSION}:${digest}`;
}

export function createEmbeddingSpace(
  input: EmbeddingSpaceFingerprintInput,
  state: KnownEmbeddingSpaceState = "known-queryable",
): KnownEmbeddingSpace {
  if (state !== "known-queryable" && state !== "reembedded") {
    throw new Error(`已知 embedding space 状态非法：${String(state)}`);
  }
  const fingerprint = normalizeEmbeddingSpaceFingerprint(input);
  return Object.freeze({
    embeddingSpaceId: createEmbeddingSpaceId(fingerprint),
    state,
    fingerprint,
  });
}

export function createUnknownEmbeddingSpace(): UnknownEmbeddingSpace {
  return Object.freeze({
    embeddingSpaceId: UNKNOWN_EMBEDDING_SPACE_ID,
    state: "unknown-unqueryable",
  });
}

function isUnknownSpace(space: EmbeddingSpace): boolean {
  return (
    space?.state === "unknown-unqueryable" ||
    space?.embeddingSpaceId === UNKNOWN_EMBEDDING_SPACE_ID
  );
}

function isValidKnownSpace(space: EmbeddingSpace): space is KnownEmbeddingSpace {
  if (
    !space ||
    (space.state !== "known-queryable" && space.state !== "reembedded") ||
    !EMBEDDING_SPACE_ID_PATTERN.test(space.embeddingSpaceId) ||
    !("fingerprint" in space) ||
    !space.fingerprint
  ) {
    return false;
  }
  try {
    const normalized = normalizeEmbeddingSpaceFingerprint(space.fingerprint);
    return createEmbeddingSpaceId(normalized) === space.embeddingSpaceId;
  } catch {
    return false;
  }
}

function evaluateCompatibility(
  left: EmbeddingSpace,
  right: EmbeddingSpace,
): EmbeddingSpaceCompatibility {
  if (isUnknownSpace(left) || isUnknownSpace(right)) {
    return { compatible: false, reason: "unknown-space" };
  }
  if (!isValidKnownSpace(left) || !isValidKnownSpace(right)) {
    return { compatible: false, reason: "invalid-space" };
  }
  if (left.embeddingSpaceId !== right.embeddingSpaceId) {
    return { compatible: false, reason: "space-mismatch" };
  }
  return { compatible: true, reason: "same-space" };
}

export function evaluateEmbeddingQueryCompatibility(
  querySpace: EmbeddingSpace,
  targetSpace: EmbeddingSpace,
): EmbeddingQueryCompatibility {
  const decision = evaluateCompatibility(querySpace, targetSpace);
  return {
    ...decision,
    annAllowed: decision.compatible,
    rawSimilarityComparable: decision.compatible,
  };
}

export function evaluateEmbeddingWriteCompatibility(
  activeSpace: EmbeddingSpace,
  writeSpace: EmbeddingSpace,
): EmbeddingSpaceCompatibility {
  return evaluateCompatibility(activeSpace, writeSpace);
}

export function assertAnnCompatible(
  querySpace: EmbeddingSpace,
  targetSpace: EmbeddingSpace,
): void {
  const decision = evaluateEmbeddingQueryCompatibility(querySpace, targetSpace);
  if (decision.annAllowed) return;
  if (decision.reason === "unknown-space") {
    throw new Error("unknown embedding space 禁止 ANN 查询");
  }
  if (decision.reason === "invalid-space") {
    throw new Error("invalid embedding space 禁止 ANN 查询");
  }
  throw new Error("不同 embedding space 禁止交叉 ANN 查询");
}

export function assertRawSimilarityFusionCompatible(
  spaces: readonly EmbeddingSpace[],
): void {
  if (spaces.length === 0) {
    throw new Error("raw similarity 比较至少需要一个 embedding space");
  }
  const reference = spaces[0];
  for (const space of spaces) {
    const decision = evaluateEmbeddingQueryCompatibility(reference, space);
    if (decision.rawSimilarityComparable) continue;
    if (decision.reason === "unknown-space") {
      throw new Error("unknown embedding space 禁止 raw similarity 比较");
    }
    if (decision.reason === "invalid-space") {
      throw new Error("invalid embedding space 禁止 raw similarity 比较");
    }
    throw new Error(
      "不同 embedding space 禁止混合 raw similarity；请使用 rank/RRF late fusion",
    );
  }
}
