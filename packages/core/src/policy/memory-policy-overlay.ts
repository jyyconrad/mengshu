import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { MemoryPolicyOverlayRepository } from "./repository.js";
import type {
  AppendMemoryPolicyOverlayInput,
  MemoryPolicyLayer,
  MemoryPolicyMutationResult,
  MemoryPolicyOverlayReceipt,
  MemoryPolicyOverlayVersion,
  MemoryPolicyTarget,
  ResolvedMemoryPolicy,
} from "./types.js";

export type MemoryPolicyOverlayErrorCode =
  | "POLICY_OVERLAY_INVALID"
  | "POLICY_OVERLAY_SCOPE_MISMATCH"
  | "POLICY_OVERLAY_GUARD_REJECTED"
  | "POLICY_VERSION_STALE"
  | "POLICY_IDEMPOTENCY_CONFLICT";

export class MemoryPolicyOverlayError extends Error {
  override readonly name = "MemoryPolicyOverlayError";
  constructor(readonly code: MemoryPolicyOverlayErrorCode) { super(code); }
}
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const LAYERS = new Set<MemoryPolicyLayer>([
  "candidate_extraction", "tree_summary", "skill_review", "document_organization",
]);
const STATUSES = new Set(["draft", "active", "revoked"]);
const OVERRIDE_ATTEMPT = /\b(?:ignore|override|change|expand|bypass|disable|replace|weaken)\b.{0,64}\b(?:system|developer|schema|enum|scope|visibility|acl|risk|evidence|validator|threshold|token limit|d-\d+)\b/i;
const GUARD = Object.freeze({
  version: "memory-policy-guard-v1" as const,
  immutable: [
    "schema", "enums", "message_source_boundaries", "d01_d23", "scoring",
    "thresholds", "token_hard_limit", "authority_scope", "memory_scope",
    "visibility", "acl", "evidence", "risk", "conflict", "faithfulness", "validator",
  ],
  conflictResolution: "system_default_wins" as const,
});

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${JSON.stringify(value)}`).digest("hex");
}

function fingerprint(scope: MemoryScope): string {
  if (scope.visibility !== "private") {
    throw new MemoryPolicyOverlayError("POLICY_OVERLAY_SCOPE_MISMATCH");
  }
  try { return authorityScopeFingerprint(scope); } catch {
    throw new MemoryPolicyOverlayError("POLICY_OVERLAY_SCOPE_MISMATCH");
  }
}

function validateHints(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 16) {
    throw new MemoryPolicyOverlayError("POLICY_OVERLAY_INVALID");
  }
  return Object.freeze(values.map((value) => {
    const normalized = value.trim();
    if (!normalized || normalized.length > 256 || /[\p{Cc}<>{}]/u.test(normalized) ||
        OVERRIDE_ATTEMPT.test(normalized)) {
      throw new MemoryPolicyOverlayError("POLICY_OVERLAY_GUARD_REJECTED");
    }
    return normalized;
  }));
}

function validateTarget(target: MemoryPolicyTarget, scope: MemoryScope): MemoryPolicyTarget {
  const values = [target.appId, target.projectId, target.agentId].filter(
    (value): value is string => value !== undefined,
  );
  if (values.some((value) => !SAFE_ID.test(value)) ||
      (target.appId !== undefined && target.appId !== scope.appId) ||
      (target.projectId !== undefined && target.projectId !== scope.projectId) ||
      (target.agentId !== undefined && target.agentId !== scope.agentId)) {
    throw new MemoryPolicyOverlayError("POLICY_OVERLAY_SCOPE_MISMATCH");
  }
  return Object.freeze({ ...target });
}

function targetRank(target: MemoryPolicyTarget): number {
  if (target.projectId !== undefined && target.agentId !== undefined) return 4;
  if (target.projectId !== undefined && target.agentId === undefined) return 3;
  if (target.appId !== undefined && target.projectId === undefined && target.agentId === undefined) return 2;
  if (target.appId === undefined && target.projectId === undefined && target.agentId === undefined) return 1;
  return 0;
}

function targetMatches(target: MemoryPolicyTarget, scope: MemoryScope): boolean {
  return (target.appId === undefined || target.appId === scope.appId) &&
    (target.projectId === undefined || target.projectId === scope.projectId) &&
    (target.agentId === undefined || target.agentId === scope.agentId) && targetRank(target) > 0;
}

function systemDefault(
  scopeFingerprint: string,
  layer: MemoryPolicyLayer,
  warnings: readonly string[] = [],
): ResolvedMemoryPolicy {
  const policy = Object.freeze({ focusHints: [], ignoreHints: [], aggregationHints: [] });
  const rendered = JSON.stringify({ guard: GUARD, overlay: null, policy });
  return Object.freeze({
    source: "system_default",
    policy,
    rendered,
    warnings: Object.freeze([...warnings]),
    receipt: Object.freeze({
      scopeFingerprint,
      layer,
      guardVersion: GUARD.version,
      resolutionHash: hash("memory-policy-resolution-v1", [scopeFingerprint, layer, null, warnings]),
    }),
  });
}

export class MemoryPolicyOverlayService {
  readonly #now: () => number;
  constructor(readonly repository: MemoryPolicyOverlayRepository, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async appendVersion(input: AppendMemoryPolicyOverlayInput): Promise<MemoryPolicyMutationResult> {
    const scopeFingerprint = fingerprint(input.scope);
    if (![input.id, input.idempotencyKey, input.ownerUserId].every((value) => SAFE_ID.test(value)) ||
        input.ownerUserId !== input.scope.userId || !LAYERS.has(input.layer) ||
        !STATUSES.has(input.status) || !Number.isSafeInteger(input.expectedLatestVersion) ||
        input.expectedLatestVersion < 0) {
      throw new MemoryPolicyOverlayError("POLICY_OVERLAY_INVALID");
    }
    const target = validateTarget(input.target, input.scope);
    if (targetRank(target) === 0) throw new MemoryPolicyOverlayError("POLICY_OVERLAY_INVALID");
    const focusHints = validateHints(input.focusHints);
    const ignoreHints = validateHints(input.ignoreHints);
    const aggregationHints = validateHints(input.aggregationHints);
    const requestHash = hash("memory-policy-overlay-request-v1", input);
    const replay = await this.repository.getReceipt(scopeFingerprint, input.idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        throw new MemoryPolicyOverlayError("POLICY_IDEMPOTENCY_CONFLICT");
      }
      const overlay = await this.repository.getVersion(scopeFingerprint, replay.overlayId, replay.version);
      if (overlay === undefined) throw new MemoryPolicyOverlayError("POLICY_OVERLAY_INVALID");
      return { overlay, receipt: replay, replayed: true };
    }
    const version = input.expectedLatestVersion + 1;
    const content = { target, layer: input.layer, focusHints, ignoreHints, aggregationHints };
    const createdAt = new Date(this.#now()).toISOString();
    const overlay: MemoryPolicyOverlayVersion = Object.freeze({
      id: input.id, version, target, layer: input.layer, focusHints, ignoreHints,
      aggregationHints, status: input.status, ownerUserId: input.ownerUserId,
      scope: Object.freeze({ ...input.scope, visibility: "private" as const }),
      contentHash: hash("memory-policy-overlay-content-v1", content), createdAt,
    });
    const receipt: MemoryPolicyOverlayReceipt = Object.freeze({
      id: `pr_${hash("memory-policy-overlay-receipt-v1", [
        scopeFingerprint, input.idempotencyKey, requestHash,
      ]).slice(0, 48)}`,
      scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
      overlayId: input.id, version, occurredAt: createdAt,
    });
    try {
      return await this.repository.appendVersion({
        scopeFingerprint, overlay, receipt, expectedLatestVersion: input.expectedLatestVersion,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "POLICY_VERSION_STALE") {
        throw new MemoryPolicyOverlayError("POLICY_VERSION_STALE");
      }
      if (error instanceof Error && error.message === "POLICY_IDEMPOTENCY_CONFLICT") {
        throw new MemoryPolicyOverlayError("POLICY_IDEMPOTENCY_CONFLICT");
      }
      throw error;
    }
  }
}

export class MemoryPolicyResolver {
  readonly #enabled: boolean;
  constructor(
    readonly repository: MemoryPolicyOverlayRepository,
    options: { enabled?: boolean } = {},
  ) { this.#enabled = options.enabled !== false; }

  async resolve(input: { scope: MemoryScope; layer: MemoryPolicyLayer }): Promise<ResolvedMemoryPolicy> {
    const scopeFingerprint = fingerprint(input.scope);
    if (!LAYERS.has(input.layer)) throw new MemoryPolicyOverlayError("POLICY_OVERLAY_INVALID");
    if (!this.#enabled) return systemDefault(scopeFingerprint, input.layer);
    const active = (await this.repository.listActive(scopeFingerprint, input.layer))
      .filter((overlay) => targetMatches(overlay.target, input.scope));
    for (const rank of [4, 3, 2, 1]) {
      const matches = active.filter((overlay) => targetRank(overlay.target) === rank);
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        return systemDefault(scopeFingerprint, input.layer, ["policy_overlay_rejected"]);
      }
      const overlay = matches[0]!;
      const policy = Object.freeze({
        focusHints: Object.freeze([...overlay.focusHints]),
        ignoreHints: Object.freeze([...overlay.ignoreHints]),
        aggregationHints: Object.freeze([...overlay.aggregationHints]),
      });
      const rendered = JSON.stringify({
        guard: GUARD,
        overlay: { id: overlay.id, version: overlay.version, contentHash: overlay.contentHash },
        policy,
      });
      return Object.freeze({
        source: "overlay",
        overlay,
        policy,
        rendered,
        warnings: Object.freeze([]),
        receipt: Object.freeze({
          scopeFingerprint,
          layer: input.layer,
          overlayId: overlay.id,
          overlayVersion: overlay.version,
          contentHash: overlay.contentHash,
          guardVersion: GUARD.version,
          resolutionHash: hash("memory-policy-resolution-v1", [
            scopeFingerprint, input.layer, overlay.id, overlay.version, overlay.contentHash,
          ]),
        }),
      });
    }
    return systemDefault(scopeFingerprint, input.layer);
  }
}
