import type { EvolutionLease, EvolutionRepository } from "../packages/core/src/evolution/types.js";

/** Observe the real repository lease; never substitute a token or acquire a competing lease. */
export function withEvolutionSessionLeaseHook(repository: EvolutionRepository,
  beforeRelease: (lease: EvolutionLease) => Promise<void>): EvolutionRepository {
  const leases = new WeakSet<object>();
  return new Proxy(repository, { get(target, key) {
    if (key === "acquireLease") return async (...args: Parameters<EvolutionRepository["acquireLease"]>) => {
      const lease = await target.acquireLease(...args);
      if (lease) leases.add(lease);
      return lease;
    };
    if (key === "releaseLease") return async (lease: EvolutionLease) => {
      try { if (leases.delete(lease)) await beforeRelease(lease); }
      finally { await target.releaseLease(lease); }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
