import { describe, expect, test } from "vitest";
import {
  mapFastPathObservationPolicy,
  type GovernedFastPathObservationPolicy,
} from "./fast-path-observation-policy.js";

describe("mapFastPathObservationPolicy", () => {
  test("ignore 不持久化、不运行准入，也不产生容器或路由", () => {
    expect(mapFastPathObservationPolicy({
      intent: "ignore",
      admissionRoute: "active",
    })).toEqual({
      disposition: "ignore",
      durable: false,
      requiresAdmission: false,
      reason: "transport_ignore",
    });
  });

  test("缺省 intent 按 auto 处理，只提交到原生 evidence/candidate 治理链", () => {
    expect(mapFastPathObservationPolicy({})).toEqual({
      disposition: "governed",
      durable: "after_admission",
      requiresAdmission: true,
      admissionIntent: "auto",
      container: "session_candidate",
      effectiveRoute: undefined,
      reason: "automatic_observation_requires_admission",
    });
  });

  test("auto 即使准入建议 active，也只能进入 candidate 路径", () => {
    const decision = mapFastPathObservationPolicy({
      intent: "auto",
      admissionRoute: "active",
    });

    expect(decision).toMatchObject({
      disposition: "governed",
      admissionIntent: "auto",
      container: "session_candidate",
      effectiveRoute: "candidate",
    });
    expect(decision).not.toHaveProperty("lifecycleStatus");
  });

  test("remember 仍需统一准入，transport 本身不能授予 active", () => {
    const beforeAdmission = mapFastPathObservationPolicy({ intent: "remember" });
    const afterAdmission = mapFastPathObservationPolicy({
      intent: "remember",
      admissionRoute: "active",
    });

    expect(beforeAdmission).toMatchObject({
      disposition: "governed",
      durable: "after_admission",
      requiresAdmission: true,
      admissionIntent: "remember",
      container: "session_candidate",
      effectiveRoute: undefined,
    });
    expect(afterAdmission).toMatchObject({
      effectiveRoute: "candidate",
      reason: "explicit_observation_requires_admission",
    });
    expect(afterAdmission).not.toHaveProperty("lifecycleStatus");
  });

  test.each([
    "drop",
    "candidate_low_priority",
    "candidate",
    "lookup_only",
    "evidence_only",
  ] as const)("保留统一准入产生的非 active 路由：%s", (admissionRoute) => {
    const decision = mapFastPathObservationPolicy({
      intent: "auto",
      admissionRoute,
    }) as GovernedFastPathObservationPolicy;

    expect(decision.effectiveRoute).toBe(admissionRoute);
  });

  test("返回新对象，调用结果可独立消费", () => {
    const first = mapFastPathObservationPolicy({ intent: "auto" });
    const second = mapFastPathObservationPolicy({ intent: "auto" });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
