import { describe, expect, test, vi } from "vitest";
import type { MemoryScope } from "../domain/types.js";
import { SkillCandidateAggregationLoop } from "./skill-candidate-aggregation-loop.js";

const scope: MemoryScope = {
  tenantId: "t", userId: "u", appId: "a", projectId: "p", agentId: "g",
  namespace: "memories", visibility: "private",
};

describe("SkillCandidateAggregationLoop", () => {
  test("runs exact-scope aggregation immediately, prevents overlap, and stops cleanly", async () => {
    let callback: (() => void) | undefined;
    let release: (() => void) | undefined;
    const runAggregation = vi.fn(() => new Promise<{
      skillCandidates: []; analyses: []; errors: string[];
    }>((resolve) => { release = () => resolve({ skillCandidates: [], analyses: [], errors: [] }); }));
    const clearInterval = vi.fn();
    const loop = new SkillCandidateAggregationLoop({ runAggregation }, scope, {
      intervalMs: 1_000,
      scheduler: {
        setInterval: (next) => { callback = next; return "timer"; },
        clearInterval,
      },
    });
    loop.start();
    callback?.();
    expect(runAggregation).toHaveBeenCalledTimes(1);
    expect(runAggregation).toHaveBeenCalledWith(scope);
    release?.();
    await loop.tick();
    await loop.stop();
    expect(clearInterval).toHaveBeenCalledWith("timer");
  });

  test("reports returned errors without failing the lifecycle", async () => {
    const onError = vi.fn();
    const loop = new SkillCandidateAggregationLoop({
      runAggregation: async () => ({ skillCandidates: [], analyses: [], errors: ["fixed-code"] }),
    }, scope, {
      intervalMs: 1_000,
      onError,
      scheduler: { setInterval: () => "timer", clearInterval: vi.fn() },
    });
    loop.start();
    await loop.tick();
    expect(onError).toHaveBeenCalledOnce();
    await loop.stop();
  });
});
