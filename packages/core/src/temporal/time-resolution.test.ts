import { describe, expect, test } from "vitest";
import { resolveTemporalTime, TemporalTimeResolutionError } from "./time-resolution.js";

const REFERENCE = Date.parse("2026-08-30T12:00:00+08:00");

describe("resolveTemporalTime", () => {
  test("resolves explicit instants and local calendar ranges with an explain receipt", () => {
    expect(resolveTemporalTime({
      expression: "2026-08-01T09:30:00+08:00", referenceAt: REFERENCE,
    })).toMatchObject({
      kind: "iso", timezoneOffsetMinutes: 480,
      selectedAtIso: "2026-08-01T01:30:00.000Z", selection: "exact",
    });
    expect(resolveTemporalTime({
      expression: "昨天", referenceAt: REFERENCE, timezoneOffsetMinutes: 480,
    })).toMatchObject({
      kind: "relative",
      intervalStartIso: "2026-08-28T16:00:00.000Z",
      intervalEndIso: "2026-08-29T16:00:00.000Z",
      selectedAtIso: "2026-08-29T15:59:59.999Z",
      selection: "range_end",
    });
    expect(resolveTemporalTime({
      expression: "上个月", referenceAt: REFERENCE, timezoneOffsetMinutes: 480,
    })).toMatchObject({
      intervalStartIso: "2026-06-30T16:00:00.000Z",
      intervalEndIso: "2026-07-31T16:00:00.000Z",
    });
  });

  test("requires timezone for calendar phrases and an explicit anchor for 当时", () => {
    expect(() => resolveTemporalTime({ expression: "昨天", referenceAt: REFERENCE }))
      .toThrow(new TemporalTimeResolutionError("TEMPORAL_TIME_AMBIGUOUS"));
    expect(() => resolveTemporalTime({ expression: "当时", referenceAt: REFERENCE }))
      .toThrow(new TemporalTimeResolutionError("TEMPORAL_TIME_AMBIGUOUS"));
    expect(resolveTemporalTime({
      expression: "当时", referenceAt: REFERENCE, anchorAt: 123,
    })).toMatchObject({ kind: "anchor", selectedAt: 123 });
  });
});
