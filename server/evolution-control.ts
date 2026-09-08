import { resolveAuthorityScope, type AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { assertPostgresBundleOwnsEvolutionPersistence, type PostgresDurableJobV2RuntimeBundle, type PostgresEvolutionPersistence } from "../packages/core/src/db/providers/postgres.js";
import { assertEvolutionOwnerRequest } from "../packages/api/src/evolution-owner-auth.js";
import type { EvolutionSourceControlCapability, EvolutionSourceControlReceipt } from "../packages/api/src/evolution-source-control.js";
import { createPostgresEvolutionHostState, type EvolutionHostStatePort, type EvolutionHostStateReceipt } from "./evolution-host-state.js";
import { createEvolutionAttestation, type EvolutionAttestationService, type EvolutionAttestationControl } from "./evolution-attestation.js";
import type { GlobalEvolutionConfig } from "./evolution-config.js";
import { fingerprintTargetProfile, type TargetExecutionProfile } from "../packages/core/src/evolution/reuse/target-compatibility.js";

export interface EvolutionHostControl {
  readonly state: EvolutionHostStatePort;
  readonly attestation: EvolutionAttestationService;
  readonly capability: EvolutionSourceControlCapability;
  readonly stateForScope: (scope: MemoryScope) => EvolutionHostStatePort;
  readonly readTarget: (scope: MemoryScope) => Promise<TargetExecutionProfile | undefined>;
}
const OWNERS = new WeakMap<object, { persistence: PostgresEvolutionPersistence; scopeFingerprint: string; configFingerprint: string }>();

export function assertEvolutionHostControlOwner(control: EvolutionHostControl, bundle: PostgresDurableJobV2RuntimeBundle,
  scope: MemoryScope, configFingerprint: string): EvolutionHostControl {
  const owner = OWNERS.get(control);
  if (!owner || owner.scopeFingerprint !== authorityScopeFingerprint(scope) || owner.configFingerprint !== configFingerprint) {
    throw new Error("EVOLUTION_HOST_CONTROL_OWNER_MISMATCH");
  }
  assertPostgresBundleOwnsEvolutionPersistence(bundle, owner.persistence, scope);
  return control;
}

function publicReceipt(receipt: EvolutionHostStateReceipt): EvolutionSourceControlReceipt {
  if (!["source_attestation", "source_revocation"].includes(receipt.kind) || receipt.operation === "claim") throw new Error("EVOLUTION_CONTROL_RECEIPT_INVALID");
  return { id: receipt.id, kind: receipt.kind as EvolutionSourceControlReceipt["kind"], entryId: receipt.entryId,
    operation: receipt.operation, revision: receipt.revision, valueHash: receipt.valueHash, createdAt: receipt.createdAt };
}

export function createEvolutionHostControl(input: { persistence: PostgresEvolutionPersistence; authority: AuthorityScope;
  scope: MemoryScope; config: GlobalEvolutionConfig }): EvolutionHostControl {
  const authority = structuredClone(input.authority);
  const createState = (scope: MemoryScope) => createPostgresEvolutionHostState({ pool: input.persistence.repository.pool, authority, scope,
    authorizeOwner: () => ({ ...assertEvolutionOwnerRequest(authority), actorId: "runtime-host-owner", authentication: "authenticated_owner" }),
  });
  const state = createState(input.scope);
  const states = new Map([[authorityScopeFingerprint(input.scope), state]]);
  const stateForScope = (scope: MemoryScope): EvolutionHostStatePort => {
    if (authorityScopeFingerprint({ ...input.scope, projectId: scope.projectId }) !== authorityScopeFingerprint(scope)) {
      throw new Error("REUSE_HOST_SCOPE_MISMATCH");
    }
    const resolved = resolveAuthorityScope(authority, { appId: scope.appId, projectId: scope.projectId, agentId: scope.agentId,
      namespace: scope.namespace, visibility: scope.visibility });
    if (authorityScopeFingerprint(resolved) !== authorityScopeFingerprint(scope)) throw new Error("REUSE_HOST_SCOPE_MISMATCH");
    const key = authorityScopeFingerprint(scope);
    if (!states.has(key)) states.set(key, createState(scope));
    return states.get(key)!;
  };
  const profile = input.config.config.evolution?.reuse?.targetProfile;
  const readTarget = async (scope: MemoryScope): Promise<TargetExecutionProfile | undefined> => {
    const entry = await stateForScope(scope).read({ kind: "target_profile", id: "target" });
    if (!profile) return undefined;
    if (entry) {
      if (entry.revokedAt !== undefined || entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) return undefined;
      const saved = (entry.value as unknown as { profile?: TargetExecutionProfile }).profile;
      if (!saved || fingerprintTargetProfile(saved) !== fingerprintTargetProfile(profile)) return undefined;
    }
    return structuredClone(profile);
  };
  const attestation = createEvolutionAttestation({ state, trustedIssuers: input.config.config.evolution?.attestation?.trustedIssuers ?? [] });
  const control: EvolutionHostControl = Object.freeze({ state, stateForScope, readTarget, attestation, capability: Object.freeze({
    issueSourceAttestation: async (request: unknown, signal?: AbortSignal) => {
      assertEvolutionOwnerRequest(authority);
      return publicReceipt(await attestation.control.issue(request as Parameters<EvolutionAttestationControl["issue"]>[0], signal));
    },
    revokeSourceAttestation: async (request: unknown, signal?: AbortSignal) => {
      assertEvolutionOwnerRequest(authority);
      return publicReceipt(await attestation.control.revokeSource(request as Parameters<EvolutionAttestationControl["revokeSource"]>[0], signal));
    },
  }) });
  OWNERS.set(control, { persistence: input.persistence, scopeFingerprint: authorityScopeFingerprint(input.scope), configFingerprint: input.config.configFingerprint });
  return control;
}
