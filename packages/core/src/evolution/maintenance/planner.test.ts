import { describe, expect, it, vi } from "vitest";
import { planMaintenance, runMaintenanceTick, DEFAULT_MAINTENANCE_BUDGET } from "./planner.js";
import type { MaintenanceEnvironment, MaintenanceWorkItem } from "./types.js";

const scope = { tenantId: "t", appId: "a", userId: "u", projectId: "p", agentId: "g", namespace: "n", visibility: "private" as const };
const budget = { records: 1, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 1, costMicros: 0 };
const item = (id: string, extra: Partial<MaintenanceWorkItem> = {}): MaintenanceWorkItem => ({ id, kind: "revalidate", scope, revision: "1", dueAt: 0, budget, ...extra });
const environment: MaintenanceEnvironment = { enabled: true, foregroundBusy: false, storageHealthy: true, now: 100, remaining: { ...DEFAULT_MAINTENANCE_BUDGET }, maxTasks: 2 };

describe("maintenance planner", () => {
  it("is deterministic, due-only, and serves never-attempted before repeated failures", () => {
    const work = [item("retried", { lastAttemptAt: 50 }), item("new"), item("future", { dueAt: 101 }), item("new2")];
    const first = planMaintenance(work, environment);
    expect(first.selected.map(i => i.id)).toEqual(["new", "new2"]);
    expect(planMaintenance(work.reverse(), environment)).toEqual(first);
  });
  it.each(["foregroundBusy", "storageHealthy", "enabled"] as const)("pauses before source I/O for %s", async key => {
    const due = { listDue: vi.fn(), markEnqueued: vi.fn() };
    const result = await runMaintenanceTick({ environment: { ...environment, [key]: key === "foregroundBusy" }, due, budget: { reserve: vi.fn() }, queue: { enqueue: vi.fn() } });
    expect(result.queued).toEqual([]);
    expect(due.listDue).not.toHaveBeenCalled();
  });
  it("accounts all dimensions and rejects invalid costs rather than zeroing them", () => {
    const plan = planMaintenance([item("expensive", { budget: { ...budget, bytes: 11 } }), item("small"), item("invalid", { budget: { ...budget, costMicros: NaN } })], { ...environment, remaining: { ...environment.remaining, bytes: 10 } });
    expect(plan.selected.map(i => i.id)).toEqual(["small"]);
    expect(plan.reasons).toContain("invalid_work_budget");
    expect(planMaintenance([item("x")], { ...environment, remaining: { ...budget, records: -1 } }).selected).toEqual([]);
  });
  it("enforces total reservations and task caps", () => {
    expect(planMaintenance([item("a"), item("b"), item("c")], { ...environment, remaining: budget }).selected).toHaveLength(1);
    expect(planMaintenance([item("a")], { ...environment, maxTasks: 0 }).selected).toEqual([]);
  });
  it("reserves shared budget, enqueues idempotently, then advances due progress", async () => {
    const events: string[] = [];
    const due = { listDue: vi.fn(async () => [item("a"), item("b")]), markEnqueued: vi.fn(async () => { events.push("mark"); }) };
    const reserve = vi.fn(async () => { events.push("reserve"); return { id: "r" }; });
    const enqueue = vi.fn(async () => { events.push("enqueue"); return { jobId: "j" }; });
    const run = () => runMaintenanceTick({ environment, due, budget: { reserve }, queue: { enqueue } });
    expect((await run()).queued).toHaveLength(2);
    expect(events).toEqual(["reserve", "enqueue", "mark", "reserve", "enqueue", "mark"]);
    expect(due.listDue).toHaveBeenCalledWith({ now: 100, limit: 100 });
    await run();
    expect(enqueue.mock.calls[0]).toEqual(enqueue.mock.calls[2]);
  });
  it("stops on daily budget denial and uncertain enqueue, without refunding or checkpointing", async () => {
    const due = { listDue: vi.fn(async () => [item("a"), item("b")]), markEnqueued: vi.fn() };
    const queue = { enqueue: vi.fn(async () => { throw new Error("secret transport body"); }) };
    expect((await runMaintenanceTick({ environment, due, budget: { reserve: vi.fn(async () => undefined) }, queue })).reasons).toContain("global_budget_exhausted");
    expect(queue.enqueue).not.toHaveBeenCalled();
    const failed = await runMaintenanceTick({ environment, due, budget: { reserve: vi.fn(async () => ({ id: "r" })) }, queue });
    expect(failed.reasons).toContain("enqueue_or_checkpoint_uncertain");
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(due.markEnqueued).not.toHaveBeenCalled();
  });
});
