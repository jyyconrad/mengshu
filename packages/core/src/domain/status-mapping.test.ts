/**
 * status-mapping.test.ts
 *
 * 工作内容：表驱动验证 `mapToUserVisibleStatus` 覆盖 §0.3.1（D-19）全部映射分支。
 * 核心流程：构造内部状态输入（AdmissionRoute / CandidateStatus / MemoryLifecycleStatus），
 *           断言聚合出的 UserVisibleStatus 与 lookupOnly 标记符合单向映射表。
 * 关键边界：drop 不可见（status=null）；lookup_only/evidence_only 聚合为 pending 且标 lookupOnly；
 *           生命周期 > 候选状态 > 准入路由 的优先级解析。
 */

import { describe, it, expect } from "vitest";
import { mapToUserVisibleStatus } from "./status-mapping.js";
import type { AdmissionRoute, UserVisibleStatus } from "../../../../core/types.js";
import type { CandidateStatus } from "../../../../lifecycle/candidate-types.js";
import type { MemoryLifecycleStatus } from "../../../../core/types.js";

describe("mapToUserVisibleStatus", () => {
  describe("AdmissionRoute 单向映射（§0.3.1）", () => {
    const cases: Array<[AdmissionRoute, UserVisibleStatus | null, boolean]> = [
      ["drop", null, false],
      ["candidate_low_priority", "low_priority", false],
      ["candidate", "pending", false],
      ["active", "active", false],
      ["lookup_only", "pending", true],
      ["evidence_only", "pending", true],
    ];

    it.each(cases)(
      "admissionRoute=%s → status=%s lookupOnly=%s",
      (route, expectedStatus, expectedLookupOnly) => {
        const result = mapToUserVisibleStatus({ admissionRoute: route });
        expect(result.status).toBe(expectedStatus);
        expect(result.lookupOnly).toBe(expectedLookupOnly);
      }
    );
  });

  describe("CandidateStatus 单向映射（§0.3.1）", () => {
    const cases: Array<[CandidateStatus, UserVisibleStatus | null]> = [
      ["pending", "pending"],
      ["approved", "active"],
      ["rejected", "forgotten"],
      ["archived", "archived"],
      ["expired", "archived"],
    ];

    it.each(cases)("candidateStatus=%s → status=%s", (status, expected) => {
      const result = mapToUserVisibleStatus({ candidateStatus: status });
      expect(result.status).toBe(expected);
    });
  });

  describe("MemoryLifecycleStatus 单向映射（§0.3.1）", () => {
    const cases: Array<[MemoryLifecycleStatus, UserVisibleStatus]> = [
      ["active", "active"],
      ["archived", "archived"],
      ["superseded", "archived"],
      ["revoked", "forgotten"],
      ["promoted", "active"],
    ];

    it.each(cases)("lifecycleStatus=%s → status=%s", (status, expected) => {
      const result = mapToUserVisibleStatus({ lifecycleStatus: status });
      expect(result.status).toBe(expected);
    });
  });

  describe("优先级解析：lifecycle > candidate > admission", () => {
    it("生命周期存在时优先于候选与准入", () => {
      const result = mapToUserVisibleStatus({
        admissionRoute: "candidate",
        candidateStatus: "pending",
        lifecycleStatus: "active",
      });
      expect(result.status).toBe("active");
    });

    it("候选状态（已推进）优先于准入路由", () => {
      const result = mapToUserVisibleStatus({
        admissionRoute: "candidate",
        candidateStatus: "approved",
      });
      expect(result.status).toBe("active");
    });

    it("lookup_only 准入即便候选 pending 仍保留 lookupOnly 标记", () => {
      const result = mapToUserVisibleStatus({
        admissionRoute: "lookup_only",
        candidateStatus: "pending",
      });
      expect(result.status).toBe("pending");
      expect(result.lookupOnly).toBe(true);
    });
  });

  describe("边界：无任何内部状态", () => {
    it("空输入返回不可见（status=null）", () => {
      const result = mapToUserVisibleStatus({});
      expect(result.status).toBeNull();
      expect(result.lookupOnly).toBe(false);
    });
  });
});
