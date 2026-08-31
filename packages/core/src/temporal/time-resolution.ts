import { createHash } from "node:crypto";

export type TemporalTimeExpressionKind = "epoch" | "iso" | "date" | "relative" | "anchor";

export interface TemporalTimeResolutionReceipt {
  readonly schema: "mengshu.temporal-time-resolution/v1";
  readonly id: string;
  readonly original: string | number;
  readonly kind: TemporalTimeExpressionKind;
  readonly timezoneOffsetMinutes: number;
  readonly referenceAt: number;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly selectedAt: number;
  readonly intervalStartIso: string;
  readonly intervalEndIso: string;
  readonly selectedAtIso: string;
  readonly selection: "exact" | "range_end";
}

export class TemporalTimeResolutionError extends Error {
  override readonly name = "TemporalTimeResolutionError";
  constructor(readonly code: "TEMPORAL_TIME_INVALID" | "TEMPORAL_TIME_AMBIGUOUS") {
    super(code);
  }
}

export interface ResolveTemporalTimeInput {
  readonly expression: string | number;
  readonly referenceAt: number;
  readonly timezoneOffsetMinutes?: number;
  readonly anchorAt?: number;
}

const DAY_MS = 86_400_000;
const EXPLICIT_ISO = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function offset(value: number | undefined): number {
  if (!Number.isInteger(value) || value! < -840 || value! > 840) {
    throw new TemporalTimeResolutionError("TEMPORAL_TIME_AMBIGUOUS");
  }
  return value!;
}

function localParts(timestampMs: number, timezoneOffsetMinutes: number): {
  year: number; month: number; day: number;
} {
  const date = new Date(timestampMs + timezoneOffsetMinutes * 60_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

function localMidnight(
  year: number,
  month: number,
  day: number,
  timezoneOffsetMinutes: number,
): number {
  return Date.UTC(year, month, day) - timezoneOffsetMinutes * 60_000;
}

function receipt(
  original: string | number,
  kind: TemporalTimeExpressionKind,
  timezoneOffsetMinutes: number,
  referenceAt: number,
  intervalStart: number,
  intervalEnd: number,
  selection: "exact" | "range_end",
): TemporalTimeResolutionReceipt {
  if (!timestamp(intervalStart) || !timestamp(intervalEnd) || intervalEnd <= intervalStart) {
    throw new TemporalTimeResolutionError("TEMPORAL_TIME_INVALID");
  }
  const selectedAt = selection === "exact" ? intervalStart : intervalEnd - 1;
  const core = { original, kind, timezoneOffsetMinutes, referenceAt, intervalStart, intervalEnd, selectedAt, selection };
  return Object.freeze({
    schema: "mengshu.temporal-time-resolution/v1",
    id: `tr_${createHash("sha256").update(JSON.stringify(core)).digest("hex").slice(0, 48)}`,
    ...core,
    intervalStartIso: new Date(intervalStart).toISOString(),
    intervalEndIso: new Date(intervalEnd).toISOString(),
    selectedAtIso: new Date(selectedAt).toISOString(),
  });
}

export function resolveTemporalTime(input: ResolveTemporalTimeInput): TemporalTimeResolutionReceipt {
  if (!timestamp(input.referenceAt)) throw new TemporalTimeResolutionError("TEMPORAL_TIME_INVALID");
  if (timestamp(input.expression)) {
    return receipt(input.expression, "epoch", 0, input.referenceAt,
      input.expression, input.expression + 1, "exact");
  }
  if (typeof input.expression !== "string" || input.expression !== input.expression.trim() ||
      input.expression.length === 0 || input.expression.length > 128) {
    throw new TemporalTimeResolutionError("TEMPORAL_TIME_INVALID");
  }
  const expression = input.expression;
  if (/^\d{1,16}$/.test(expression)) {
    const value = Number(expression);
    if (!timestamp(value)) throw new TemporalTimeResolutionError("TEMPORAL_TIME_INVALID");
    return receipt(expression, "epoch", 0, input.referenceAt, value, value + 1, "exact");
  }
  if (EXPLICIT_ISO.test(expression)) {
    const value = Date.parse(expression);
    if (!timestamp(value)) throw new TemporalTimeResolutionError("TEMPORAL_TIME_INVALID");
    const match = expression.match(/([+-])(\d{2}):(\d{2})$/);
    const timezoneOffsetMinutes = match
      ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
      : 0;
    return receipt(expression, "iso", timezoneOffsetMinutes, input.referenceAt,
      value, value + 1, "exact");
  }
  const dateOnly = expression.match(DATE_ONLY);
  if (dateOnly) {
    const timezoneOffsetMinutes = offset(input.timezoneOffsetMinutes);
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const start = localMidnight(year, month, day, timezoneOffsetMinutes);
    const check = localParts(start, timezoneOffsetMinutes);
    if (check.year !== year || check.month !== month || check.day !== day) {
      throw new TemporalTimeResolutionError("TEMPORAL_TIME_INVALID");
    }
    return receipt(expression, "date", timezoneOffsetMinutes, input.referenceAt,
      start, start + DAY_MS, "range_end");
  }
  const normalized = expression.toLocaleLowerCase("en-US");
  if (["当时", "then"].includes(normalized)) {
    if (!timestamp(input.anchorAt)) throw new TemporalTimeResolutionError("TEMPORAL_TIME_AMBIGUOUS");
    return receipt(expression, "anchor", 0, input.referenceAt,
      input.anchorAt, input.anchorAt + 1, "exact");
  }
  if (["现在", "now"].includes(normalized)) {
    return receipt(expression, "relative", 0, input.referenceAt,
      input.referenceAt, input.referenceAt + 1, "exact");
  }
  const timezoneOffsetMinutes = offset(input.timezoneOffsetMinutes);
  const current = localParts(input.referenceAt, timezoneOffsetMinutes);
  const today = localMidnight(current.year, current.month, current.day, timezoneOffsetMinutes);
  if (["今天", "today"].includes(normalized)) {
    return receipt(expression, "relative", timezoneOffsetMinutes, input.referenceAt,
      today, today + DAY_MS, "range_end");
  }
  if (["昨天", "yesterday"].includes(normalized)) {
    return receipt(expression, "relative", timezoneOffsetMinutes, input.referenceAt,
      today - DAY_MS, today, "range_end");
  }
  if (["这个月", "本月", "this month", "上个月", "last month"].includes(normalized)) {
    const thisMonth = localMidnight(current.year, current.month, 1, timezoneOffsetMinutes);
    if (["这个月", "本月", "this month"].includes(normalized)) {
      const nextMonth = localMidnight(current.year, current.month + 1, 1, timezoneOffsetMinutes);
      return receipt(expression, "relative", timezoneOffsetMinutes, input.referenceAt,
        thisMonth, nextMonth, "range_end");
    }
    const lastMonth = localMidnight(current.year, current.month - 1, 1, timezoneOffsetMinutes);
    return receipt(expression, "relative", timezoneOffsetMinutes, input.referenceAt,
      lastMonth, thisMonth, "range_end");
  }
  throw new TemporalTimeResolutionError("TEMPORAL_TIME_AMBIGUOUS");
}
