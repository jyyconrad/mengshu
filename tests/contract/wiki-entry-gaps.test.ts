import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { AgentFastPathService } from "../../packages/api/src/agent-fast-path/index.js";
import { FileRawArchive } from "../../packages/core/src/ingest/raw-archive.js";
import {
  InMemorySourceCaptureStore,
  SourceCaptureService,
} from "../../packages/core/src/ingest/source-capture.js";
import type { MemoryScope } from "../../packages/core/src/domain/types.js";
import type { DurableJobV2Scope } from "../../packages/core/src/storage/repositories/job-v2.js";
import {
  ActiveDerivationOutboxConsumer,
  PostgresActiveDerivationOutboxRepository,
} from "../../server/postgres-active-derivation-outbox.js";
import { strictFastPathJobPayload } from "../../runtime-fast-path-job-payload.js";

const scope: MemoryScope & DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};

function service(deps: Partial<ConstructorParameters<typeof AgentFastPathService>[0]> = {}) {
  return new AgentFastPathService({
    defaultScope: scope,
    recall: async () => ({ scope, query: "", hits: [] }),
    ...deps,
  });
}

describe("wiki entry capture from section 2.2", () => {
  test("observeLight 入队失败仍 ack，capture outbox 可补偿，evidence_only 不进 active 派生", async () => {
    const root = await mkdtemp(join(tmpdir(), "mengshu-observe-capture-"));
    try {
    const calls: string[] = [];
    const captureStore = new InMemorySourceCaptureStore();
    const sourceCapture = new SourceCaptureService({
      archive: new FileRawArchive({ root }),
      store: captureStore,
      now: () => 30,
    });
    const fastPath = service({
      sourceCapture,
      storeObservation: async () => {
        calls.push("store");
        return {
          id: "evidence-1",
          stored: true,
          recordType: "memory" as const,
          admissionRoute: "evidence_only" as const,
        };
      },
      enqueueJob: async (input) => {
        calls.push("enqueue");
        expect(input.type).toBe("extract_candidate");
        expect(input.payload.text).toBe("raw observation");
        throw new Error("Durable job v2 runtime operation failed");
      },
    });

    const observed = await fastPath.observeLight({
      scope,
      eventType: "user_input",
      text: "raw observation",
      intent: "auto",
    });

    expect(calls).toEqual(["store", "enqueue"]);
    expect(observed).toMatchObject({
      ack: true,
      persistedId: "evidence-1",
      admissionRoute: "evidence_only",
      queuedJobs: [],
      capture: { status: "captured" },
    });
    expect(observed.warnings).toEqual([
      "enqueue_failed: Durable job v2 runtime operation failed",
    ]);
    expect(observed.capture?.captureId).not.toBe("evidence-1");
    await expect(sourceCapture.read(scope, observed.capture!.captureId)).resolves.toEqual(
      new Uint8Array(Buffer.from("raw observation")),
    );
    const repaired: Array<{ type: string; payload: { text?: string; traceId?: string } }> = [];
    const compensation = await sourceCapture.compensate(async (job) => {
      repaired.push(job);
      return "job-repair";
    });
    expect(compensation).toMatchObject({ enqueued: 1, damaged: 0, pending: 0 });
    expect(repaired).toEqual([{
      type: "extract_candidate",
      payload: {
        scope,
        text: "raw observation",
        traceId: observed.capture?.captureId,
        intent: "auto",
      },
    }]);

    const sql: string[] = [];
    const repository = new PostgresActiveDerivationOutboxRepository({
      connect: async () => ({
        query: async (statement: string) => {
          sql.push(statement);
          return statement.includes("SELECT")
            ? { rows: [], rowCount: 0 }
            : { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
    });
    await repository.claimPending({ limit: 1 });
    const eligibility = sql.find((statement) => statement.includes("derivation_eligible"));
    expect(eligibility).toContain("memory.lifecycle_status = 'active'");
    expect(eligibility).toContain("metadata->>'admissionRoute' = 'active'");
    expect(eligibility).toContain("metadata->>'contextEligible' = 'true'");
    expect(eligibility).not.toContain("evidence_only");

    const deriveCommittedActive = vi.fn(async () => undefined);
    const ackPublished = vi.fn(async () => true);
    const drained = await new ActiveDerivationOutboxConsumer({
      repository: {
        claimPending: async () => [{
          eventId: "a".repeat(64),
          storageKey: "b".repeat(64),
          memoryId: "evidence-1",
          scope,
          context: {},
          occurredAt: 10,
          derivationEligible: false,
        }],
        ackPublished,
      },
      deriveCommittedActive,
      now: () => 10,
    }).drainOnce();

    expect(deriveCommittedActive).not.toHaveBeenCalled();
    expect(ackPublished).toHaveBeenCalledOnce();
    expect(drained).toMatchObject({ read: 1, derived: 0, acknowledged: 1, failures: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sessionCommit 先保存可回读摘要，入队失败也不隐藏 capture，且不产生 active claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "mengshu-session-capture-"));
    try {
    const warnings: string[] = [];
    let captured: { type: string; payload: Record<string, unknown> } | undefined;
    const storeObservation = vi.fn();
    const sourceCapture = new SourceCaptureService({
      archive: new FileRawArchive({ root }),
      store: new InMemorySourceCaptureStore(),
      now: () => 40,
    });
    const fastPath = service({
      sourceCapture,
      storeObservation,
      enqueueJob: async (input) => {
        captured = input;
        throw new Error("Durable job v2 runtime operation failed");
      },
      logger: { warn: (message) => warnings.push(message) },
    });
    const summary = "session summary that is stored evidence";

    const committed = await fastPath.sessionCommit({
      scope,
      summary,
      transcriptRef: "transcript-1",
      metadata: { source: "session" },
    });

    expect(committed.ack).toBe(true);
    expect(committed.jobs).toEqual([]);
    expect(committed.capture).toMatchObject({ status: "captured", captureId: committed.traceId });
    expect(committed).not.toHaveProperty("persistedId");
    expect(storeObservation).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      "session_commit job extract_candidate failed: Durable job v2 runtime operation failed",
    ]);
    expect(committed.warnings).toEqual([
      "enqueue_failed: Durable job v2 runtime operation failed",
    ]);
    expect(captured?.type).toBe("extract_candidate");
    expect(captured?.payload).toMatchObject({
      text: summary,
      traceId: committed.traceId,
      intent: "auto",
    });
    expect(captured?.payload).not.toHaveProperty("summary");
    expect(captured?.payload).not.toHaveProperty("transcriptRef");
    await expect(sourceCapture.read(scope, committed.traceId)).resolves.toEqual(
      new Uint8Array(Buffer.from(summary)),
    );

    const kept = strictFastPathJobPayload(captured!.type, captured!.payload);
    expect(kept.text).toBe(summary);
    expect(kept.traceId).toBe(committed.traceId);
    expect(kept).not.toHaveProperty("summary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
