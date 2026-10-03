import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { InMemorySessionWorkingSetRepository } from "./in-memory-repository.js";
import {
  createWorkingSetPromotionReceipt,
  SessionWorkingSetMemoryBridge,
} from "./memory-bridge.js";
import { SessionWorkingSetService } from "./session-working-set-service.js";

const scope = {
  tenantId: "tenant-1", userId: "user-1", appId: "codex", projectId: "project-1",
  agentId: "agent-1", namespace: "memories", sessionId: "session-1",
  visibility: "private" as const,
};

async function fixture(options: { riskFlags?: string[]; summary?: string } = {}) {
  const repository = new InMemorySessionWorkingSetRepository();
  const service = new SessionWorkingSetService(repository, { now: () => 1_000 });
  const payload = Buffer.from("tests passed");
  const entry = (await service.ingestToolPair({
    scope, sessionId: "session-1", taskBoundaryId: "task-1",
    toolCallId: "call-1", toolName: "npm-test", sourceMessageIds: ["tool-1", "result-1"],
    payloadRef: { provider: "session_log", locator: "payload-1",
      contentHash: createHash("sha256").update(payload).digest("hex"),
      byteLength: payload.byteLength }, outcome: "success",
    summary: options.summary ?? "npm-test success payload-1",
    replaceability: 0.8, evidenceRefs: ["evidence-1"],
    riskFlags: options.riskFlags ?? [], idempotencyKey: "ingest-1",
  })).entry;
  const executeMemoryWrite = vi.fn(async () => ({ status: "persisted" as const,
    route: "candidate" as const, recordType: "candidate" as const,
    candidateId: "candidate-1", memoryId: "candidate-1", stored: true }));
  const bridge = new SessionWorkingSetMemoryBridge({
    repository,
    memoryWrite: { executeMemoryWrite },
    serverAuthority: { tenantId: "tenant-1", userId: "user-1", sessionId: "session-1" },
  });
  return { bridge, entry, executeMemoryWrite };
}

describe("SessionWorkingSetMemoryBridge", () => {
  test("verified outcome can only enter observeAuto candidate through Write Kernel", async () => {
    const { bridge, entry, executeMemoryWrite } = await fixture();
    await bridge.promoteClaim({
      scope, sessionId: "session-1", source: "verified_outcome",
      text: "因为完整测试已通过，所以发布前统一运行 npm test，结果稳定。",
      semanticType: "experience", evidenceEntryIds: [entry.id], evidenceRefs: ["evidence-1"],
      idempotencyKey: "promote-1",
    });
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "observeAuto", intent: "auto", semanticType: "experience",
      container: "session_candidate", evidenceIds: ["evidence-1"],
    }));
  });

  test("explicit claim requires independent REMEMBER confirmation", async () => {
    const { bridge, entry, executeMemoryWrite } = await fixture();
    await expect(bridge.promoteClaim({
      scope, sessionId: "session-1", source: "user_explicit",
      text: "以后默认先运行完整测试。", semanticType: "rules",
      evidenceEntryIds: [entry.id], evidenceRefs: ["evidence-1"], idempotencyKey: "promote-2",
    })).rejects.toMatchObject({ code: "WORKING_SET_PROMOTION_INVALID" });
    expect(executeMemoryWrite).not.toHaveBeenCalled();
  });

  test("risk-marked or missing evidence cannot cross into long-term memory", async () => {
    const { bridge, entry, executeMemoryWrite } = await fixture({ riskFlags: ["sensitive"] });
    await expect(bridge.promoteClaim({
      scope, sessionId: "session-1", source: "verified_decision",
      text: "必须保留审核。", semanticType: "rules",
      evidenceEntryIds: [entry.id], evidenceRefs: ["evidence-1"], idempotencyKey: "promote-3",
    })).rejects.toMatchObject({ code: "WORKING_SET_EVIDENCE_UNAVAILABLE" });
    expect(executeMemoryWrite).not.toHaveBeenCalled();
  });

  test("memoryForm 写入元数据并返回可重放的晋升回执", async () => {
    const { bridge, entry, executeMemoryWrite } = await fixture();
    const input = {
      scope, sessionId: "session-1", source: "verified_outcome" as const,
      text: "因为完整测试已通过，所以发布前统一运行 npm test，结果稳定。",
      semanticType: "experience" as const, evidenceEntryIds: [entry.id], evidenceRefs: ["evidence-1"],
      idempotencyKey: "promote-form", memoryForm: "event/episodic" as const,
      operatorOrPolicy: "policy:working-set-promote",
    };
    const result = await bridge.promoteClaim(input);
    expect(result).toMatchObject({
      status: "persisted",
      candidateId: "candidate-1",
      replayed: false,
      promotionReceipt: {
        schema: "mengshu.working-set-promotion/v1",
        entryIds: [entry.id],
        evidenceRefs: ["evidence-1"],
        memoryForm: "event/episodic",
        scopeFingerprint: authorityScopeFingerprint(scope),
        idempotencyKey: "promote-form",
        operatorOrPolicy: "policy:working-set-promote",
      },
    });
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        source: "session-working-set",
        promotionSource: "verified_outcome",
        evidenceEntryIds: [entry.id],
        memoryForm: "event/episodic",
        operatorOrPolicy: "policy:working-set-promote",
      },
    }));
    const receipt = createWorkingSetPromotionReceipt({
      entryIds: [entry.id],
      evidenceRefs: ["evidence-1"],
      memoryForm: "fact/claim",
      scopeFingerprint: authorityScopeFingerprint(scope),
      idempotencyKey: "promote-form",
      operatorOrPolicy: "policy:working-set-promote",
    });
    expect(receipt).toMatchObject({
      schema: "mengshu.working-set-promotion/v1",
      memoryForm: "fact/claim",
      idempotencyKey: "promote-form",
      operatorOrPolicy: "policy:working-set-promote",
    });
    expect(receipt.entryIds).toEqual([entry.id]);
    const replay = await bridge.promoteClaim(input);
    expect(replay.replayed).toBe(true);
    expect(replay.promotionReceipt).toEqual(result.promotionReceipt);
    expect(executeMemoryWrite).toHaveBeenCalledOnce();
    await expect(bridge.promoteClaim({
      ...input,
      text: "同一幂等键不能改写成另一条晋升。",
    })).rejects.toMatchObject({ code: "WORKING_SET_PROMOTION_INVALID" });
    expect(executeMemoryWrite).toHaveBeenCalledOnce();
  });

  test("未标注 memoryForm 时元数据保持原字段", async () => {
    const { bridge, entry, executeMemoryWrite } = await fixture();
    const input = {
      scope, sessionId: "session-1", source: "verified_outcome" as const,
      text: "因为完整测试已通过，所以发布前统一运行 npm test，结果稳定。",
      semanticType: "experience" as const, evidenceEntryIds: [entry.id], evidenceRefs: ["evidence-1"],
      idempotencyKey: "promote-plain",
    };
    const first = await bridge.promoteClaim(input);
    expect(first).not.toHaveProperty("promotionReceipt");
    expect(first.replayed).toBe(false);
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        source: "session-working-set",
        promotionSource: "verified_outcome",
        evidenceEntryIds: [entry.id],
      },
    }));
    const replay = await bridge.promoteClaim(input);
    expect(replay.replayed).toBe(true);
    expect(replay).not.toHaveProperty("promotionReceipt");
    expect(executeMemoryWrite).toHaveBeenCalledOnce();
  });
});
