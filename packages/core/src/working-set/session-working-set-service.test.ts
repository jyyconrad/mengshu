import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { InMemorySessionWorkingSetRepository } from "./in-memory-repository.js";
import { SessionWorkingSetService } from "./session-working-set-service.js";

const scope: MemoryScope = {
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "codex",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
  sessionId: "session-1",
};

function payload(locator: string, content: string) {
  return {
    provider: "session_log" as const,
    locator,
    contentHash: createHash("sha256").update(content).digest("hex"),
    byteLength: Buffer.byteLength(content),
    mimeType: "application/json",
  };
}

describe("SessionWorkingSetService", () => {
  test("TaskOutline is append-only and advances with expected-version CAS", async () => {
    const service = new SessionWorkingSetService(
      new InMemorySessionWorkingSetRepository(),
      { now: () => 500 },
    );
    const first = await service.recordTaskBoundary({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-1",
      expectedVersion: 0,
      goal: "ship M2",
      status: "doing",
      completedSteps: [],
      currentSteps: ["implement"],
      nextSteps: ["verify"],
      decisions: ["exact session only"],
      openQuestions: [],
      entryRefs: [],
      evidenceRefs: ["evidence-task"],
      policyVersion: "outline-policy-v1",
    });
    expect(first.outline).toMatchObject({ version: 1, goal: "ship M2" });
    await expect(service.recordTaskBoundary({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-1",
      expectedVersion: 0,
      goal: "stale overwrite",
      status: "doing",
      completedSteps: [], currentSteps: [], nextSteps: [], decisions: [],
      openQuestions: [], entryRefs: [], evidenceRefs: [],
      policyVersion: "outline-policy-v1",
    })).rejects.toMatchObject({ code: "WORKING_SET_VERSION_STALE" });
  });

  test("persists a tool-pair shell before its bounded summary and remains idempotent", async () => {
    const repository = new InMemorySessionWorkingSetRepository();
    const service = new SessionWorkingSetService(repository, { now: () => 1_000 });
    const input = {
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-1",
      toolCallId: "call-1",
      toolName: "exec_command",
      sourceMessageIds: ["tool-use-1", "tool-result-1"],
      payloadRef: payload("session://call-1", "{\"exitCode\":1}"),
      outcome: "failure" as const,
      summary: "exec_command failure: exitCode=1; payload=session://call-1",
      replaceability: 0.9,
      evidenceRefs: ["evidence-1"],
      riskFlags: ["test_failed"],
      idempotencyKey: "ingest-call-1",
    };

    const first = await service.ingestToolPair(input);
    const replay = await service.ingestToolPair(input);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ entry: first.entry, replayed: true });
    expect(first.entry).toMatchObject({
      kind: "tool_pair",
      status: "summarized",
      sourceMessageIds: ["tool-use-1", "tool-result-1"],
      toolCallId: "call-1",
      riskFlags: ["test_failed"],
    });
    expect(repository.auditLog.map((event) => event.operation)).toEqual([
      "persist_shell",
      "attach_summary",
    ]);
  });

  test("rejects summaries that turn a failed tool result into success", async () => {
    const service = new SessionWorkingSetService(
      new InMemorySessionWorkingSetRepository(),
      { now: () => 1_000 },
    );
    await expect(service.ingestToolPair({
      scope,
      sessionId: "session-1",
      toolCallId: "call-2",
      toolName: "test",
      sourceMessageIds: ["use-2", "result-2"],
      payloadRef: payload("session://call-2", "failed"),
      outcome: "failure",
      summary: "test success: all tests passed; payload=session://call-2",
      replaceability: 0.8,
      evidenceRefs: [],
      riskFlags: ["test_failed"],
      idempotencyKey: "ingest-call-2",
    })).rejects.toMatchObject({ code: "WORKING_SET_SUMMARY_INVALID" });
  });

  test("emergency rewrite preserves protected messages and replaces complete tool pairs only", async () => {
    const repository = new InMemorySessionWorkingSetRepository();
    const service = new SessionWorkingSetService(repository, {
      now: () => 2_000,
      tokenCounter: { count: (text) => text.length },
    });
    await service.ingestToolPair({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-1",
      toolCallId: "call-3",
      toolName: "exec_command",
      sourceMessageIds: ["use-3", "result-3"],
      payloadRef: payload("session://call-3", "large result"),
      outcome: "success",
      summary: "exec_command success: tests passed; payload=session://call-3",
      replaceability: 1,
      evidenceRefs: ["evidence-3"],
      riskFlags: [],
      idempotencyKey: "ingest-call-3",
    });
    const messages = [
      { id: "system", role: "system" as const, content: "s".repeat(20) },
      { id: "user", role: "user" as const, content: "current request" },
      { id: "use-3", role: "tool" as const, content: "x".repeat(45), toolCallId: "call-3" },
      { id: "result-3", role: "tool" as const, content: "y".repeat(45), toolCallId: "call-3" },
    ];

    const result = await service.assemble({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-1",
      messages,
      contextWindow: 100,
      protectedMessageIds: ["system", "user"],
    });

    expect(result.receipt.level).toBe("emergency");
    expect(result.messages.map((message) => message.id)).toEqual([
      "system",
      "user",
      `working-set:${result.receipt.replacedEntryIds[0]}`,
    ]);
    expect(result.receipt.removedMessageIds).toEqual(["use-3", "result-3"]);
    expect(result.receipt.protectedMessageIds).toEqual(["system", "user"]);
    expect(result.receipt.evidenceRefs).toEqual(["evidence-3"]);
  });

  test("unknown tokenizer reports degraded counting instead of pretending precision", async () => {
    const service = new SessionWorkingSetService(
      new InMemorySessionWorkingSetRepository(),
      { now: () => 3_000 },
    );
    const result = await service.assemble({
      scope,
      sessionId: "session-1",
      messages: [{ id: "user", role: "user", content: "hello" }],
      contextWindow: 1_000,
      protectedMessageIds: ["user"],
    });
    expect(result.receipt.level).toBe("normal");
    expect(result.receipt.warnings).toContain("token_counter_degraded");
  });

  test("injects the current TaskOutline as protected context within the 20% budget", async () => {
    const repository = new InMemorySessionWorkingSetRepository();
    const service = new SessionWorkingSetService(repository, {
      now: () => 4_000,
      tokenCounter: { count: (text) => text.length },
    });
    await service.recordTaskBoundary({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-outline",
      expectedVersion: 0,
      goal: "finish the migration",
      status: "doing",
      completedSteps: ["backfill"],
      currentSteps: ["verify"],
      nextSteps: ["evaluate"],
      decisions: ["preserve evidence"],
      openQuestions: [],
      entryRefs: [],
      evidenceRefs: ["evidence-outline"],
      policyVersion: "outline-policy-v1",
    });

    const result = await service.assemble({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "task-outline",
      messages: [
        { id: "system", role: "system", content: "system" },
        { id: "user", role: "user", content: "continue" },
      ],
      contextWindow: 2_000,
      protectedMessageIds: ["system", "user"],
    });

    const outlineMessage = result.messages.find((message) =>
      message.id.startsWith("working-set-outline:"));
    expect(outlineMessage?.content).toContain("finish the migration");
    expect(result.receipt.injectedOutlineVersion).toBe(1);
    expect(result.receipt.protectedMessageIds).toContain(outlineMessage?.id);
    expect(result.receipt.evidenceRefs).toContain("evidence-outline");
  });

  test("reads payloads through a bounded host reader and verifies complete content hashes", async () => {
    const content = Buffer.from("payload body", "utf8");
    const service = new SessionWorkingSetService(
      new InMemorySessionWorkingSetRepository(),
      {
        now: () => 5_000,
        payloadReader: { read: async (_ref, maxBytes) => content.subarray(0, maxBytes) },
      },
    );
    const ingested = await service.ingestToolPair({
      scope,
      sessionId: "session-1",
      toolCallId: "call-read",
      toolName: "read_file",
      sourceMessageIds: ["use-read", "result-read"],
      payloadRef: payload("session://call-read", content.toString("utf8")),
      outcome: "success",
      replaceability: 0.5,
      evidenceRefs: [],
      riskFlags: [],
      idempotencyKey: "ingest-call-read",
    });

    const full = await service.readPayload({
      scope,
      sessionId: "session-1",
      entryId: ingested.entry.id,
      maxBytes: 64,
    });
    expect(Buffer.from(full.contentBase64, "base64").toString("utf8")).toBe("payload body");
    expect(full).toMatchObject({ bytesRead: 12, truncated: false, contentHashVerified: true });

    const partial = await service.readPayload({
      scope,
      sessionId: "session-1",
      entryId: ingested.entry.id,
      maxBytes: 4,
    });
    expect(partial).toMatchObject({ bytesRead: 4, truncated: true, contentHashVerified: false });
    expect(partial.warnings).toContain("payload_truncated_hash_not_verified");
  });

  test("closes a session with conservative retention and an immutable five-way cleanup receipt", async () => {
    const repository = new InMemorySessionWorkingSetRepository();
    const deleted: string[] = [];
    const service = new SessionWorkingSetService(repository, {
      now: () => 6_000,
      retentionDays: 0,
      evidenceRetentionGuard: { canRelease: async () => false },
      payloadRetention: { delete: async (ref) => {
        if (ref.locator.endsWith("fail")) throw new Error("unavailable");
        deleted.push(ref.locator);
      } },
    });
    const ingest = (call: string, evidenceRefs: string[] = []) => service.ingestToolPair({
      scope,
      sessionId: "session-1",
      toolCallId: call,
      toolName: "exec",
      sourceMessageIds: [`use-${call}`, `result-${call}`],
      payloadRef: payload(`session://${call}`, call),
      outcome: "success",
      replaceability: 0.5,
      evidenceRefs,
      riskFlags: [],
      idempotencyKey: `ingest-${call}`,
    });
    const retained = await ingest("retain", ["canonical-evidence"]);
    await ingest("delete");
    await ingest("fail");
    await service.recordTaskBoundary({
      scope,
      sessionId: "session-1",
      taskBoundaryId: "open-task",
      expectedVersion: 0,
      goal: "finish safely",
      status: "doing",
      completedSteps: [], currentSteps: ["verify"], nextSteps: [], decisions: [],
      openQuestions: [], entryRefs: [retained.entry.id], evidenceRefs: [],
      policyVersion: "outline-policy-v1",
    });

    const receipt = await service.closeSession(scope, "session-1");
    expect(receipt).toMatchObject({
      scannedCount: 3,
      retainedCount: 1,
      archivedCount: 0,
      deletedCount: 1,
      failedCount: 1,
      reason: "session_closed",
      retentionDays: 0,
    });
    expect(receipt.warnings).toContain("payload_delete_failed");
    expect(deleted).toEqual(["session://delete"]);
    expect((await repository.listEntries(receipt.scopeFingerprint, "session-1"))
      .every((entry) => entry.status === "expired")).toBe(true);
    await expect(service.closeSession(scope, "session-1")).resolves.toEqual(receipt);
  });

  test("missing retention configuration is explicit and retains payloads", async () => {
    const service = new SessionWorkingSetService(
      new InMemorySessionWorkingSetRepository(),
      { now: () => 7_000 },
    );
    await service.ingestToolPair({
      scope, sessionId: "session-1", toolCallId: "unconfigured", toolName: "exec",
      sourceMessageIds: ["use-u", "result-u"], payloadRef: payload("session://u", "u"),
      outcome: "success", replaceability: 0.5, evidenceRefs: [], riskFlags: [],
      idempotencyKey: "ingest-u",
    });
    const receipt = await service.closeSession(scope, "session-1");
    expect(receipt.warnings).toContain("retention_policy_unconfigured");
    expect(receipt).toMatchObject({ scannedCount: 1, retainedCount: 0, archivedCount: 1 });
  });

  test("deletes archived payloads after the configured retention window", async () => {
    const repository = new InMemorySessionWorkingSetRepository();
    const deleted: string[] = [];
    let now = 8_000;
    const service = new SessionWorkingSetService(repository, {
      now: () => now,
      retentionDays: 1,
      payloadRetention: { delete: async (ref) => { deleted.push(ref.locator); } },
    });
    await service.ingestToolPair({
      scope, sessionId: "session-1", toolCallId: "delayed", toolName: "exec",
      sourceMessageIds: ["use-delayed", "result-delayed"],
      payloadRef: payload("session://delayed", "delayed"),
      outcome: "success", replaceability: 0.5, evidenceRefs: [], riskFlags: [],
      idempotencyKey: "ingest-delayed",
    });

    const closed = await service.closeSession(scope, "session-1");
    expect(closed).toMatchObject({
      reason: "session_closed", retentionDays: 1, archivedCount: 1, deletedCount: 0,
    });
    expect((await service.runRetentionCleanup()).sessions).toBe(0);

    now += 86_400_000;
    const cleanup = await service.runRetentionCleanup();
    expect(cleanup).toMatchObject({ sessions: 1, failedSessions: 0 });
    expect(cleanup.receipts[0]).toMatchObject({
      reason: "retention_expired", retentionDays: 1, deletedCount: 1, failedCount: 0,
    });
    expect(deleted).toEqual(["session://delayed"]);
    await expect(service.runRetentionCleanup()).resolves.toMatchObject({ sessions: 0 });
  });
});
