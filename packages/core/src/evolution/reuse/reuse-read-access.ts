import { applyScopeReusePolicy, scopeToWorkspaceKey } from "../../domain/scope-policy.js";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import type { ExplicitReusePermit, HostManagedReuseAuthorizer } from "./explicit-reuse-authorizer.js";

/** Implemented by a host-owned binding reader, never record metadata or an LLM. */
export interface ReuseTargetCompatibility {
  allows(record: MemoryRecord, targetScope: MemoryScope): Promise<boolean>;
}

export interface ExplicitReuseReadOptions {
  readonly reuseAuthorizer?: HostManagedReuseAuthorizer;
  readonly reuseCompatibility?: ReuseTargetCompatibility;
}

export function requiresExplicitReuseGrant(source: MemoryScope, target: MemoryScope): boolean {
  return scopeToWorkspaceKey(source) !== scopeToWorkspaceKey(target);
}

export async function authorizeReuseRecord(
  record: MemoryRecord,
  target: MemoryScope,
  options: ExplicitReuseReadOptions,
): Promise<{ readonly permit?: ExplicitReusePermit } | undefined> {
  if (record.scope.tenantId !== target.tenantId || record.scope.userId !== target.userId) return undefined;
  const native = applyScopeReusePolicy([record], target).reusable.length === 1;
  const permit = native ? undefined : await options.reuseAuthorizer?.authorize(record.scope, target, record.kind);
  if (!native && !permit) return undefined;
  if (record.semanticType === "experience" && (!native || options.reuseCompatibility !== undefined)) {
    try {
      if (!await options.reuseCompatibility?.allows(record, target)) return undefined;
    } catch {
      return undefined;
    }
  }
  return { permit };
}
