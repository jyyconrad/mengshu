import { describe, expect, test } from "vitest";

import { assertTemporalRecallSelector, TemporalSelectorError } from "./selector.js";

describe("assertTemporalRecallSelector", () => {
  test("复用 asOf/knownAt，current 不能携带历史时间", () => {
    expect(assertTemporalRecallSelector({})).toEqual({ mode: "current" });
    expect(assertTemporalRecallSelector({
      mode: "as_of",
      asOf: 10,
      knownAt: 20,
    })).toEqual({ mode: "as_of", asOf: 10, knownAt: 20 });
    expect(() => assertTemporalRecallSelector({ mode: "current", knownAt: 20 }))
      .toThrow(TemporalSelectorError);
    expect(() => assertTemporalRecallSelector({ mode: "as_of" })).toThrow(TemporalSelectorError);
    expect(() => assertTemporalRecallSelector({ asOf: 1.5 })).toThrow(TemporalSelectorError);
  });
});
