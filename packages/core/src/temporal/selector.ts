import type { TemporalRecallSelector } from "./types.js";

export class TemporalSelectorError extends Error {
  override readonly name = "TemporalSelectorError";

  constructor(readonly code: "TEMPORAL_SELECTOR_INVALID") {
    super(code);
  }
}

function epochMilliseconds(value: number | undefined): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

/**
 * Normalizes the existing memory temporal clock.
 * asOf is valid time and knownAt is knowledge time; this is not a second clock.
 */
export function assertTemporalRecallSelector(
  selector: TemporalRecallSelector,
): TemporalRecallSelector {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new TemporalSelectorError("TEMPORAL_SELECTOR_INVALID");
  }
  const prototype = Object.getPrototypeOf(selector);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TemporalSelectorError("TEMPORAL_SELECTOR_INVALID");
  }
  const mode = selector.mode ?? (
    selector.asOf === undefined && selector.knownAt === undefined ? "current" : "as_of"
  );
  if (mode !== "current" && mode !== "as_of" && mode !== "all_versions") {
    throw new TemporalSelectorError("TEMPORAL_SELECTOR_INVALID");
  }
  if (!epochMilliseconds(selector.asOf) || !epochMilliseconds(selector.knownAt)) {
    throw new TemporalSelectorError("TEMPORAL_SELECTOR_INVALID");
  }
  if (mode === "current" && (selector.asOf !== undefined || selector.knownAt !== undefined)) {
    throw new TemporalSelectorError("TEMPORAL_SELECTOR_INVALID");
  }
  if (mode === "as_of" && selector.asOf === undefined) {
    throw new TemporalSelectorError("TEMPORAL_SELECTOR_INVALID");
  }
  return Object.freeze({
    mode,
    ...(selector.asOf === undefined ? {} : { asOf: selector.asOf }),
    ...(selector.knownAt === undefined ? {} : { knownAt: selector.knownAt }),
  });
}
