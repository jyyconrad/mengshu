import { describe, expect, test, vi } from "vitest";
import { RuntimeBackgroundWork } from "./background-work.js";
import { memoryConfigSchema } from "../config.js";
import type { EvolutionBatchReport } from "../packages/core/src/evolution/types.js";
import { evolutionJobIdentity } from "./evolution-job.js";

const scope = { tenantId: "tenant", userId: "owner", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const report = { batchId: "batch-1", status: "queued", segment: { attempt: 1 } } as EvolutionBatchReport;

describe("host background deployment gate", () => {
  test("projects canonical seven-field job scope while preserving workspace/session in evolution job identity", async () => {
    const runtimeScope = { ...scope, workspaceId: "workspace", sessionId: "session" };
    const gate = new RuntimeBackgroundWork({ scope: runtimeScope, resolveBatch: async () => report });
    const ordinary = await gate.select(new AbortController().signal);
    expect(ordinary.mode).toBe("all");
    ordinary.release?.();
    await gate.update({ expectedRevision: gate.snapshot().revision, mode: "evolution_only", allowedBatchIds: [report.batchId] });
    const selection = await gate.select(new AbortController().signal);
    expect(selection).toMatchObject({ mode: "evolution_only", scope,
      jobIds: [evolutionJobIdentity(runtimeScope, report.batchId, 1).id],
    });
    if (selection.mode === "evolution_only") expect(Object.keys(selection.scope).sort()).toEqual(Object.keys(scope).sort());
    selection.release?.();
  });
  test("strict operator configuration preserves ordinary default and rejects arbitrary handler scopes", () => {
    const base = { embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" } };
    expect(memoryConfigSchema.parse(base).server?.backgroundWork).toBeUndefined();
    expect(memoryConfigSchema.parse({ ...base, server: { backgroundWork: { mode: "paused" } } }).server?.backgroundWork).toEqual({ mode: "paused", allowedBatchIds: [] });
    for (const backgroundWork of [{ mode: "anything" }, { mode: "evolution_only", allowedBatchIds: [] },
      { mode: "paused", handlers: ["build_tree"] }, { mode: "evolution_only", allowedBatchIds: ["../other"] }]) {
      expect(() => memoryConfigSchema.parse({ ...base, server: { backgroundWork } })).toThrow();
    }
  });
  test("paused selection performs no batch discovery and explicit evolution selects stable exact-scope jobs", async () => {
    const resolveBatch = vi.fn(async () => report);
    const gate = new RuntimeBackgroundWork({ config: { mode: "paused", allowedBatchIds: [] }, scope, resolveBatch });
    expect(await gate.select(new AbortController().signal)).toMatchObject({ mode: "paused" });
    expect(resolveBatch).not.toHaveBeenCalled();
    await gate.update({ expectedRevision: gate.snapshot().revision, mode: "evolution_only", allowedBatchIds: [report.batchId] });
    const selection = await gate.select(new AbortController().signal);
    expect(selection).toMatchObject({ mode: "evolution_only", scope, jobIds: [expect.stringMatching(/^[a-f0-9-]{36}$/)] });
    selection.release?.();
    expect(gate.snapshot()).toMatchObject({ mode: "evolution_only", active: 0, state: "controlled" });
  });
  test("changing mode aborts in-flight work, exposes draining, and rejects stale/restarted revisions", async () => {
    const gate = new RuntimeBackgroundWork({ scope });
    const selection = await gate.select(new AbortController().signal);
    const revision = gate.snapshot().revision;
    expect(gate.snapshot().active).toBe(1);
    await gate.update({ expectedRevision: revision, mode: "paused" });
    expect(selection.signal?.aborted).toBe(true);
    expect(gate.snapshot()).toMatchObject({ mode: "paused", active: 1, state: "draining" });
    await expect(gate.update({ expectedRevision: revision, mode: "all" })).rejects.toThrow("BACKGROUND_REVISION_STALE");
    selection.release?.();
    expect(gate.snapshot()).toMatchObject({ mode: "paused", active: 0, state: "paused" });
    const restarted = new RuntimeBackgroundWork({ scope, config: { mode: "paused", allowedBatchIds: [] } });
    expect(restarted.snapshot().revision).not.toBe(gate.snapshot().revision);
  });
  test("scope or missing capability cannot be supplied in a control request", async () => {
    const gate = new RuntimeBackgroundWork({ scope });
    await expect(gate.update({ expectedRevision: gate.snapshot().revision, mode: "paused", scope } as never)).rejects.toThrow();
    await expect(gate.update({ expectedRevision: gate.snapshot().revision, mode: "evolution_only", allowedBatchIds: ["batch-1"] })).rejects.toThrow("BACKGROUND_EVOLUTION_UNAVAILABLE");
  });
  test("non-worker maintenance loops stay stopped at startup and drain before maintenance exit", async () => {
    let finish!: () => void;
    const loop = { start: vi.fn(), stop: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const gate = new RuntimeBackgroundWork({ scope, config: { mode: "paused", allowedBatchIds: [] } });
    const lifecycle = gate.manageLoop(loop);
    await lifecycle.start();
    expect(loop.start).not.toHaveBeenCalled();
    await gate.update({ expectedRevision: gate.snapshot().revision, mode: "all" });
    expect(loop.start).toHaveBeenCalledTimes(1);
    const pause = gate.update({ expectedRevision: gate.snapshot().revision, mode: "paused" });
    expect(loop.stop).toHaveBeenCalledTimes(1);
    expect(gate.snapshot().state).toBe("draining");
    await expect(gate.update({ expectedRevision: gate.snapshot().revision, mode: "all" })).rejects.toThrow("BACKGROUND_DRAINING");
    finish();
    await pause;
    expect(gate.snapshot().state).toBe("paused");
    await lifecycle.stop();
    await gate.update({ expectedRevision: gate.snapshot().revision, mode: "all" });
    expect(loop.start).toHaveBeenCalledTimes(1);
  });
});
