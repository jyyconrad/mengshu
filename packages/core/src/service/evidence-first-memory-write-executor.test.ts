import { describe, expect, test, vi } from "vitest";

import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
} from "./write-kernel.js";
import { createEvidenceFirstMemoryWriteExecutor } from "./evidence-first-memory-write-executor.js";

const base = Object.freeze({
  idempotencyKey: "save-parent-1",
  serverAuthority: Object.freeze({ tenantId: "tenant-a", userId: "user-a" }),
  clientScope: Object.freeze({
    appId: "mengshu",
    projectId: "project-a",
    agentId: "agent-a",
    namespace: "working-context",
    visibility: "private" as const,
    sessionId: "session-a",
  }),
  text: "所有 PostgreSQL 变更必须先完成真实测试验证。",
  kind: "decision" as const,
  semanticType: "rules" as const,
  container: "project" as const,
  confidence: 0.96,
  metadata: Object.freeze({ source: "user" }),
  provenance: Object.freeze({ source: "user", sourceId: "event-real-1" }),
  evidenceIds: Object.freeze(["caller-untrusted-evidence"]),
});

function saveCommand(): Extract<MemoryWriteCommand, { type: "saveExplicit" }> {
  return { type: "saveExplicit", ...base };
}

function persistedEvidence(memoryId = "evidence-memory-1"): MemoryWriteKernelResult {
  return {
    status: "persisted",
    route: "evidence_only",
    recordType: "memory",
    memoryId,
    stored: true,
  };
}

function createExecutor(
  executeKernel: (command: MemoryWriteCommand) => Promise<MemoryWriteKernelResult>,
  linkDuplicateEvidence = vi.fn(async () => ({ linkId: "duplicate-link-1" })),
) {
  return createEvidenceFirstMemoryWriteExecutor({ executeKernel, linkDuplicateEvidence });
}

describe("EvidenceFirstMemoryWriteExecutor", () => {
  test("saveExplicit 先持久化 raw evidence，再以真实 evidence memoryId 执行治理写入", async () => {
    const executeKernel = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> =>
      command.type === "importEvidence"
        ? persistedEvidence()
        : {
            status: "persisted",
            route: "active",
            recordType: "memory",
            memoryId: "active-memory-1",
            stored: true,
          });
    const executor = createExecutor(executeKernel);

    await expect(executor.execute(saveCommand())).resolves.toMatchObject({
      status: "governance_persisted",
      evidenceMemoryId: "evidence-memory-1",
      governance: { status: "persisted", memoryId: "active-memory-1" },
      link: { status: "linked", evidenceMemoryId: "evidence-memory-1" },
    });

    expect(executeKernel).toHaveBeenCalledTimes(2);
    const evidence = executeKernel.mock.calls[0]![0];
    const governance = executeKernel.mock.calls[1]![0];
    expect(evidence).toMatchObject({
      type: "importEvidence",
      text: base.text,
      kind: "observation",
      container: "session_candidate",
      sourceId: "event-real-1",
      evidenceIds: ["event-real-1"],
      metadata: {
        source: "user",
        eventType: "explicit_save",
      },
      provenance: {
        source: "user",
        sourceId: "event-real-1",
      },
    });
    expect("confidence" in evidence).toBe(false);
    expect(evidence.idempotencyKey).not.toBe(base.idempotencyKey);
    expect(evidence.idempotencyKey).toMatch(/^evidence:[a-f0-9]{64}$/);
    if (governance.type !== "saveExplicit") {
      throw new Error("expected saveExplicit governance command");
    }
    expect(governance).toEqual({
      ...saveCommand(),
      evidenceIds: ["evidence-memory-1"],
    });
    expect(governance.evidenceIds).not.toContain(base.idempotencyKey);
  });

  test("显式保存缺少调用方 sourceId 时，将确定性 evidence source 回写到 provenance", async () => {
    const executeKernel = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> =>
      command.type === "importEvidence"
        ? persistedEvidence()
        : { status: "rejected", reason: "governance_rejected" });
    const executor = createExecutor(executeKernel);
    const command = saveCommand();
    const withoutSourceId: MemoryWriteCommand = {
      ...command,
      provenance: { source: "user" },
    };

    await executor.execute(withoutSourceId);

    const evidence = executeKernel.mock.calls[0]![0];
    if (evidence.type !== "importEvidence") {
      throw new Error("expected importEvidence child command");
    }
    expect(evidence.sourceId).toMatch(/^event:[a-f0-9]{64}$/);
    expect(evidence.evidenceIds).toEqual([evidence.sourceId]);
    expect(evidence.provenance).toEqual({
      source: "user",
      sourceId: evidence.sourceId,
    });
    expect(evidence.metadata).toEqual({
      source: "user",
      eventType: "explicit_save",
    });
  });

  test("phase E 重放复用确定性 child key，并继续消费 kernel receipt 的同一 evidence ID", async () => {
    const evidenceKeys: string[] = [];
    const governanceEvidenceIds: (readonly string[])[] = [];
    const executeKernel = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> => {
      if (command.type === "importEvidence") {
        evidenceKeys.push(command.idempotencyKey);
        return persistedEvidence("evidence-replayed");
      }
      if (command.type !== "saveExplicit") {
        throw new Error("expected saveExplicit governance command");
      }
      governanceEvidenceIds.push(command.evidenceIds ?? []);
      return { status: "rejected", reason: "governance_rejected" };
    });
    const executor = createExecutor(executeKernel);

    await executor.execute(saveCommand());
    await executor.execute(saveCommand());

    expect(evidenceKeys).toHaveLength(2);
    expect(new Set(evidenceKeys).size).toBe(1);
    expect(governanceEvidenceIds).toEqual([
      ["evidence-replayed"],
      ["evidence-replayed"],
    ]);
  });

  test("phase E 未得到持久化 evidence memory 时不执行 phase G", async () => {
    const executeKernel = vi.fn(async (): Promise<MemoryWriteKernelResult> => ({
      status: "rejected",
      reason: "embedding_registry_mismatch",
    }));
    const executor = createExecutor(executeKernel);

    await expect(executor.execute(saveCommand())).resolves.toEqual({
      status: "evidence_not_persisted",
      evidence: { status: "rejected", reason: "embedding_registry_mismatch" },
      governanceExecuted: false,
    });
    expect(executeKernel).toHaveBeenCalledTimes(1);
  });

  test("phase G reject 返回组合结果，明确 evidence 已保留", async () => {
    const executeKernel = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> =>
      command.type === "importEvidence"
        ? persistedEvidence()
        : { status: "rejected", reason: "prompt_injection_detected" });
    const executor = createExecutor(executeKernel);

    await expect(executor.execute(saveCommand())).resolves.toEqual({
      status: "governance_rejected",
      evidenceMemoryId: "evidence-memory-1",
      evidence: persistedEvidence(),
      governance: { status: "rejected", reason: "prompt_injection_detected" },
      evidenceRetained: true,
    });
  });

  test("phase G duplicate 必须在 evidence ledger 幂等落盘后才报告 linked", async () => {
    const executeKernel = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> =>
      command.type === "importEvidence"
        ? persistedEvidence()
        : { status: "duplicate", kind: "semantic", duplicateOf: "active-existing" });
    const linkDuplicateEvidence = vi.fn(async () => ({ linkId: "duplicate-link-1" }));
    const command = saveCommand();
    const executor = createExecutor(executeKernel, linkDuplicateEvidence);

    await expect(executor.execute(command)).resolves.toEqual({
      status: "governance_duplicate",
      evidenceMemoryId: "evidence-memory-1",
      evidence: persistedEvidence(),
      governance: {
        status: "duplicate",
        kind: "semantic",
        duplicateOf: "active-existing",
      },
      evidenceRetained: true,
      link: {
        status: "linked",
        linkId: "duplicate-link-1",
        evidenceMemoryId: "evidence-memory-1",
        targetMemoryId: "active-existing",
      },
    });
    expect(linkDuplicateEvidence).toHaveBeenCalledOnce();
    expect(linkDuplicateEvidence).toHaveBeenCalledWith({
      command,
      evidenceMemoryId: "evidence-memory-1",
      targetMemoryId: "active-existing",
    });
  });

  test("duplicate evidence ledger 失败时抛出，重试复用 phase E receipt 后再次落 link", async () => {
    const evidenceKeys: string[] = [];
    const executeKernel = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> => {
      if (command.type === "importEvidence") {
        evidenceKeys.push(command.idempotencyKey);
        return persistedEvidence("evidence-replayed");
      }
      return { status: "duplicate", kind: "exact", duplicateOf: "active-existing" };
    });
    const linkDuplicateEvidence = vi.fn()
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValueOnce({ linkId: "duplicate-link-replayed" });
    const executor = createExecutor(executeKernel, linkDuplicateEvidence);

    await expect(executor.execute(saveCommand())).rejects.toThrow("ledger unavailable");
    await expect(executor.execute(saveCommand())).resolves.toMatchObject({
      status: "governance_duplicate",
      evidenceMemoryId: "evidence-replayed",
      link: { status: "linked", linkId: "duplicate-link-replayed" },
    });

    expect(evidenceKeys).toHaveLength(2);
    expect(new Set(evidenceKeys).size).toBe(1);
    expect(linkDuplicateEvidence).toHaveBeenCalledTimes(2);
  });

  test("duplicate target 或 link capability 缺失时 fail closed，不伪造 linked", async () => {
    const duplicateWithoutTarget = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> =>
      command.type === "importEvidence"
        ? persistedEvidence()
        : { status: "duplicate", kind: "semantic" });
    const linkDuplicateEvidence = vi.fn(async () => ({ linkId: "must-not-run" }));
    const noTarget = createExecutor(duplicateWithoutTarget, linkDuplicateEvidence);

    await expect(noTarget.execute(saveCommand())).resolves.toMatchObject({
      status: "governance_duplicate",
      link: {
        status: "not_linked",
        reason: "duplicate_target_missing",
      },
    });
    expect(linkDuplicateEvidence).not.toHaveBeenCalled();

    const duplicateWithTarget = vi.fn(async (command: MemoryWriteCommand): Promise<MemoryWriteKernelResult> =>
      command.type === "importEvidence"
        ? persistedEvidence()
        : { status: "duplicate", kind: "semantic", duplicateOf: "active-existing" });
    const withoutCapability = createEvidenceFirstMemoryWriteExecutor({
      executeKernel: duplicateWithTarget,
    });
    await expect(withoutCapability.execute(saveCommand())).rejects.toThrow(
      "duplicate evidence link capability is unavailable",
    );
  });

  test.each([
    { type: "importEvidence" as const, sourceId: "source-a", ...base },
    { type: "observeAuto" as const, intent: "auto" as const, ...base },
    {
      type: "correctMemory" as const,
      correctionKind: "archive" as const,
      targetId: "memory-old",
      idempotencyKey: "correct-1",
      serverAuthority: base.serverAuthority,
      clientScope: base.clientScope,
    },
  ])("$type 是 leaf command，保持单次直通", async (command) => {
    const result: MemoryWriteKernelResult = command.type === "correctMemory"
      ? {
          status: "persisted",
          correctionKind: "archive",
          recordType: "memory",
          memoryId: "memory-old",
          stored: true,
        }
      : command.type === "importEvidence"
        ? persistedEvidence()
        : { status: "persisted", route: "candidate", recordType: "candidate",
            candidateId: "candidate-1", memoryId: "candidate-1", stored: true };
    const executeKernel = vi.fn(async () => result);
    const executor = createExecutor(executeKernel);

    await expect(executor.execute(command)).resolves.toEqual(result);
    expect(executeKernel).toHaveBeenCalledOnce();
    expect(executeKernel).toHaveBeenCalledWith(command);
  });
});
