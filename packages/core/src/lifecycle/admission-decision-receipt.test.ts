import { describe, expect, it } from "vitest";
import {
  CompositeAdmissionDecisionReceiptRepository,
  InMemoryAdmissionDecisionReceiptRepository,
  computeAdmissionCandidateHash,
  createAdmissionDecisionReceipt,
  fingerprintAdmissionScope,
  recordAdmissionDecisionBestEffort,
  validatePersistedAdmissionDecisionReceipt,
  type AdmissionDecisionReceiptRepository,
} from "./admission-decision-receipt.js";
import type { MemoryScope } from "../domain/types.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "t1",
  userId: "u1",
  appId: "app",
  projectId: "proj",
  agentId: "agent",
  namespace: "default",
  visibility: "private",
  sessionId: "sess-1",
});

describe("admission decision receipts", () => {
  it("creates a stable id and candidate hash for accept/reject", () => {
    const text = "合并前必须跑完整 vitest，不要跳过。";
    const accepted = createAdmissionDecisionReceipt({
      scope,
      text,
      semanticType: "rules",
      decision: "accepted",
      reasonCodes: ["route:active", "semanticType:rules"],
      source: "write_kernel",
      route: "active",
      memoryId: "mem-1",
      now: 1_700_000_000_000,
    });
    expect(accepted.version).toBe(1);
    expect(accepted.decision).toBe("accepted");
    expect(accepted.candidateHash).toBe(
      computeAdmissionCandidateHash({ text, semanticType: "rules" }),
    );
    expect(accepted.scopeFingerprint).toBe(fingerprintAdmissionScope(scope));
    expect(validatePersistedAdmissionDecisionReceipt(accepted).id).toBe(accepted.id);

    const rejected = createAdmissionDecisionReceipt({
      scope,
      text: "short",
      semanticType: "rules",
      decision: "rejected",
      reasonCodes: ["text_too_short"],
      source: "explain_dry_run",
      rejectedReason: "text_too_short",
      now: 1_700_000_000_000,
    });
    expect(rejected.decision).toBe("rejected");
    expect(rejected.rejectedReason).toBe("text_too_short");
  });

  it("stores last decision and lookup by candidate hash in memory", async () => {
    const repo = new InMemoryAdmissionDecisionReceiptRepository({
      now: () => 1_700_000_000_000,
    });
    const first = createAdmissionDecisionReceipt({
      scope,
      text: "第一条规则：默认用中文回复用户。",
      semanticType: "profile",
      decision: "accepted",
      reasonCodes: ["route:active"],
      source: "write_kernel",
      route: "active",
      profileDimension: "language",
      now: 1_700_000_000_000,
    });
    const second = createAdmissionDecisionReceipt({
      scope,
      text: "临时闲聊不要入库。",
      semanticType: "experience",
      decision: "rejected",
      reasonCodes: ["admission_drop"],
      source: "write_kernel",
      rejectedReason: "admission_drop",
      now: 1_700_000_000_100,
    });
    await repo.append(scope, first);
    await repo.append(scope, second);
    const latest = await repo.getLatest(scope);
    expect(latest?.id).toBe(second.id);
    const byHash = await repo.getByCandidateHash(scope, first.candidateHash);
    expect(byHash?.id).toBe(first.id);
  });

  it("composite prefers primary then falls back to mirror", async () => {
    const now = Date.now();
    const primary = new InMemoryAdmissionDecisionReceiptRepository({ now: () => now });
    const mirror = new InMemoryAdmissionDecisionReceiptRepository({ now: () => now });
    const composite = new CompositeAdmissionDecisionReceiptRepository(primary, mirror);
    const receipt = createAdmissionDecisionReceipt({
      scope,
      text: "部署前先跑 doctor。",
      semanticType: "rules",
      decision: "accepted",
      reasonCodes: ["route:active"],
      source: "write_kernel",
      route: "active",
      now,
    });
    await composite.append(scope, receipt);
    expect((await primary.getLatest(scope))?.id).toBe(receipt.id);
    expect((await mirror.getLatest(scope))?.id).toBe(receipt.id);
    expect((await composite.getByCandidateHash(scope, receipt.candidateHash))?.id).toBe(receipt.id);
  });

  it("best-effort recorder never throws", async () => {
    const failing: AdmissionDecisionReceiptRepository = {
      async append() {
        throw new Error("disk full");
      },
      async getLatest() {
        return undefined;
      },
      async getByCandidateHash() {
        return undefined;
      },
    };
    const receipt = createAdmissionDecisionReceipt({
      scope,
      text: "即使落库失败也不能打断写入主链。",
      semanticType: "rules",
      decision: "accepted",
      reasonCodes: ["route:active"],
      source: "write_kernel",
      now: 1_700_000_000_000,
    });
    await expect(recordAdmissionDecisionBestEffort(failing, scope, receipt)).resolves.toBeUndefined();
    await expect(recordAdmissionDecisionBestEffort(undefined, scope, receipt)).resolves.toBeUndefined();
  });
});

