import { describe, expect, test, vi } from "vitest";
import type { EvolutionLease, EvolutionRepository } from "../packages/core/src/evolution/types.js";
import { withEvolutionSessionLeaseHook } from "./evolution-session-lease.js";

describe("native evolution session lease hook", () => {
  test("passes only the actual acquired lease to the hook before release and still releases on hook errors", async () => {
    const events: string[] = [];
    const lease: EvolutionLease = { batchId: "batch", scopeFingerprint: "a".repeat(64), ownerId: "owner", fencingToken: 1, expiresAt: 1000 };
    const repository = { acquireLease: async () => lease, releaseLease: vi.fn(async () => { events.push("release"); }),
      getBatch: vi.fn(async () => undefined) } as unknown as EvolutionRepository;
    const hook = vi.fn(async value => { expect(value).toBe(lease); events.push("hook"); throw new Error("retention deferred"); });
    const scoped = withEvolutionSessionLeaseHook(repository, hook);
    await scoped.getBatch("batch", lease.scopeFingerprint);
    expect(hook).not.toHaveBeenCalled();
    expect(await scoped.acquireLease("batch", lease.scopeFingerprint, "owner", 1000)).toBe(lease);
    await expect(scoped.releaseLease(lease)).rejects.toThrow("retention deferred");
    expect(events).toEqual(["hook", "release"]);
    await scoped.releaseLease(lease);
    expect(hook).toHaveBeenCalledTimes(1);
    await scoped.releaseLease({ ...lease });
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
