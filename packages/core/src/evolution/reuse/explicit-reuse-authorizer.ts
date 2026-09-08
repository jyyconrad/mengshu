import { createHash } from "node:crypto";
import { resolveAuthorityScope, type AuthorityScope } from "../../domain/authority-scope.js";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryKind, MemoryScope } from "../../domain/types.js";

export interface ExplicitReuseGrant {
  readonly id: string;
  readonly sourceScope: MemoryScope;
  readonly targetScope: MemoryScope;
  readonly claimKinds: readonly MemoryKind[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface HostReuseState {
  readonly authority: AuthorityScope;
  /** Must change on every grant/authority mutation, including revocation and restoration. */
  readonly revision: string;
  readonly grants: readonly ExplicitReuseGrant[];
}

/** Host control-plane input only. Never resolve this port from client/LLM arguments. */
export interface HostReuseStateReader {
  read(): Promise<HostReuseState>;
}

export interface ExplicitReusePermit {
  readonly grantId: string;
  readonly revision: string;
  readonly stateFingerprint: string;
  readonly sourceScope: MemoryScope;
  readonly targetScope: MemoryScope;
  readonly claimKinds: readonly MemoryKind[];
  readonly expiresAt: string;
}

const ID = /^[^\s\p{Cc}]{1,256}$/u;
const KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const MAX_GRANTS = 32;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("REUSE_GRANT_TIMESTAMP_INVALID");
  }
  return parsed;
}

function scopeWithinAuthority(scope: MemoryScope, authority: AuthorityScope): void {
  const resolved = resolveAuthorityScope(authority, {
    appId: scope.appId, agentId: scope.agentId, projectId: scope.projectId,
    namespace: scope.namespace, visibility: scope.visibility,
  });
  if (authorityScopeFingerprint(scope) !== authorityScopeFingerprint(resolved)) {
    throw new TypeError("REUSE_SCOPE_OUTSIDE_AUTHORITY");
  }
}

export function sameExactReuseScope(left: MemoryScope, right: MemoryScope): boolean {
  try {
    return authorityScopeFingerprint(left) === authorityScopeFingerprint(right);
  } catch {
    return false;
  }
}

/** A validated grant narrows existing authority; it is never an authority credential. */
export function validateExplicitReuseGrant(
  grant: ExplicitReuseGrant,
  authority: AuthorityScope,
): ExplicitReuseGrant {
  const keys = ["id", "sourceScope", "targetScope", "claimKinds", "notBefore", "expiresAt", "revokedAt"];
  if (!grant || typeof grant !== "object" || Object.keys(grant).some((key) => !keys.includes(key)) ||
      typeof grant.id !== "string" || !ID.test(grant.id) || !Array.isArray(grant.claimKinds) ||
      grant.claimKinds.length === 0 || grant.claimKinds.some((kind) => !KINDS.has(kind)) ||
      new Set(grant.claimKinds).size !== grant.claimKinds.length) {
    throw new TypeError("REUSE_GRANT_INVALID");
  }
  scopeWithinAuthority(grant.sourceScope, authority);
  scopeWithinAuthority(grant.targetScope, authority);
  if ([grant.sourceScope, grant.targetScope].some((scope) =>
    scope.visibility !== "private" && scope.visibility !== "workspace")) {
    throw new TypeError("REUSE_TEAM_OR_PUBLIC_UNSUPPORTED");
  }
  if (timestamp(grant.expiresAt) <= timestamp(grant.notBefore)) {
    throw new TypeError("REUSE_GRANT_INTERVAL_INVALID");
  }
  if (grant.revokedAt !== undefined) timestamp(grant.revokedAt);
  return Object.freeze({
    ...grant,
    sourceScope: Object.freeze({ ...grant.sourceScope }),
    targetScope: Object.freeze({ ...grant.targetScope }),
    claimKinds: Object.freeze([...grant.claimKinds]),
  });
}

interface ValidState extends HostReuseState {
  readonly stateFingerprint: string;
  readonly now: number;
}

export class HostManagedReuseAuthorizer {
  readonly #issued = new WeakSet<ExplicitReusePermit>();

  constructor(
    private readonly reader: HostReuseStateReader,
    private readonly now: () => number = Date.now,
  ) {}

  async #state(target: MemoryScope): Promise<ValidState | undefined> {
    try {
      // Detach mutable control-plane objects before any subsequent await or caller observation.
      const raw = structuredClone(await this.reader.read());
      const now = this.now();
      if (!Number.isFinite(now) || typeof raw.revision !== "string" || !ID.test(raw.revision) ||
          !Array.isArray(raw.grants) || raw.grants.length > MAX_GRANTS ||
          new Set(raw.grants.map((grant) => grant.id)).size !== raw.grants.length) return undefined;
      scopeWithinAuthority(target, raw.authority);
      const grants = raw.grants.map((grant) => validateExplicitReuseGrant(grant, raw.authority));
      const stateFingerprint = createHash("sha256").update(JSON.stringify([
        "mengshu.explicit-reuse-state/v1", raw.revision, raw.authority, grants,
      ])).digest("hex");
      return { ...raw, grants, stateFingerprint, now };
    } catch {
      return undefined;
    }
  }

  #active(grant: ExplicitReuseGrant, target: MemoryScope, now: number): boolean {
    return grant.revokedAt === undefined && timestamp(grant.notBefore) <= now &&
      now < timestamp(grant.expiresAt) && sameExactReuseScope(grant.targetScope, target);
  }

  async sources(target: MemoryScope): Promise<readonly MemoryScope[]> {
    const state = await this.#state(target);
    if (!state) return [];
    const scopes = new Map<string, MemoryScope>();
    for (const grant of state.grants) {
      if (this.#active(grant, target, state.now) && !sameExactReuseScope(grant.sourceScope, target)) {
        scopes.set(authorityScopeFingerprint(grant.sourceScope), grant.sourceScope);
      }
    }
    return Object.freeze([...scopes.values()]);
  }

  async authorize(
    source: MemoryScope,
    target: MemoryScope,
    kind?: MemoryKind,
  ): Promise<ExplicitReusePermit | undefined> {
    const state = await this.#state(target);
    if (!state) return undefined;
    const grant = state.grants.find((entry) => this.#active(entry, target, state.now) &&
      sameExactReuseScope(entry.sourceScope, source) &&
      (kind === undefined || entry.claimKinds.includes(kind)));
    if (!grant) return undefined;
    const permit = Object.freeze({
      grantId: grant.id, revision: state.revision, stateFingerprint: state.stateFingerprint,
      sourceScope: grant.sourceScope, targetScope: grant.targetScope,
      claimKinds: grant.claimKinds, expiresAt: grant.expiresAt,
    });
    this.#issued.add(permit);
    return permit;
  }

  async revalidate(permit: ExplicitReusePermit, kind?: MemoryKind): Promise<boolean> {
    if (!this.#issued.has(permit)) return false;
    const state = await this.#state(permit.targetScope);
    return state !== undefined && state.revision === permit.revision &&
      state.stateFingerprint === permit.stateFingerprint && state.grants.some((grant) =>
        grant.id === permit.grantId && this.#active(grant, permit.targetScope, state.now) &&
        sameExactReuseScope(grant.sourceScope, permit.sourceScope) &&
        (kind === undefined || grant.claimKinds.includes(kind)));
  }
}
