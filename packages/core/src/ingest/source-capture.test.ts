import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { InMemorySessionWorkingSetRepository } from "../working-set/in-memory-repository.js";
import { SessionWorkingSetMemoryBridge } from "../working-set/memory-bridge.js";
import { SessionWorkingSetService } from "../working-set/session-working-set-service.js";
import { IngestionPipeline } from "./pipeline.js";
import { FileRawArchive } from "./raw-archive.js";
import {
  InMemorySourceCaptureStore,
  PostgresSourceCaptureStore,
  SourceCaptureError,
  SourceCaptureService,
} from "./source-capture.js";

const scope: MemoryScope = {
  tenantId: "local",
  userId: "user-1",
  appId: "codex",
  projectId: "memory-autodb",
  agentId: "agent-1",
  namespace: "memories",
  sessionId: "session-1",
  visibility: "private",
};

async function openArchive(): Promise<{ root: string; service: SourceCaptureService; store: InMemorySourceCaptureStore; archive: FileRawArchive }> {
  const root = await mkdtemp(join(tmpdir(), "mengshu-raw-"));
  const store = new InMemorySourceCaptureStore();
  const archive = new FileRawArchive({ root });
  const service = new SourceCaptureService({ archive, store, now: () => 50 });
  return { root, service, store, archive };
}

describe("source capture", () => {
  test("accepted input stays readable with no LLM and duplicate capture is idempotent", async () => {
    const source = readFileSync(fileURLToPath(new URL("./source-capture.ts", import.meta.url)), "utf8");
    const archiveSource = readFileSync(fileURLToPath(new URL("./raw-archive.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/LlmClient|llm-client|embeddings/);
    expect(archiveSource).not.toMatch(/LlmClient|llm-client|embeddings/);

    const opened = await openArchive();
    try {
      const bytes = Buffer.from("accepted input stays raw");
      const first = await opened.service.capture({
        scope,
        sourceId: "session-1",
        bytes,
        mediaType: "text/plain",
        kind: "sessions",
      });
      expect(first).toMatchObject({ status: "captured", replayed: false, captureId: first.idempotencyKey });
      expect(first.captureId).toMatch(/^[a-f0-9]{64}$/);
      await expect(opened.service.read(scope, first.captureId)).resolves.toEqual(new Uint8Array(bytes));
      const second = await opened.service.capture({
        scope,
        sourceId: "session-1",
        bytes,
        mediaType: "text/plain",
        kind: "sessions",
      });
      expect(second).toMatchObject({ captureId: first.captureId, status: "captured", replayed: true });
      expect(opened.store.rows.size).toBe(1);
      const enqueued: string[] = [];
      const compensated = await opened.service.compensate(async (job) => {
        enqueued.push(job.payload.text);
        expect(job.payload.traceId).toBe(first.captureId);
        expect(job.type).toBe("extract_candidate");
        return "job-1";
      });
      expect(compensated).toEqual({ enqueued: 1, damaged: 0, pending: 0 });
      expect(enqueued).toEqual(["accepted input stays raw"]);
      const again = await opened.service.compensate(async () => "job-2");
      expect(again.enqueued).toBe(0);
    } finally {
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  test("a crash after manifest rename is recoverable and a later database miss stays local pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "mengshu-raw-crash-"));
    try {
      let crash = true;
      const store = new InMemorySourceCaptureStore();
      const archive = new FileRawArchive({
        root,
        onPhase: (phase) => {
          if (crash && phase === "after_manifest_rename") throw new Error("crash-before-commit");
        },
      });
      const service = new SourceCaptureService({ archive, store, now: () => 60 });
      const bytes = Buffer.from("accepted input");
      const pending = await service.capture({
        scope,
        sourceId: "session-1",
        bytes,
        mediaType: "text/plain",
        kind: "sessions",
      });
      expect(pending.status).toBe("captured_local_pending");
      expect(store.rows.size).toBe(0);
      await expect(service.read(scope, pending.captureId)).resolves.toEqual(new Uint8Array(bytes));
      crash = false;
      await expect(service.reconcile()).resolves.toEqual({ recovered: 1, damaged: 0 });
      const replay = await service.capture({
        scope,
        sourceId: "session-1",
        bytes,
        mediaType: "text/plain",
        kind: "sessions",
      });
      expect(replay).toMatchObject({ captureId: pending.captureId, status: "captured", replayed: true });
      await expect(service.read(scope, replay.captureId)).resolves.toEqual(new Uint8Array(bytes));

      store.failCommits = 1;
      const local = await service.capture({
        scope,
        sourceId: "other-source",
        bytes: Buffer.from("database down"),
        mediaType: "text/plain",
        kind: "sources",
      });
      expect(local.status).toBe("captured_local_pending");
      await expect(service.read(scope, local.captureId)).resolves.toEqual(new Uint8Array(Buffer.from("database down")));
      const committed = await service.capture({
        scope,
        sourceId: "other-source",
        bytes: Buffer.from("database down"),
        mediaType: "text/plain",
        kind: "sources",
      });
      expect(committed).toMatchObject({ captureId: local.captureId, status: "captured", replayed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing raw file is damaged and is not compiled", async () => {
    const opened = await openArchive();
    try {
      const saved = await opened.service.capture({
        scope,
        sourceId: "notes",
        bytes: Buffer.from("keep me"),
        mediaType: "text/plain",
        kind: "sources",
      });
      const fingerprint = authorityScopeFingerprint(scope);
      const manifest = await opened.archive.findManifest(fingerprint, saved.captureId);
      expect(manifest?.relativePath.startsWith("wiki/")).toBe(false);
      await rm(join(opened.root, fingerprint, manifest!.relativePath));
      await expect(opened.service.read(scope, saved.captureId)).rejects.toBeInstanceOf(SourceCaptureError);
      const jobs: string[] = [];
      const compensated = await opened.service.compensate(async () => {
        jobs.push("unexpected");
        return "job";
      });
      expect(jobs).toEqual([]);
      expect(compensated.enqueued).toBe(0);
      expect((await opened.store.findByCaptureId(fingerprint, saved.captureId))?.status).toBe("damaged");
      await expect(opened.service.capture({
        scope,
        sourceId: "notes",
        revision: "rev-1",
        bytes: Buffer.from("one"),
        mediaType: "text/plain",
        kind: "sources",
      })).resolves.toMatchObject({ status: "captured" });
      await expect(opened.service.capture({
        scope,
        sourceId: "notes",
        revision: "rev-1",
        bytes: Buffer.from("two"),
        mediaType: "text/plain",
        kind: "sources",
      })).rejects.toMatchObject({ code: "CAPTURE_REVISION_CONFLICT" });
    } finally {
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  test("binary capture stays pending and session close does not create a wiki claim", async () => {
    const opened = await openArchive();
    try {
      const binary = await opened.service.capture({
        scope,
        sourceId: "blob",
        bytes: Uint8Array.from([0, 255, 1]),
        mediaType: "application/octet-stream",
        kind: "events",
      });
      expect(binary.status).toBe("captured");
      const compensated = await opened.service.compensate(async () => "job");
      expect(compensated).toEqual({ enqueued: 0, damaged: 0, pending: 1 });
      expect((await opened.store.listPending(undefined, 10))).toHaveLength(1);

      const repository = new InMemorySessionWorkingSetRepository();
      const workingSet = new SessionWorkingSetService(repository, { now: () => 1_000 });
      const executeMemoryWrite = vi.fn();
      const bridge = new SessionWorkingSetMemoryBridge({
        repository,
        memoryWrite: { executeMemoryWrite },
        serverAuthority: { tenantId: scope.tenantId, userId: scope.userId, sessionId: "session-1" },
      });
      const payload = Buffer.from("tests passed");
      await workingSet.ingestToolPair({
        scope,
        sessionId: "session-1",
        taskBoundaryId: "task-1",
        toolCallId: "call-1",
        toolName: "npm-test",
        sourceMessageIds: ["tool-1", "result-1"],
        payloadRef: {
          provider: "session_log",
          locator: "payload-1",
          contentHash: createHash("sha256").update(payload).digest("hex"),
          byteLength: payload.byteLength,
        },
        outcome: "success",
        summary: "npm-test success payload-1",
        replaceability: 0.8,
        evidenceRefs: ["evidence-1"],
        riskFlags: [],
        idempotencyKey: "ingest-1",
      });
      const closed = await workingSet.closeSession(scope, "session-1");
      const retained = await workingSet.runRetentionCleanup();
      const assembled = await workingSet.assemble({
        scope,
        sessionId: "session-1",
        messages: [{ id: "user", role: "user", content: "hello" }],
        contextWindow: 100,
        protectedMessageIds: ["user"],
      });
      expect(closed).not.toHaveProperty("memoryId");
      expect(closed).not.toHaveProperty("captureId");
      expect(JSON.stringify(retained)).not.toContain("\"memoryId\"");
      expect(assembled).not.toHaveProperty("memoryId");
      expect(executeMemoryWrite).not.toHaveBeenCalled();
      expect(bridge.dependencies.memoryWrite.executeMemoryWrite).toBe(executeMemoryWrite);
    } finally {
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  test("postgres commit is one transaction and a duplicate delivery does not insert again", async () => {
    const root = await mkdtemp(join(tmpdir(), "mengshu-raw-pg-"));
    const sql: string[] = [];
    let saved: Record<string, unknown> | undefined;
    const client = {
      query: async (statement: string, params: readonly unknown[] = []) => {
        sql.push(statement);
        if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("INSERT INTO mengshu_source_captures")) {
          saved = {
            scope_fingerprint: params[0],
            capture_id: params[1],
            idempotency_key: params[2],
            source_id: params[3],
            revision: params[4],
            payload_hash: params[5],
            manifest: params[6],
            status: "captured",
            outbox_status: "pending",
            trace_id: params[7],
            job_id: null,
            occurred_at: params[8],
          };
          return { rows: [], rowCount: 1 };
        }
        if (statement.includes("idempotency_key = $2")) {
          return { rows: saved ? [saved] : [], rowCount: saved ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    try {
      const service = new SourceCaptureService({
        archive: new FileRawArchive({ root }),
        store: new PostgresSourceCaptureStore({ connect: async () => client }),
        now: () => 70,
      });
      const bytes = Buffer.from("pg capture");
      const first = await service.capture({
        scope,
        sourceId: "pg-source",
        bytes,
        mediaType: "text/plain",
        kind: "sources",
      });
      const second = await service.capture({
        scope,
        sourceId: "pg-source",
        bytes,
        mediaType: "text/plain",
        kind: "sources",
      });
      expect(first.replayed).toBe(false);
      expect(second).toMatchObject({ captureId: first.captureId, replayed: true, status: "captured" });
      const text = sql.join("\n");
      expect(text).toContain("BEGIN");
      expect(text).toContain("COMMIT");
      expect(text).not.toMatch(/llm|embedding/i);
      expect(sql.filter((statement) => statement.includes("INSERT INTO mengshu_source_captures"))).toHaveLength(1);
      await expect(service.read(scope, first.captureId)).resolves.toEqual(new Uint8Array(bytes));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ingestion returns local pending without chunk writes when the capture commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mengshu-raw-ingest-"));
    try {
      const captureStore = new InMemorySourceCaptureStore();
      captureStore.failCommits = 1;
      const capture = new SourceCaptureService({
        archive: new FileRawArchive({ root }),
        store: captureStore,
        now: () => 80,
      });
      const memory = new InMemoryMemoryStore({ now: () => 80 });
      const pipeline = new IngestionPipeline({
        documents: memory.documents,
        chunks: memory.chunks,
        jobs: memory.jobs,
        audit: memory.audit,
        sourceCapture: capture,
      });
      const result = await pipeline.ingest({
        scope,
        sourceId: "guide.md",
        content: "# Guide\n\nalpha",
      });
      expect(result.capture?.status).toBe("captured_local_pending");
      expect(result.chunksAdmitted).toBe(0);
      expect(result.jobsQueued).toBe(0);
      await expect(memory.documents.list({ scope })).resolves.toEqual([]);
      const bytes = await capture.read(scope, result.documentId);
      expect(Buffer.from(bytes).toString("utf8")).toContain("alpha");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
