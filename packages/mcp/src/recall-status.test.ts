import { describe, expect, it } from "vitest";
import {
  classifyRecallAvailability,
  isRecallServiceUnavailable,
  recallStatusMessage,
} from "./recall-status.js";

describe("recall availability", () => {
  it("marks a ready empty recall as ok-empty", () => {
    expect(classifyRecallAvailability({
      usableHitCount: 0,
      filteredReasons: ["risk_blocked"],
      serviceReady: true,
    })).toBe("ok-empty");
    expect(recallStatusMessage("ok-empty")).toContain("不要编造");
  });

  it("marks an authority- or governance-filtered empty recall", () => {
    expect(classifyRecallAvailability({
      usableHitCount: 0,
      filteredReasons: ["authority_mismatch"],
      serviceReady: true,
    })).toBe("authority-filtered");
    expect(classifyRecallAvailability({
      usableHitCount: 0,
      filteredReasons: ["scope_mismatch", "risk_blocked"],
      serviceReady: true,
    })).toBe("authority-filtered");
    expect(classifyRecallAvailability({
      usableHitCount: 0,
      filteredReasons: ["governance_mismatch"],
      serviceReady: true,
    })).toBe("authority-filtered");
  });

  it("marks an unready service as not-ready even when filters exist", () => {
    expect(classifyRecallAvailability({
      usableHitCount: 0,
      filteredReasons: [],
      serviceReady: false,
    })).toBe("not-ready");
    expect(classifyRecallAvailability({
      usableHitCount: 0,
      filteredReasons: ["authority_mismatch"],
      serviceReady: false,
    })).toBe("not-ready");
    expect(recallStatusMessage("not-ready")).toContain("未就绪");
  });

  it("keeps ok when usable hits exist", () => {
    expect(classifyRecallAvailability({
      usableHitCount: 2,
      filteredReasons: ["authority_mismatch"],
      serviceReady: false,
    })).toBe("ok");
  });

  it("treats only service-unavailable failures as not-ready", () => {
    expect(isRecallServiceUnavailable(Object.assign(new Error("down"), {
      code: "SERVICE_UNAVAILABLE",
    }))).toBe(true);
    expect(isRecallServiceUnavailable(new Error("RECALL_SCORE_BREAKDOWN_REQUIRED"))).toBe(false);
  });
});
