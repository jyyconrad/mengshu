import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { describe, expect, test } from "vitest";
import { PostgresEvolutionError } from "../../packages/core/src/evolution/postgres-common.js";
import { PostgresEvolutionMaintenancePort } from "../../packages/core/src/evolution/postgres-maintenance.js";
import { PostgresEvolutionSourceReconciliationPort } from "../../packages/core/src/evolution/postgres-source-reconciliation.js";
import { writeEvolutionLink } from "../../packages/core/src/evolution/governed-metadata.js";
import { DirectorySourceScanner } from "../../packages/core/src/evolution/sources/index.js";
import { reconcileSourceScan } from "../../packages/core/src/evolution/sources/reconciliation.js";
import { recordToMemoryEntry } from "../../packages/core/src/domain/legacy-mapping.js";
import { EvolutionQueryBoundaryError } from "../../packages/core/src/storage/repositories/evolution-query-pool.js";
import { createPostgresRolloutSeed, openPostgresRollout, type PostgresRollout } from "../fixtures/memory-evolution-rollout/postgres.js";

const live = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const snapshot = async (h: PostgresRollout, id: string) => (await h.pool.query("SELECT text,content_hash,metadata FROM memories WHERE id=$1", [id])).rows[0];
const effects = async (h: PostgresRollout) => (await h.pool.query(`SELECT
  (SELECT count(*)::int FROM mengshu_evolution_apply_receipts) AS applies,
  (SELECT count(*)::int FROM mengshu_evolution_operation_receipts) AS operations,
  (SELECT count(*)::int FROM mengshu_write_outbox) AS outbox`)).rows[0];

// Always install a rejection handler immediately, before polling the actual blocked backend.
function settled(work: Promise<unknown>) {
  return work.then(() => ({ ok: true, code: "" }), error => ({ ok: false,
    code: error instanceof PostgresEvolutionError ? error.code : "unexpected_non_transaction_error" }));
}

async function blocker(h: PostgresRollout): Promise<pg.PoolClient> {
  const client = await h.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    return client;
  } catch (error) { client.release(error instanceof Error ? error : new Error("blocker_setup_failed")); throw error; }
}

async function releaseBlocker(client: pg.PoolClient | undefined) {
  if (!client) return;
  try { await client.query("ROLLBACK"); }
  finally { client.release(); }
}

async function blockedBackend(h: PostgresRollout, blockerPid: number, tag: string) {
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline) {
    const result = await h.pool.query<{ pid: number; at_expected_lock: boolean }>(`SELECT pid,query LIKE $2 AS at_expected_lock
      FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
      AND $1=ANY(pg_blocking_pids(pid))`, [blockerPid, `%${tag}%`]);
    if (result.rows.length) {
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].at_expected_lock).toBe(true);
      return result.rows[0].pid;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("real_postgres_lock_wait_not_observed");
}

async function connectionState(h: PostgresRollout) {
  const result = await h.persistence.repository.mutation(client => client.query<{ pid: number; lock_timeout: string }>(
    "SELECT pg_backend_pid() AS pid,current_setting('lock_timeout') AS lock_timeout"));
  expect(result.rows[0].lock_timeout).toBe("250ms");
  return result.rows[0].pid;
}

async function assertReleased(h: PostgresRollout, pid: number) {
  const state = await h.pool.query<{ state: string; no_transaction: boolean }>(
    "SELECT state,xact_start IS NULL AND backend_xid IS NULL AS no_transaction FROM pg_stat_activity WHERE pid=$1", [pid]);
  if (state.rows.length) expect(state.rows).toEqual([{ state: "idle", no_transaction: true }]);
  const reused = await connectionState(h);
  // This isolated provider has only one SQL operation at a time: reuse, or a safely discarded backend.
  if (state.rows.length) expect(reused).toBe(pid);
}

async function runningJob(h: PostgresRollout, signal?: AbortSignal) {
  const bundle = h.provider.createDurableJobV2RuntimeBundle({ enableMemoryEvolution: true,
    clock: Date.now, tokenFactory: randomUUID, backoffMs: () => 10 });
  await bundle.assertReady();
  const { batch } = await h.lease();
  const { tenantId, userId, appId, projectId, agentId, namespace, visibility } = h.scope;
  const scope = { tenantId, userId, appId, projectId, agentId, namespace, visibility: visibility! };
  const queued = await bundle.repository.enqueue({ id: randomUUID(), type: "evolve_memory_batch", scope,
    payload: { batchId: batch.id, segmentAttempt: 1 }, dedupeKey: randomUUID(), maxAttempts: 2 });
  const leased = await bundle.repository.lease({ scope, owner: "synthetic-lock-worker", leaseMs: 120_000, idAllowlist: [queued.id] });
  expect(leased.applied).toBe(1);
  if (!leased.job?.leaseToken || leased.job.status !== "running") throw new Error("actual_pg_job_lease_required");
  // Actual provider factory and actual database lease, never a synthetic running-job object or branded copy.
  const persistence = bundle.createEvolutionPersistence!(h.scope, { job: leased.job, signal });
  return { job: leased.job, persistence };
}

describe.skipIf(!live)("rollout R11: real isolated PostgreSQL waits, cancellation, retention priority and source limit; no model", () => {
  test.each(["job", "row"] as const)("first %s lock has the native 250ms timeout, rollback and a released connection", async lock => {
    const h = await openPostgresRollout();
    let foreground: pg.PoolClient | undefined;
    let pending: ReturnType<typeof settled> | undefined;
    try {
      const seed = await h.seed("The synthetic lock timeout must preserve the original record.");
      const native = await runningJob(h);
      const before = await snapshot(h, seed.rawId), beforeEffects = await effects(h);
      const expectedPid = await connectionState(h);
      foreground = await blocker(h);
      const blockerPid = (await foreground.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if (lock === "job") await foreground.query("SELECT id FROM mengshu_jobs_v2 WHERE id=$1 FOR UPDATE", [native.job.id]);
      else await foreground.query("SELECT id FROM memories WHERE id=$1 FOR UPDATE", [seed.id]);
      let enteredWork = false;
      const started = performance.now();
      pending = settled(native.persistence.repository.mutation(async client => {
        enteredWork = true;
        await client.query("UPDATE memories SET metadata=jsonb_set(metadata,'{rollbackProbe}','true'::jsonb) WHERE id=$1", [seed.rawId]);
        await client.query("/* rollout:row-lock-timeout */ SELECT id FROM memories WHERE id=$1 FOR UPDATE", [seed.id]);
      }));
      const pid = await blockedBackend(h, blockerPid, lock === "job" ? "evolution:job-fence" : "rollout:row-lock-timeout");
      expect(pid).toBe(expectedPid);
      expect(await pending).toEqual({ ok: false, code: "LOCK_BUSY" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(180);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(enteredWork).toBe(lock === "row");
      expect(await snapshot(h, seed.rawId)).toEqual(before);
      expect(await effects(h)).toEqual(beforeEffects);
      await assertReleased(h, pid);
    } finally {
      try { await releaseBlocker(foreground); }
      finally { try { await pending; } finally { await h.close(); } }
    }
  }, 120_000);

  test("abort while a real row SQL is waiting rolls back earlier writes and releases the provider connection", async () => {
    const h = await openPostgresRollout();
    let foreground: pg.PoolClient | undefined;
    let pending: ReturnType<typeof settled> | undefined;
    try {
      const seed = await h.seed("The synthetic cancelled transaction must not commit its marker.");
      const controller = new AbortController();
      const native = await runningJob(h, controller.signal);
      const before = await snapshot(h, seed.rawId), beforeEffects = await effects(h);
      const expectedPid = await connectionState(h);
      foreground = await blocker(h);
      const blockerPid = (await foreground.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await foreground.query("SELECT id FROM memories WHERE id=$1 FOR UPDATE", [seed.id]);
      let innerCode: string | undefined;
      let afterWait = false;
      pending = settled(native.persistence.repository.mutation(async client => {
        await client.query("UPDATE memories SET metadata=jsonb_set(metadata,'{cancelRollbackProbe}','true'::jsonb) WHERE id=$1", [seed.rawId]);
        try { await client.query("/* rollout:cancel-row-wait */ SELECT id FROM memories WHERE id=$1 FOR UPDATE", [seed.id]); }
        catch (error) { if (error instanceof EvolutionQueryBoundaryError) innerCode = error.code; throw error; }
        afterWait = true;
      }));
      const pid = await blockedBackend(h, blockerPid, "rollout:cancel-row-wait");
      expect(pid).toBe(expectedPid);
      const cancelledAt = performance.now();
      controller.abort();
      // Let the bounded in-flight SQL return; cancellation must reject before executing subsequent work/COMMIT.
      await foreground.query("ROLLBACK");
      foreground.release(); foreground = undefined;
      expect(await pending).toEqual({ ok: false, code: "TRANSACTION_FAILED" });
      expect(innerCode).toBe("EVOLUTION_QUERY_CANCELLED");
      expect(afterWait).toBe(false);
      expect(performance.now() - cancelledAt).toBeLessThan(2000);
      expect(await snapshot(h, seed.rawId)).toEqual(before);
      expect(await effects(h)).toEqual(beforeEffects);
      await assertReleased(h, pid);
    } finally {
      try { await releaseBlocker(foreground); }
      finally { try { await pending; } finally { await h.close(); } }
    }
  }, 120_000);

  test("retention returns stale immediately behind a foreground writer, retaining raw and creating no delete receipt", async () => {
    const h = await openPostgresRollout();
    let foreground: pg.PoolClient | undefined;
    try {
      const raw = await h.seed("The synthetic expired orphan remains readable while a foreground writer owns the table.", { rawOnly: true, expiresAt: Date.now() - 1000 });
      const liveRecord = await h.seed("The synthetic foreground write takes precedence over retention.");
      const { lease } = await h.lease();
      const port = new PostgresEvolutionMaintenancePort({ repository: h.persistence.repository });
      const candidate = (await port.listExpired({ scope: h.scope, before: Date.now(), limit: 10 })).find(item => item.id === raw.rawId)!;
      expect(candidate).toBeDefined();
      const before = await snapshot(h, raw.rawId), beforeEffects = await effects(h);
      const pid = await connectionState(h);
      foreground = await blocker(h);
      await foreground.query("UPDATE memories SET metadata=jsonb_set(metadata,'{foregroundMarker}','true'::jsonb) WHERE id=$1", [liveRecord.id]);
      const started = performance.now();
      expect(await port.cleanupUnreferenced({ scope: h.scope, candidate, lease })).toEqual({ status: "stale" });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(await snapshot(h, raw.rawId)).toEqual(before);
      expect(await effects(h)).toEqual(beforeEffects);
      await foreground.query("UPDATE memories SET metadata=jsonb_set(metadata,'{foregroundStillWritable}','true'::jsonb) WHERE id=$1", [liveRecord.id]);
      await foreground.query("COMMIT");
      foreground.release(); foreground = undefined;
      expect((await snapshot(h, liveRecord.id)).metadata.foregroundStillWritable).toBe(true);
      await expect(h.evidenceReader.read(h.scope, [{ ref: raw.rawId, source: "memory" }])).resolves.toMatchObject([{ preview: raw.text }]);
      await assertReleased(h, pid);
    } finally {
      try { await releaseBlocker(foreground); }
      finally { await h.close(); }
    }
  }, 120_000);

  test("257 source relations reject the whole revoke transaction without consuming administrative approval or reporting suppression", async () => {
    const h = await openPostgresRollout();
    let scanner: DirectorySourceScanner | undefined;
    try {
      const sourceId = "synthetic-over-limit", sourceRoot = join(h.root, "source");
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, "claim.md"), "A synthetic source with bounded administrative retirement.\n");
      scanner = await DirectorySourceScanner.create({ binding: { sourceId, root: sourceRoot, scope: h.scope, parser: "markdown" }, manifestPath: join(h.root, "state", "manifest.json") });
      const { lease } = await h.lease();
      const port = new PostgresEvolutionSourceReconciliationPort({ repository: h.persistence.repository, sourceId,
        configFingerprint: scanner.configFingerprint, authorizeAdministrativeReview: h.hostState.administrativeReviewGuard });
      const source = await reconcileSourceScan({ scanner, port, lease });
      const target = await h.seed("The synthetic source-limit target retains every historical reference.", { sourceId });
      const embedding = { embeddingSpaceId: String(target.raw.metadata.embeddingSpaceId), vector: target.raw.vector! };
      const raws = [target.raw, ...Array.from({ length: 256 }, (_, index) => createPostgresRolloutSeed(`Synthetic reference number ${index}.`, embedding, { sourceId }).raw)];
      await h.provider.store(raws.slice(1).map(raw => recordToMemoryEntry(raw)));
      // Synthetic reviewed relation seeding only. No content apply or independent author support is claimed.
      for (let offset = 0; offset < raws.length; offset += 32) await h.persistence.repository.mutation(async client => {
        for (const raw of raws.slice(offset, offset + 32)) await writeEvolutionLink(client, { scope: h.scope, scopeFingerprint: h.scopeFingerprint,
          memoryId: target.id, evidenceId: raw.id, now: Date.now(), state: "reviewed_reference", rootId: `synthetic-root:${raw.id}`,
          sourceId, sourceRevision: source.plan.snapshotHash, sourceHash: source.plan.snapshotHash, sourceKind: "untrusted", sourceRecordId: raw.id });
      });
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_memory_evidence_links WHERE source_id=$1", [sourceId])).rows[0].n).toBe(257);
      const stateBefore = (await h.pool.query("SELECT * FROM mengshu_evolution_source_dispositions WHERE source_id=$1 ORDER BY logical_file_id", [sourceId])).rows;
      const before = await snapshot(h, target.id), beforeEffects = await effects(h);
      const key = "source-over-limit-revoke";
      const approval = await h.owner(() => h.attestation.control.revokeSource({ sourceId, sourceRevision: source.plan.snapshotHash,
        expectedRevision: 0, idempotencyKey: "over-limit-owner-approval", operationIdempotencyKey: key, expiresAt: Date.now() + 60_000 }));
      const request = { scope: h.scope, sourceId, expectedRevision: source.plan.snapshotHash, reviewReceiptId: approval.id, idempotencyKey: key, lease };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(port.revoke(request)).rejects.toMatchObject({ code: "SOURCE_RELATION_LIMIT" });
        expect((await h.pool.query("SELECT consumed_by,consumed_at FROM mengshu_evolution_host_receipts WHERE receipt_id=$1", [approval.id])).rows)
          .toEqual([{ consumed_by: null, consumed_at: null }]);
        expect((await h.pool.query("SELECT relation_state,count(*)::int AS n FROM mengshu_memory_evidence_links WHERE source_id=$1 GROUP BY relation_state", [sourceId])).rows)
          .toEqual([{ relation_state: "reviewed_reference", n: 257 }]);
        expect((await h.pool.query("SELECT * FROM mengshu_evolution_source_dispositions WHERE source_id=$1 ORDER BY logical_file_id", [sourceId])).rows).toEqual(stateBefore);
        expect(await snapshot(h, target.id)).toEqual(before);
        expect(await effects(h)).toEqual(beforeEffects);
      }
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_evolution_operation_receipts WHERE operation='source_revoke'")).rows[0].n).toBe(0);
      await expect(h.evidenceReader.read(h.scope, [{ ref: target.rawId, source: "memory" }])).resolves.toMatchObject([{ preview: target.text }]);
    } finally { try { await scanner?.close(); } finally { await h.close(); } }
  }, 120_000);
});
