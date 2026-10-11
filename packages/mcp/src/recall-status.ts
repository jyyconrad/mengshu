/**
 * Machine-readable recall availability for Agent hot-path tools.
 *
 * ok: at least one usable hit.
 * ok-empty: the service answered and nothing usable remains.
 * authority-filtered: governance/authority removed every usable hit.
 * not-ready: the service could not answer; an empty list is not "no memory".
 */

export const RECALL_AVAILABILITY_STATUSES = [
  "ok",
  "ok-empty",
  "authority-filtered",
  "not-ready",
] as const;

export type RecallAvailabilityStatus = (typeof RECALL_AVAILABILITY_STATUSES)[number];

const AUTHORITY_FILTERS = new Set([
  "authority_mismatch",
  "scope_mismatch",
  "governance_mismatch",
]);

const EMPTY_MESSAGES = {
  "ok-empty": "未找到相关记忆。不要编造记忆。",
  "authority-filtered": "召回被 authority 或治理范围滤空。不要编造记忆。",
  "not-ready": "记忆服务未就绪。不要把空结果当成没有记忆。",
} as const;

export function classifyRecallAvailability(input: {
  usableHitCount: number;
  filteredReasons: readonly string[];
  serviceReady: boolean;
}): RecallAvailabilityStatus {
  if (input.usableHitCount > 0) return "ok";
  if (!input.serviceReady) return "not-ready";
  if (input.filteredReasons.some((reason) => AUTHORITY_FILTERS.has(reason))) {
    return "authority-filtered";
  }
  return "ok-empty";
}

export function recallStatusMessage(
  status: Exclude<RecallAvailabilityStatus, "ok">,
): string {
  return EMPTY_MESSAGES[status];
}

export function isRecallServiceUnavailable(error: unknown): boolean {
  if (typeof error === "string") return error.includes("SERVICE_UNAVAILABLE");
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === "SERVICE_UNAVAILABLE") return true;
  return typeof value.message === "string" && value.message.includes("SERVICE_UNAVAILABLE");
}
