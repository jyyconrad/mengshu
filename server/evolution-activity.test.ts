import { describe, expect, test, vi } from "vitest";
import { EvolutionActivity } from "./evolution-activity.js";
import { createRestRouter } from "../packages/api/src/rest/router.js";

describe("host evolution foreground and local storage observations", () => {
  test("construction is inert; local space is bounded by freshness and cancelled samples are not reused", async () => {
    let now = 1000;
    const sample = vi.fn(async () => ({ bavail: 1000n, bsize: 4096n }));
    const activity = new EvolutionActivity("/fixture", { now: () => now, statfs: sample });
    expect(sample).not.toHaveBeenCalled(); expect(activity.snapshot()).toEqual({ foregroundBusy: false, lastForegroundAt: 1000, localFreeBytes: null });
    await activity.refreshStorage(new AbortController().signal);
    expect(activity.snapshot().localFreeBytes).toBe(4096000);
    now += 30001; expect(activity.snapshot().localFreeBytes).toBeNull();
    await expect(activity.refreshStorage(AbortSignal.abort())).rejects.toThrow();
    expect(sample).toHaveBeenCalledTimes(1);
    const endA = activity.begin(), endB = activity.begin();
    expect(activity.snapshot().foregroundBusy).toBe(true);
    endA(); endA(); expect(activity.snapshot().foregroundBusy).toBe(true);
    endB(); expect(activity.snapshot()).toMatchObject({ foregroundBusy: false, lastForegroundAt: now });
  });
  test("actual REST requests mark foreground until completion without treating readiness polls as work", async () => {
    const activity = new EvolutionActivity("/fixture");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const router = createRestRouter({ unsafeLegacyScope: true, service: {} as never, foregroundActivity: activity,
      runtimeMcp: { listTools: () => [], callTool: async () => { await pending; return {}; } } });
    const work = router.handle({ method: "POST", path: "/v1/runtime/mcp-call", headers: {}, body: { name: "ordinary", arguments: {} } });
    expect(activity.snapshot().foregroundBusy).toBe(true);
    release(); await work;
    expect(activity.snapshot().foregroundBusy).toBe(false);
    const begin = vi.spyOn(activity, "begin");
    await router.handle({ method: "GET", path: "/v1/runtime", headers: {} });
    await router.handle({ method: "GET", path: "/v1/runtime/maintenance", headers: {} });
    expect(begin).not.toHaveBeenCalled();
  });
});
