import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { sha256, stableJson } from "../sources/shared.js";
import type { MaintenanceBudget, MaintenanceBudgetPort, MaintenanceDuePort, MaintenanceEnqueuePort, MaintenanceEnvironment, MaintenanceWorkItem } from "./types.js";

export const DEFAULT_MAINTENANCE_BUDGET: Readonly<MaintenanceBudget> = Object.freeze({
  records: 100, files: 20, bytes: 10 * 1024 * 1024, llmCalls: 10, inputTokens: 40000,
  outputTokens: 8000, durationMs: 300000, costMicros: 0,
});
const keys = Object.keys(DEFAULT_MAINTENANCE_BUDGET) as (keyof MaintenanceBudget)[];
const kinds = new Set(["revalidate", "merge_equivalent", "compile_pattern", "propose_skill", "retention", "source_reconcile"]);
const validBudget = (budget: MaintenanceBudget) => keys.every(key => Number.isSafeInteger(budget[key]) && budget[key] >= 0);

function paused(environment: MaintenanceEnvironment): string | undefined {
  if (!environment.enabled) return "disabled";
  if (environment.foregroundBusy) return "foreground_busy";
  if (!environment.storageHealthy) return "storage_pressure";
  if (!Number.isSafeInteger(environment.now) || environment.now < 0 || !Number.isSafeInteger(environment.maxTasks) ||
      environment.maxTasks < 0 || environment.maxTasks > 100 || !validBudget(environment.remaining)) return "invalid_environment";
  if (environment.maxTasks === 0) return "task_budget_exhausted";
  return undefined;
}

export function planMaintenance(work: readonly MaintenanceWorkItem[], environment: MaintenanceEnvironment): {
  selected: MaintenanceWorkItem[]; remaining: MaintenanceBudget; reasons: string[];
} {
  const remaining = { ...environment.remaining };
  const reason = paused(environment);
  if (reason) return { selected: [], remaining, reasons: [reason] };
  if (work.length > 100) return { selected: [], remaining, reasons: ["due_page_overflow"] };
  const reasons = new Set<string>();
  const selected: MaintenanceWorkItem[] = [];
  const seen = new Set<string>();
  const ordered = [...work].sort((a, b) => (a.lastAttemptAt ?? -1) - (b.lastAttemptAt ?? -1) || a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  for (const item of ordered) {
    if (selected.length >= environment.maxTasks) break;
    if (!validBudget(item.budget) || !kinds.has(item.kind) || !Number.isSafeInteger(item.dueAt) || item.dueAt < 0 ||
        (item.lastAttemptAt !== undefined && (!Number.isSafeInteger(item.lastAttemptAt) || item.lastAttemptAt < 0))) {
      reasons.add("invalid_work_budget"); continue;
    }
    let scopeHash: string;
    try { scopeHash = authorityScopeFingerprint(item.scope); } catch { reasons.add("invalid_work_scope"); continue; }
    if (!item.id || !item.revision || item.id.length > 512 || item.revision.length > 512) { reasons.add("invalid_work_identity"); continue; }
    const key = `${scopeHash}:${item.id}`;
    if (item.dueAt > environment.now || seen.has(key)) continue;
    seen.add(key);
    if (keys.some(key => item.budget[key] > remaining[key])) { reasons.add("batch_budget_exhausted"); continue; }
    for (const key of keys) remaining[key] -= item.budget[key];
    selected.push(structuredClone(item));
  }
  return { selected, remaining, reasons: [...reasons].sort() };
}

/** Called by the existing durable scheduler. No timers, provider calls, or source reads in the pure planner. */
export async function runMaintenanceTick(input: {
  environment: MaintenanceEnvironment; due: MaintenanceDuePort; budget: MaintenanceBudgetPort; queue: MaintenanceEnqueuePort;
  signal?: AbortSignal;
}): Promise<{ queued: { id: string; jobId: string; reservationId: string }[]; reasons: string[] }> {
  const reason = paused(input.environment);
  if (reason || input.signal?.aborted) return { queued: [], reasons: [reason ?? "cancelled"] };
  const work = await input.due.listDue({ now: input.environment.now, limit: 100 });
  const plan = planMaintenance(work, input.environment);
  const result = { queued: [] as { id: string; jobId: string; reservationId: string }[], reasons: [...plan.reasons] };
  for (const item of plan.selected) {
    if (input.signal?.aborted) { result.reasons.push("cancelled"); break; }
    const idempotencyKey = sha256(stableJson({ scope: authorityScopeFingerprint(item.scope), id: item.id, revision: item.revision, kind: item.kind }));
    const reservation = await input.budget.reserve({ idempotencyKey, budget: item.budget });
    if (!reservation) { result.reasons.push("global_budget_exhausted"); break; }
    if (input.signal?.aborted) { result.reasons.push("cancelled"); break; }
    if (!reservation.id || reservation.id.length > 512) { result.reasons.push("budget_reservation_invalid"); break; }
    try {
      const { jobId } = await input.queue.enqueue({ item, reservationId: reservation.id, idempotencyKey });
      await input.due.markEnqueued({ scope: item.scope, id: item.id, expectedRevision: item.revision, at: input.environment.now, jobId });
      result.queued.push({ id: item.id, jobId, reservationId: reservation.id });
    } catch {
      // Delivery may have committed. Keep its reservation and stable idempotency key for receipt reconciliation.
      result.reasons.push("enqueue_or_checkpoint_uncertain"); break;
    }
  }
  return result;
}
