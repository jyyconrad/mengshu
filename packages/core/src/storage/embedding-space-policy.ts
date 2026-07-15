import {
  evaluateEmbeddingQueryCompatibility,
  evaluateEmbeddingWriteCompatibility,
  type EmbeddingSpace,
  type EmbeddingSpaceState,
} from "../domain/embedding-space.js";

export type ActiveEmbeddingSpaceRegistryState =
  | { readonly status: "ready"; readonly activeSpace: EmbeddingSpace }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" };

export interface EmbeddingSpaceDiagnosticSummary {
  readonly embeddingSpaceId: string;
  readonly state: EmbeddingSpaceState;
}

export interface EmbeddingWriteDiagnostic {
  readonly registryStatus: ActiveEmbeddingSpaceRegistryState["status"];
  readonly runtimeSpace: EmbeddingSpaceDiagnosticSummary;
  readonly persistedActiveSpace?: EmbeddingSpaceDiagnosticSummary;
}

export type EmbeddingWriteReasonCode =
  | "active-space-match"
  | "active-space-mismatch"
  | "registry-active-space-missing"
  | "registry-unavailable"
  | "runtime-space-unknown"
  | "runtime-space-invalid"
  | "persisted-active-space-unknown"
  | "persisted-active-space-invalid";

export interface EmbeddingWritePolicyDecision {
  readonly allowed: boolean;
  readonly mode: "write-enabled" | "read-only-diagnostic";
  readonly reasonCode: EmbeddingWriteReasonCode;
  readonly diagnostic: EmbeddingWriteDiagnostic;
}

export type EmbeddingWriteGuardEnforcement = "enforced" | "legacy-write-through";

export interface EmbeddingWriteGuardSnapshot {
  readonly enforcement: EmbeddingWriteGuardEnforcement;
  readonly decision: EmbeddingWritePolicyDecision;
}

/**
 * 面向真实 runtime 读主链的 registry-aware 召回决策。
 *
 * 这里有意比下方 provider-neutral read policy 更严格：只有 persisted active
 * space 与 runtime fingerprint 匹配时才允许 ANN；在接入真实 lexical/BM25 port
 * 前，其余状态一律 fail-closed。
 */
export type EmbeddingRecallPolicyDecision =
  | {
      readonly allowed: true;
      readonly mode: "same-space-ann";
      readonly reasonCode: "active-space-match";
      readonly diagnostic: EmbeddingWriteDiagnostic;
      readonly requiredFilter: {
        readonly embeddingSpaceId: string;
        readonly embeddingSpaceState: EmbeddingSpaceState;
      };
    }
  | {
      readonly allowed: false;
      readonly mode: "fail-closed";
      readonly reasonCode: Exclude<EmbeddingWriteReasonCode, "active-space-match">;
      readonly diagnostic: EmbeddingWriteDiagnostic;
      readonly requiredFilter?: never;
    };

export class EmbeddingWriteBlockedError extends Error {
  readonly reasonCode: EmbeddingWriteReasonCode;

  constructor(decision: EmbeddingWritePolicyDecision) {
    super(`embedding write blocked: ${decision.reasonCode}`);
    this.name = "EmbeddingWriteBlockedError";
    this.reasonCode = decision.reasonCode;
  }
}

/** Mutable runtime gate: policy remains pure; lifecycle updates only registry state. */
export class EmbeddingWriteGuard {
  private decision: EmbeddingWritePolicyDecision;

  constructor(
    private readonly runtimeSpace: EmbeddingSpace,
    private readonly enforcement: EmbeddingWriteGuardEnforcement,
  ) {
    this.decision = decideEmbeddingWritePolicy({
      runtimeSpace,
      registry: { status: "unavailable" },
    });
  }

  update(registry: ActiveEmbeddingSpaceRegistryState): EmbeddingWriteGuardSnapshot {
    this.decision = decideEmbeddingWritePolicy({
      runtimeSpace: this.runtimeSpace,
      registry,
    });
    return this.snapshot();
  }

  snapshot(): EmbeddingWriteGuardSnapshot {
    return Object.freeze({ enforcement: this.enforcement, decision: this.decision });
  }

  assertWriteAllowed(): void {
    if (this.enforcement === "legacy-write-through") return;
    if (!this.decision.allowed) throw new EmbeddingWriteBlockedError(this.decision);
  }
}

export function decideEmbeddingRecallPolicy(input: {
  readonly runtimeSpace: EmbeddingSpace;
  readonly registry: ActiveEmbeddingSpaceRegistryState;
}): EmbeddingRecallPolicyDecision {
  const writeCompatibility = decideEmbeddingWritePolicy(input);
  if (!writeCompatibility.allowed) {
    return {
      allowed: false,
      mode: "fail-closed",
      reasonCode: writeCompatibility.reasonCode as Exclude<
        EmbeddingWriteReasonCode,
        "active-space-match"
      >,
      diagnostic: writeCompatibility.diagnostic,
    };
  }

  return {
    allowed: true,
    mode: "same-space-ann",
    reasonCode: "active-space-match",
    diagnostic: writeCompatibility.diagnostic,
    // ID 始终来自 runtime fingerprint。reembedded 是过程审计结果，不是
    // 持久记录的可查询分区；校验通过的新写/重嵌入行统一标记为
    // known-queryable，过程结果由独立 receipt 追溯。
    requiredFilter: {
      embeddingSpaceId: input.runtimeSpace.embeddingSpaceId,
      embeddingSpaceState: "known-queryable",
    },
  };
}

/** Mutable registry-backed read gate used by the runtime recall mainline. */
export class EmbeddingReadGuard {
  private decision: EmbeddingRecallPolicyDecision;

  constructor(private readonly runtimeSpace: EmbeddingSpace) {
    this.decision = decideEmbeddingRecallPolicy({
      runtimeSpace,
      registry: { status: "unavailable" },
    });
  }

  update(registry: ActiveEmbeddingSpaceRegistryState): EmbeddingRecallPolicyDecision {
    this.decision = decideEmbeddingRecallPolicy({
      runtimeSpace: this.runtimeSpace,
      registry,
    });
    return this.snapshot();
  }

  snapshot(): EmbeddingRecallPolicyDecision {
    return this.decision;
  }
}

export type EmbeddingReadReasonCode =
  | "same-space-read"
  | "cross-space-separate-route"
  | "unknown-space-text-only"
  | "invalid-space-read-forbidden";

export interface EmbeddingReadPolicyDecision {
  readonly allowed: boolean;
  readonly mode: "same-space" | "separate-space-route" | "text-only" | "deny";
  readonly reasonCode: EmbeddingReadReasonCode;
  readonly diagnostic: {
    readonly querySpace: EmbeddingSpaceDiagnosticSummary;
    readonly targetSpace: EmbeddingSpaceDiagnosticSummary;
  };
}

export type EmbeddingAnnReasonCode =
  | "same-space-ann"
  | "cross-space-ann-forbidden"
  | "unknown-space-ann-forbidden"
  | "invalid-space-ann-forbidden";

export interface EmbeddingAnnPolicyDecision {
  readonly allowed: boolean;
  readonly reasonCode: EmbeddingAnnReasonCode;
}

export type EmbeddingLateFusionReasonCode =
  | "same-space-raw-score-allowed"
  | "cross-space-rank-rrf-only"
  | "unknown-space-rank-rrf-only"
  | "invalid-space"
  | "no-spaces";

export interface EmbeddingLateFusionPolicyDecision {
  readonly allowed: boolean;
  readonly rankRrfAllowed: boolean;
  readonly rawSimilarityAllowed: boolean;
  readonly reasonCode: EmbeddingLateFusionReasonCode;
}

function summarizeSpace(space: EmbeddingSpace): EmbeddingSpaceDiagnosticSummary {
  return {
    embeddingSpaceId: space.embeddingSpaceId,
    state: space.state,
  };
}

function writeDecision(
  runtimeSpace: EmbeddingSpace,
  registry: ActiveEmbeddingSpaceRegistryState,
  reasonCode: EmbeddingWriteReasonCode,
  allowed = false,
): EmbeddingWritePolicyDecision {
  const persistedActiveSpace =
    registry.status === "ready"
      ? summarizeSpace(registry.activeSpace)
      : undefined;
  return {
    allowed,
    mode: allowed ? "write-enabled" : "read-only-diagnostic",
    reasonCode,
    diagnostic: {
      registryStatus: registry.status,
      runtimeSpace: summarizeSpace(runtimeSpace),
      ...(persistedActiveSpace ? { persistedActiveSpace } : {}),
    },
  };
}

export function decideEmbeddingWritePolicy(input: {
  readonly runtimeSpace: EmbeddingSpace;
  readonly registry: ActiveEmbeddingSpaceRegistryState;
}): EmbeddingWritePolicyDecision {
  const { runtimeSpace, registry } = input;
  if (registry.status === "missing") {
    return writeDecision(
      runtimeSpace,
      registry,
      "registry-active-space-missing",
    );
  }
  if (registry.status === "unavailable") {
    return writeDecision(runtimeSpace, registry, "registry-unavailable");
  }

  const runtimeSelf = evaluateEmbeddingQueryCompatibility(
    runtimeSpace,
    runtimeSpace,
  );
  if (runtimeSelf.reason === "unknown-space") {
    return writeDecision(runtimeSpace, registry, "runtime-space-unknown");
  }
  if (runtimeSelf.reason === "invalid-space") {
    return writeDecision(runtimeSpace, registry, "runtime-space-invalid");
  }

  const persistedActiveSpace = registry.activeSpace;
  const persistedSelf = evaluateEmbeddingQueryCompatibility(
    persistedActiveSpace,
    persistedActiveSpace,
  );
  if (persistedSelf.reason === "unknown-space") {
    return writeDecision(
      runtimeSpace,
      registry,
      "persisted-active-space-unknown",
    );
  }
  if (persistedSelf.reason === "invalid-space") {
    return writeDecision(
      runtimeSpace,
      registry,
      "persisted-active-space-invalid",
    );
  }

  const compatibility = evaluateEmbeddingWriteCompatibility(
    runtimeSpace,
    persistedActiveSpace,
  );
  if (compatibility.compatible) {
    return writeDecision(runtimeSpace, registry, "active-space-match", true);
  }
  return writeDecision(runtimeSpace, registry, "active-space-mismatch");
}

export function decideEmbeddingReadPolicy(input: {
  readonly querySpace: EmbeddingSpace;
  readonly targetSpace: EmbeddingSpace;
}): EmbeddingReadPolicyDecision {
  const { querySpace, targetSpace } = input;
  const compatibility = evaluateEmbeddingQueryCompatibility(
    querySpace,
    targetSpace,
  );
  const diagnostic = {
    querySpace: summarizeSpace(querySpace),
    targetSpace: summarizeSpace(targetSpace),
  };
  if (compatibility.reason === "same-space") {
    return {
      allowed: true,
      mode: "same-space",
      reasonCode: "same-space-read",
      diagnostic,
    };
  }
  if (compatibility.reason === "space-mismatch") {
    return {
      allowed: true,
      mode: "separate-space-route",
      reasonCode: "cross-space-separate-route",
      diagnostic,
    };
  }
  if (compatibility.reason === "unknown-space") {
    return {
      allowed: true,
      mode: "text-only",
      reasonCode: "unknown-space-text-only",
      diagnostic,
    };
  }
  return {
    allowed: false,
    mode: "deny",
    reasonCode: "invalid-space-read-forbidden",
    diagnostic,
  };
}

export function decideEmbeddingAnnPolicy(input: {
  readonly querySpace: EmbeddingSpace;
  readonly targetSpace: EmbeddingSpace;
}): EmbeddingAnnPolicyDecision {
  const compatibility = evaluateEmbeddingQueryCompatibility(
    input.querySpace,
    input.targetSpace,
  );
  if (compatibility.reason === "same-space") {
    return { allowed: true, reasonCode: "same-space-ann" };
  }
  if (compatibility.reason === "space-mismatch") {
    return { allowed: false, reasonCode: "cross-space-ann-forbidden" };
  }
  if (compatibility.reason === "unknown-space") {
    return { allowed: false, reasonCode: "unknown-space-ann-forbidden" };
  }
  return { allowed: false, reasonCode: "invalid-space-ann-forbidden" };
}

export function decideEmbeddingLateFusionPolicy(
  spaces: readonly EmbeddingSpace[],
): EmbeddingLateFusionPolicyDecision {
  if (spaces.length === 0) {
    return {
      allowed: false,
      rankRrfAllowed: false,
      rawSimilarityAllowed: false,
      reasonCode: "no-spaces",
    };
  }

  const selfReasons = spaces.map(
    (space) => evaluateEmbeddingQueryCompatibility(space, space).reason,
  );
  if (selfReasons.includes("invalid-space")) {
    return {
      allowed: false,
      rankRrfAllowed: false,
      rawSimilarityAllowed: false,
      reasonCode: "invalid-space",
    };
  }
  if (selfReasons.includes("unknown-space")) {
    return {
      allowed: true,
      rankRrfAllowed: true,
      rawSimilarityAllowed: false,
      reasonCode: "unknown-space-rank-rrf-only",
    };
  }

  const distinctSpaceIds = new Set(
    spaces.map((space) => space.embeddingSpaceId),
  );
  if (distinctSpaceIds.size > 1) {
    return {
      allowed: true,
      rankRrfAllowed: true,
      rawSimilarityAllowed: false,
      reasonCode: "cross-space-rank-rrf-only",
    };
  }
  return {
    allowed: true,
    rankRrfAllowed: true,
    rawSimilarityAllowed: true,
    reasonCode: "same-space-raw-score-allowed",
  };
}
