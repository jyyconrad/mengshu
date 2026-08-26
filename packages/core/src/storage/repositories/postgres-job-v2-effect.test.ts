import { describe, expect, test, vi } from "vitest";
import type { DurableJobV2Scope } from "./job-v2.js";
import {
  POSTGRESQL_18_RELATION_KEYWORDS,
  PostgresDurableJobV2EffectRepository,
  createPostgresProviderOwnedDomainEffectRunner,
  type PostgresDurableJobV2EffectClient,
  type PostgresDurableJobV2EffectQueryResult,
} from "./postgres-job-v2-effect.js";

const scope: DurableJobV2Scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "default",
  visibility: "private",
});

const fingerprint = "a".repeat(64);

interface FakeJob {
  id: string;
  status: "running";
  scope: DurableJobV2Scope;
  owner: string;
  token: string;
  generation: number;
  leaseUntil: number;
}

interface ReceiptRow {
  job_id: string;
  effect_key: string;
  request_fingerprint: string;
  lease_generation: number;
  result: Record<string, unknown>;
  committed_at: number;
}

class TransactionalFakeClient implements PostgresDurableJobV2EffectClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  released = false;
  releaseFailure?: Error;
  failNextDomainWrite = false;
  commitAppliedThenThrow = false;
  domainWriteGate?: Promise<void>;

  private inTransaction = false;
  private txEffects = new Set<string>();
  private txReceipts = new Map<string, ReceiptRow>();

  constructor(
    readonly job: FakeJob,
    readonly effects: Set<string>,
    readonly receipts: Map<string, ReceiptRow>,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresDurableJobV2EffectQueryResult<Row>> {
    const normalized = sql.trim().replace(/\s+/g, " ");
    this.calls.push({ sql: normalized, params });
    if (normalized === "BEGIN") {
      this.inTransaction = true;
      this.txEffects = new Set(this.effects);
      this.txReceipts = new Map(this.receipts);
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "COMMIT") {
      this.effects.clear();
      for (const value of this.txEffects) this.effects.add(value);
      this.receipts.clear();
      for (const [key, value] of this.txReceipts) this.receipts.set(key, value);
      this.inTransaction = false;
      if (this.commitAppliedThenThrow) {
        this.commitAppliedThenThrow = false;
        throw new Error("raw commit socket failure with secret details");
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized === "ROLLBACK") {
      this.inTransaction = false;
      return { rows: [], rowCount: 0 };
    }
    if (!this.inTransaction && !/^SELECT\b/.test(normalized)) {
      throw new Error("query escaped transaction");
    }

    if (/SELECT job_id, effect_key/.test(normalized)) {
      const key = `${String(params[0])}:${String(params[1])}`;
      const row = (this.inTransaction ? this.txReceipts : this.receipts).get(key);
      return { rows: row ? [row as unknown as Row] : [], rowCount: row ? 1 : 0 };
    }

    if (/INSERT INTO \"?domain_effects\"?/.test(normalized)) {
      await this.domainWriteGate;
      if (this.failNextDomainWrite) {
        this.failNextDomainWrite = false;
        throw new Error("simulated process failure");
      }
      this.txEffects.add(String(params[0]));
      return { rows: [], rowCount: 1 };
    }

    if (/INSERT INTO \"?mengshu_candidates\"?/.test(normalized)) {
      this.txEffects.add(String(params[0]));
      return {
        rows: /\bRETURNING\s+id\b/.test(normalized)
          ? [{ id: String(params[0]) } as unknown as Row]
          : [],
        rowCount: 1,
      };
    }

    if (/^(?:SELECT|UPDATE|DELETE)\b.*\bdomain_effects\b/.test(normalized)) {
      return { rows: [], rowCount: 0 };
    }

    if (/INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
      const [jobId, effectKey, requestFingerprint, leaseGeneration, resultJson, committedAt,
        tenantId, userId, appId, projectId, agentId, namespace, visibility, owner, token,
        currentGeneration, now] = params;
      const matches = this.job.id === jobId && this.job.scope.tenantId === tenantId &&
        this.job.scope.userId === userId && this.job.scope.appId === appId &&
        this.job.scope.projectId === projectId && this.job.scope.agentId === agentId &&
        this.job.scope.namespace === namespace && this.job.scope.visibility === visibility &&
        this.job.owner === owner && this.job.token === token &&
        this.job.generation === currentGeneration && this.job.leaseUntil > Number(now);
      if (!matches) return { rows: [], rowCount: 0 };
      const row: ReceiptRow = {
        job_id: String(jobId),
        effect_key: String(effectKey),
        request_fingerprint: String(requestFingerprint),
        lease_generation: Number(leaseGeneration),
        result: JSON.parse(String(resultJson)) as Record<string, unknown>,
        committed_at: Number(committedAt),
      };
      this.txReceipts.set(`${row.job_id}:${row.effect_key}`, row);
      return { rows: [row as unknown as Row], rowCount: 1 };
    }

    if (/FROM mengshu_jobs_v2/.test(normalized)) {
      const [id, tenantId, userId, appId, projectId, agentId, namespace, visibility,
        owner, token, generation, now] = params;
      const matches = this.job.id === id && this.job.scope.tenantId === tenantId &&
        this.job.scope.userId === userId && this.job.scope.appId === appId &&
        this.job.scope.projectId === projectId && this.job.scope.agentId === agentId &&
        this.job.scope.namespace === namespace && this.job.scope.visibility === visibility &&
        this.job.owner === owner && this.job.token === token &&
        this.job.generation === generation && this.job.leaseUntil > Number(now);
      return {
        rows: matches ? [{ id: this.job.id } as unknown as Row] : [],
        rowCount: matches ? 1 : 0,
      };
    }

    throw new Error(`unexpected SQL: ${normalized}`);
  }

  release(): void {
    this.released = true;
    if (this.releaseFailure) throw this.releaseFailure;
  }
}

function harness(clockValues: number[] = [100, 110]) {
  const effects = new Set<string>();
  const receipts = new Map<string, ReceiptRow>();
  const job: FakeJob = {
    id: "job-1",
    status: "running",
    scope,
    owner: "worker-1",
    token: "t".repeat(32),
    generation: 1,
    leaseUntil: 1_000,
  };
  const clients: TransactionalFakeClient[] = [];
  const clock = vi.fn(() => clockValues.shift() ?? 110);
  const pool = {
    connect: vi.fn(async () => {
      const client = new TransactionalFakeClient(job, effects, receipts);
      clients.push(client);
      return client;
    }),
  };
  return {
    effects,
    receipts,
    job,
    clients,
    pool,
    repository: new PostgresDurableJobV2EffectRepository(pool, {
      clock,
      allowedRelations: ["domain_effects"],
    }),
  };
}

function input(overrides: Partial<Parameters<PostgresDurableJobV2EffectRepository["execute"]>[0]> = {}) {
  return {
    id: "job-1",
    scope,
    owner: "worker-1",
    leaseToken: "t".repeat(32),
    leaseGeneration: 1,
    effectKey: "extract_candidate.persist",
    requestFingerprint: fingerprint,
    ...overrides,
  };
}

describe("PostgresDurableJobV2EffectRepository", () => {
  test("provider-owned domain runner 复用同一 fence/receipt 事务并允许固定 SELECT", async () => {
    const h = harness();
    const runner = createPostgresProviderOwnedDomainEffectRunner(h.repository);

    const result = await runner.execute(input(), async (client) => {
      await client.query("SELECT id FROM domain_effects WHERE id = $1", ["effect-1"]);
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    });

    expect(result).toMatchObject({ status: "applied" });
    expect(h.effects).toEqual(new Set(["effect-1"]));
    expect(h.clients[0]?.calls.map((call) => call.sql)).toContain(
      "SELECT id FROM domain_effects WHERE id = $1",
    );
    expect(h.clients[0]?.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("业务副作用与 receipt 使用同一事务，并在 commit 前再次验证持久 lease fence", async () => {
    const h = harness();

    const result = await h.repository.execute(input(), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    });

    expect(result).toMatchObject({ status: "applied", receipt: { leaseGeneration: 1 } });
    expect(h.effects).toEqual(new Set(["effect-1"]));
    expect(h.receipts).toHaveLength(1);
    expect(h.clients[0]?.calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/SELECT id FROM mengshu_jobs_v2.+FOR UPDATE/),
      expect.stringMatching(/SELECT job_id, effect_key/),
      "INSERT INTO domain_effects (id) VALUES ($1)",
      expect.stringMatching(/INSERT INTO mengshu_job_v2_effect_receipts.+SELECT.+mengshu_jobs_v2/),
      "COMMIT",
    ]);
    expect(h.clients[0]?.released).toBe(true);
  });

  test("已有相同 fingerprint receipt 时跨 lease generation replay 且不重放副作用", async () => {
    const h = harness([200]);
    h.job.owner = "worker-2";
    h.job.token = "u".repeat(32);
    h.job.generation = 2;
    h.receipts.set("job-1:extract_candidate.persist", {
      job_id: "job-1",
      effect_key: "extract_candidate.persist",
      request_fingerprint: fingerprint,
      lease_generation: 1,
      result: { candidateIds: ["candidate-1"] },
      committed_at: 110,
    });
    const work = vi.fn(async () => ({ candidateIds: ["candidate-2"] }));

    const result = await h.repository.execute(input({
      owner: "worker-2",
      leaseToken: "u".repeat(32),
      leaseGeneration: 2,
    }), work);

    expect(result).toMatchObject({ status: "replayed", receipt: { leaseGeneration: 1 } });
    expect(work).not.toHaveBeenCalled();
  });

  test("provider-owned replay preflight 只读命中 receipt，不开启第二个事务裁决点", async () => {
    const h = harness([200]);
    h.job.owner = "worker-2";
    h.job.token = "u".repeat(32);
    h.job.generation = 2;
    h.receipts.set("job-1:extract_candidate.persist", {
      job_id: "job-1",
      effect_key: "extract_candidate.persist",
      request_fingerprint: fingerprint,
      lease_generation: 1,
      result: { candidateIds: ["candidate-1"] },
      committed_at: 110,
    });
    const runner = createPostgresProviderOwnedDomainEffectRunner(h.repository);

    const result = await runner.inspectReplay(input({
      owner: "worker-2",
      leaseToken: "u".repeat(32),
      leaseGeneration: 2,
    }));

    expect(result).toMatchObject({ status: "replayed", receipt: { leaseGeneration: 1 } });
    expect(h.clients[0]?.calls.map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
    ]);
    expect(h.clients[0]?.calls.some(({ sql }) => /BEGIN|COMMIT|ROLLBACK|FOR UPDATE/.test(sql)))
      .toBe(false);
    expect(h.clients[0]?.released).toBe(true);
  });

  test("claim 后 effect 抛错会整体回滚，下一 generation 能安全重试且只提交一次", async () => {
    const h = harness([100, 200, 210]);
    const firstClient = new TransactionalFakeClient(h.job, h.effects, h.receipts);
    firstClient.failNextDomainWrite = true;
    h.pool.connect.mockResolvedValueOnce(firstClient);

    await expect(h.repository.execute(input(), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    })).rejects.toThrow("simulated process failure");
    expect(h.effects.size).toBe(0);
    expect(h.receipts.size).toBe(0);
    expect(firstClient.calls.at(-1)?.sql).toBe("ROLLBACK");

    h.job.owner = "worker-2";
    h.job.token = "u".repeat(32);
    h.job.generation = 2;
    h.job.leaseUntil = 2_000;
    await h.repository.execute(input({
      owner: "worker-2",
      leaseToken: "u".repeat(32),
      leaseGeneration: 2,
    }), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    });

    expect(h.effects).toEqual(new Set(["effect-1"]));
    expect(h.receipts).toHaveLength(1);
  });

  test("effect 执行期间 lease 过期时 commit fence 失败并回滚 effect", async () => {
    const h = harness([100, 1_001]);

    await expect(h.repository.execute(input(), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_LEASE_LOST" });

    expect(h.effects.size).toBe(0);
    expect(h.receipts.size).toBe(0);
    expect(h.clients[0]?.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("commit ACK 后 release 失败保持 receipt，可由后续 generation replay", async () => {
    const h = harness([100, 110, 200]);
    const firstClient = new TransactionalFakeClient(h.job, h.effects, h.receipts);
    firstClient.releaseFailure = new Error("release failed after commit");
    h.pool.connect.mockResolvedValueOnce(firstClient);

    await expect(h.repository.execute(input(), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    })).rejects.toMatchObject({
      code: "DURABLE_JOB_EFFECT_RELEASE_FAILED",
      retryable: true,
      message: "Durable job effect connection release failed",
    });
    expect(h.effects).toEqual(new Set(["effect-1"]));
    expect(h.receipts).toHaveLength(1);

    h.job.owner = "worker-2";
    h.job.token = "u".repeat(32);
    h.job.generation = 2;
    const work = vi.fn(async () => ({ candidateIds: ["candidate-2"] }));
    const replay = await h.repository.execute(input({
      owner: "worker-2",
      leaseToken: "u".repeat(32),
      leaseGeneration: 2,
    }), work);
    expect(replay.status).toBe("replayed");
    expect(work).not.toHaveBeenCalled();
  });

  test("COMMIT 已落盘但 ACK 抛错时只返回脱敏 uncertain，下一 generation 从 receipt replay", async () => {
    const h = harness([100, 110, 200]);
    const firstClient = new TransactionalFakeClient(h.job, h.effects, h.receipts);
    firstClient.commitAppliedThenThrow = true;
    h.pool.connect.mockResolvedValueOnce(firstClient);

    const first = h.repository.execute(input(), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { candidateIds: ["candidate-1"] };
    });
    await expect(first).rejects.toMatchObject({
      code: "DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN",
      retryable: true,
      message: "Durable job effect outcome is uncertain",
    });
    await expect(first).rejects.not.toThrow(/socket|secret/i);
    expect(h.effects).toEqual(new Set(["effect-1"]));
    expect(h.receipts).toHaveLength(1);

    h.job.owner = "worker-2";
    h.job.token = "u".repeat(32);
    h.job.generation = 2;
    const work = vi.fn(async () => ({ candidateIds: ["candidate-2"] }));
    await expect(h.repository.execute(input({
      owner: "worker-2",
      leaseToken: "u".repeat(32),
      leaseGeneration: 2,
    }), work)).resolves.toMatchObject({ status: "replayed" });
    expect(work).not.toHaveBeenCalled();
    expect(h.effects).toEqual(new Set(["effect-1"]));
  });

  test("stale fence 不运行 effect，receipt fingerprint 冲突 fail-closed", async () => {
    const stale = harness([1_001]);
    const staleWork = vi.fn(async () => ({ ok: true }));
    await expect(stale.repository.execute(input(), staleWork)).resolves.toEqual({ status: "stale" });
    expect(staleWork).not.toHaveBeenCalled();

    const mismatch = harness([100]);
    mismatch.receipts.set("job-1:extract_candidate.persist", {
      job_id: "job-1",
      effect_key: "extract_candidate.persist",
      request_fingerprint: "b".repeat(64),
      lease_generation: 1,
      result: { ok: true },
      committed_at: 90,
    });
    await expect(mismatch.repository.execute(input(), async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH" });
  });

  test("拒绝来自未来 lease generation 的 receipt", async () => {
    const h = harness([100]);
    h.receipts.set("job-1:extract_candidate.persist", {
      job_id: "job-1",
      effect_key: "extract_candidate.persist",
      request_fingerprint: fingerprint,
      lease_generation: 2,
      result: { ok: true },
      committed_at: 90,
    });

    await expect(h.repository.execute(input(), async () => ({ ok: true })))
      .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_INVALID_RECEIPT" });
  });

  test("输入与 callback transaction escape 在数据库连接前或事务内 fail-closed", async () => {
    const invalid = harness();
    await expect(invalid.repository.execute(input({ effectKey: "bad effect" }), async () => ({ ok: true })))
      .rejects.toThrow(/invalid/i);
    expect(invalid.pool.connect).not.toHaveBeenCalled();

    const escaped = harness();
    await expect(escaped.repository.execute(input(), async (client) => {
      await client.query("COMMIT");
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(escaped.clients[0]?.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test.each([
    "END",
    "ABORT",
    "PREPARE TRANSACTION 'x'",
    "CREATE TABLE escaped (id text)",
    "ALTER TABLE domain_effects ADD COLUMN escaped text",
    "DROP TABLE domain_effects",
    "TRUNCATE domain_effects",
    "CALL escaped($1)",
    "DO $$ BEGIN NULL; END $$",
    "COPY domain_effects TO STDOUT",
    "SELECT $1 INTO TEMP TABLE stolen",
    "SELECT id INTO TABLE stolen FROM domain_effects WHERE id = $1",
    "SELECT pg_advisory_lock($1) FROM domain_effects",
    "SELECT set_config($1, $2, $3) FROM domain_effects",
    "SELECT nextval($1) FROM domain_effects",
    "INSERT INTO domain_effects (id) VALUES ($1) RETURNING set_config($2, $3, $4)",
    "UPDATE domain_effects SET id = nextval($1) WHERE id = $2",
    "DELETE FROM domain_effects WHERE id IN (SELECT id FROM pg_catalog.pg_class WHERE id = $1)",
    "SELECT $1; DELETE FROM domain_effects WHERE id = $1",
    "SELECT $1 -- hidden statement",
    "SELECT /* hidden */ $1",
    "SELECT 1",
    "INSERT INTO domain_effects (id) VALUES ('literal')",
    "WITH escaped AS (DELETE FROM domain_effects RETURNING id) SELECT id FROM escaped WHERE id = $1",
    "DELETE FROM ONLY domain_effects WHERE id = $1",
    "DELETE FROM ONLY mengshu_schema_migrations WHERE version = $1",
    "DELETE FROM mengshu_jobs_v2 WHERE id = $1",
    "DELETE FROM mengshu_job_v2_effect_receipts WHERE job_id = $1",
    "INSERT INTO other_effects (id) VALUES ($1)",
    "UPDATE other_effects SET id = $1 WHERE id = $2",
    "DELETE FROM other_effects WHERE id = $1",
    "INSERT INTO domain_effects.other_effects (id) VALUES ($1)",
    "INSERT INTO public.domain_effects (id) VALUES ($1)",
    "INSERT INTO \"DOMAIN_EFFECTS\" (id) VALUES ($1)",
  ])("SQL capability 拒绝 transaction/DDL/comment/multi/non-parameterized: %s", async (sql) => {
    const h = harness();
    await expect(h.repository.execute(input(), async (client) => {
      const indexes = [...sql.matchAll(/\$([1-9][0-9]*)/g)].map((match) => Number(match[1]));
      const maxIndex = indexes.length > 0 ? Math.max(...indexes) : 0;
      await client.query(sql, Array.from({ length: maxIndex }, (_, index) => `value-${index + 1}`));
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some((call) => call.sql === sql)).toBe(false);
    expect(h.clients[0]?.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test.each([
    ["INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]],
    ["INSERT INTO \"domain_effects\" (\"id\") VALUES ($1)", ["effect-1"]],
    ["UPDATE domain_effects SET id = $1 WHERE id = $2", ["effect-2", "effect-1"]],
    ["DELETE FROM domain_effects WHERE id = $1", ["effect-1"]],
  ])("SQL capability 仅放行单条参数化业务语句: %s", async (sql, params) => {
    const h = harness();
    await expect(h.repository.execute(input(), async (client) => {
      await client.query(sql, params);
      return { ok: true };
    })).resolves.toMatchObject({ status: "applied" });
    expect(h.clients[0]?.calls.some((call) => call.sql === sql)).toBe(true);
  });

  const candidateConflictColumns = Object.freeze([
    "tenant_id", "user_id", "app_id", "project_id", "agent_id", "namespace", "visibility",
    "workspace_id", "session_id", "active_content_hash",
  ]);
  const candidateConflictTarget = `(${candidateConflictColumns.join(", ")})`;
  const candidateInsert = `INSERT INTO mengshu_candidates (
  id, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, content_hash, active_content_hash, evidence_ids, metadata
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
ON CONFLICT ${candidateConflictTarget} DO NOTHING`;
  const candidateParams = [
    "candidate-1", "tenant-a", "user-a", "app-a", "project-a", "agent-a", "default",
    "private", "workspace-a", "session-a", "a".repeat(64), "a".repeat(64), "[]", "{}",
  ];

  function candidateEffectRepository(
    h: ReturnType<typeof harness>,
    options: { returningColumns?: readonly string[] } = {},
  ) {
    return new PostgresDurableJobV2EffectRepository(h.pool, {
      clock: () => 100,
      allowedRelations: ["mengshu_candidates"],
      insertOnConflictPolicies: [{
        relation: "mengshu_candidates",
        conflictColumns: candidateConflictColumns,
        valueCasts: [
          { column: "evidence_ids", type: "jsonb" },
          { column: "metadata", type: "jsonb" },
        ],
        ...(options.returningColumns ? { returningColumns: options.returningColumns } : {}),
      }],
    });
  }

  test("exact candidate ON CONFLICT insert 在 fenced transaction 内执行并同 receipt commit", async () => {
    const h = harness();
    const repository = candidateEffectRepository(h);

    await expect(repository.execute(input(), async (client) => {
      await client.query(candidateInsert, candidateParams);
      return { candidateId: "candidate-1" };
    })).resolves.toMatchObject({
      status: "applied",
      receipt: { result: { candidateId: "candidate-1" } },
    });

    expect(h.effects).toEqual(new Set(["candidate-1"]));
    expect(h.receipts.size).toBe(1);
    const calls = h.clients[0]!.calls.map(({ sql }) => sql);
    expect(calls.findIndex((sql) => sql.startsWith("INSERT INTO mengshu_candidates")))
      .toBeLessThan(calls.findIndex((sql) => sql.startsWith("INSERT INTO mengshu_job_v2_effect_receipts")));
    expect(calls.at(-1)).toBe("COMMIT");
  });

  test("candidate conflict policy 缺失时默认拒绝 ON CONFLICT", async () => {
    const h = harness();
    const repository = new PostgresDurableJobV2EffectRepository(h.pool, {
      clock: () => 100,
      allowedRelations: ["mengshu_candidates"],
    });

    await expect(repository.execute(input(), async (client) => {
      await client.query(candidateInsert, candidateParams);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql }) => sql.startsWith("INSERT INTO mengshu_candidates")))
      .toBe(false);
  });

  test.each([
    candidateInsert.replace(`ON CONFLICT ${candidateConflictTarget}`, "ON CONFLICT"),
    candidateInsert.replace("DO NOTHING", "DO UPDATE SET active_content_hash = $12"),
    candidateInsert.replace(`${candidateConflictTarget} DO`, `${candidateConflictTarget} WHERE active_content_hash = $12 DO`),
    candidateInsert.replace(
      candidateConflictTarget,
      "ON CONSTRAINT mengshu_candidates_authority_key",
    ),
    candidateInsert.replace(candidateConflictTarget, "(tenant_id, lower(active_content_hash))"),
    candidateInsert.replace(
      candidateConflictTarget,
      `(${[...candidateConflictColumns].reverse().join(", ")})`,
    ),
    candidateInsert.replace(candidateConflictTarget, `(${candidateConflictColumns.slice(0, -1).join(", ")})`),
    `${candidateInsert} RETURNING set_config($13, $14, $15)`,
    `WITH forged AS (SELECT $1) ${candidateInsert}`,
    "INSERT INTO mengshu_candidates (id) SELECT id FROM forged WHERE id = $1",
    `INSERT INTO mengshu_candidates (id) VALUES ($1), ($2)
ON CONFLICT ${candidateConflictTarget} DO NOTHING`,
    `INSERT INTO mengshu_candidates (id) VALUES ($1 + $2)
ON CONFLICT ${candidateConflictTarget} DO NOTHING`,
    `INSERT INTO mengshu_candidates VALUES ($1)
ON CONFLICT ${candidateConflictTarget} DO NOTHING`,
    `INSERT INTO mengshu_candidates (id, id) VALUES ($1, $2)
ON CONFLICT ${candidateConflictTarget} DO NOTHING`,
    `INSERT INTO mengshu_candidates (id, tenant_id) VALUES ($1)
ON CONFLICT ${candidateConflictTarget} DO NOTHING`,
  ])("candidate conflict policy 拒绝非 exact grammar: %s", async (sql) => {
    const h = harness();
    const repository = candidateEffectRepository(h, { returningColumns: ["id"] });
    const indexes = [...sql.matchAll(/\$([1-9][0-9]*)/g)].map((match) => Number(match[1]));
    const maxIndex = indexes.length === 0 ? 0 : Math.max(...indexes);
    const params = Array.from(
      { length: maxIndex },
      (_, index) => candidateParams[index] ?? `value-${index + 1}`,
    );

    await expect(repository.execute(input(), async (client) => {
      await client.query(sql, params);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql: called }) => called === sql.trim().replace(/\s+/g, " ")))
      .toBe(false);
  });

  test("candidate policy 只允许配置的 simple RETURNING columns", async () => {
    const allowed = harness();
    const allowedRepository = candidateEffectRepository(allowed, { returningColumns: ["id"] });
    await expect(allowedRepository.execute(input(), async (client) => {
      const result = await client.query(`${candidateInsert} RETURNING id`, candidateParams);
      return { candidateId: String(result.rows[0]?.id) };
    })).resolves.toMatchObject({ status: "applied" });

    const rejected = harness();
    const rejectedRepository = candidateEffectRepository(rejected, { returningColumns: ["id"] });
    await expect(rejectedRepository.execute(input(), async (client) => {
      await client.query(`${candidateInsert} RETURNING id, status`, candidateParams);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
  });

  test.each([
    candidateInsert.replace("$2", "$1"),
    candidateInsert.replace("$1, $2", "$2, $1"),
    candidateInsert.replace("$14::jsonb", "$15::jsonb"),
  ])("candidate VALUES placeholder 必须按位置严格连续且各出现一次: %s", async (sql) => {
    const h = harness();
    const repository = candidateEffectRepository(h);
    await expect(repository.execute(input(), async (client) => {
      await client.query(sql, candidateParams);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql: called }) => called.startsWith("INSERT INTO mengshu_candidates")))
      .toBe(false);
  });

  test("candidate VALUES params 必须与 insert columns 等长且不可多余", async () => {
    const h = harness();
    const repository = candidateEffectRepository(h);
    await expect(repository.execute(input(), async (client) => {
      await client.query(candidateInsert, [...candidateParams, "extra"]);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql }) => sql.startsWith("INSERT INTO mengshu_candidates")))
      .toBe(false);
  });

  test.each([
    candidateInsert.replace("$13::jsonb", "$13::eviltype"),
    candidateInsert.replace("$13::jsonb", "$13::custom_domain"),
    candidateInsert.replace("$13::jsonb", '$13::"jsonb"'),
    candidateInsert.replace("$13::jsonb", "$13::public.jsonb"),
    candidateInsert.replace("$13::jsonb", "$13::pg_catalog.jsonb"),
    candidateInsert.replace("$13::jsonb", "$13"),
    candidateInsert.replace("$1", "$1::jsonb"),
  ])("candidate cast 只允许 policy 对应 column/position 的 exact built-in type: %s", async (sql) => {
    const h = harness();
    const repository = candidateEffectRepository(h);
    await expect(repository.execute(input(), async (client) => {
      await client.query(sql, candidateParams);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql: called }) => called.startsWith("INSERT INTO mengshu_candidates")))
      .toBe(false);
  });

  test.each([
    "+ INSERT INTO domain_effects (id) VALUES ($1)",
    "$1 INSERT INTO domain_effects (id) VALUES ($1)",
    "() INSERT INTO domain_effects (id) VALUES ($1)",
    "INSERT + INTO domain_effects (id) VALUES ($1)",
    "INSERT INTO + domain_effects (id) VALUES ($1)",
    "INSERT INTO domain_effects + (id) VALUES ($1)",
  ])("command 必须 token0 且 INSERT INTO relation ( 必须紧邻: %s", async (sql) => {
    const h = harness();
    await expect(h.repository.execute(input(), async (client) => {
      await client.query(sql, ["effect-1"]);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql: called }) => called === sql)).toBe(false);
  });

  test.each([
    ["INSERT INTO domain_effects (id, value) VALUES ($1, $1)", ["a", "b"]],
    ["INSERT INTO domain_effects (id, value) VALUES ($2, $1)", ["a", "b"]],
    ["INSERT INTO domain_effects (id) VALUES ($2)", ["a", "b"]],
    ["INSERT INTO domain_effects (id) VALUES ($1)", ["a", "extra"]],
  ])("普通 INSERT 的 VALUES/params 也执行 exact positional 校验: %s", async (sql, params) => {
    const h = harness();
    await expect(h.repository.execute(input(), async (client) => {
      await client.query(sql, params);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.clients[0]?.calls.some(({ sql: called }) => called === sql)).toBe(false);
  });

  test("stale fence 下 candidate callback 零调用", async () => {
    const h = harness();
    h.job.leaseUntil = 0;
    const repository = candidateEffectRepository(h);
    const work = vi.fn(async () => ({ ok: true }));

    await expect(repository.execute(input(), work)).resolves.toEqual({ status: "stale" });
    expect(work).not.toHaveBeenCalled();
    expect(h.clients[0]?.calls.some(({ sql }) => sql.startsWith("INSERT INTO mengshu_candidates")))
      .toBe(false);
  });

  test("candidate conflict policy 在构造时生成 exact 不可变快照", async () => {
    const h = harness();
    const conflictColumns = [...candidateConflictColumns];
    const returningColumns = ["id"];
    const valueCasts: Array<{ column: string; type: "jsonb" }> = [
      { column: "evidence_ids", type: "jsonb" },
      { column: "metadata", type: "jsonb" },
    ];
    const policy = {
      relation: "mengshu_candidates",
      conflictColumns,
      returningColumns,
      valueCasts,
    };
    const repository = new PostgresDurableJobV2EffectRepository(h.pool, {
      clock: () => 100,
      allowedRelations: ["mengshu_candidates"],
      insertOnConflictPolicies: [policy],
    });
    policy.relation = "other_effects";
    conflictColumns[0] = "forged";
    returningColumns[0] = "status";
    valueCasts[0]!.column = "id";
    valueCasts.pop();

    await expect(repository.execute(input(), async (client) => {
      await client.query(`${candidateInsert} RETURNING id`, candidateParams);
      return { ok: true };
    })).resolves.toMatchObject({ status: "applied" });
  });

  test("candidate conflict policy 拒绝 Proxy/getter/extra/duplicate/非 allowlist 输入", () => {
    const h = harness();
    const traps = { get: vi.fn(Reflect.get), ownKeys: vi.fn(Reflect.ownKeys) };
    const proxiedPolicies = new Proxy([{
      relation: "mengshu_candidates",
      conflictColumns: candidateConflictColumns,
    }], traps as ProxyHandler<Array<Record<string, unknown>>>);
    expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
      allowedRelations: ["mengshu_candidates"],
      insertOnConflictPolicies: proxiedPolicies as never,
    })).toThrow(/allowed relations|conflict policy/i);
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();

    const getter = vi.fn(() => candidateConflictColumns);
    const accessor = { relation: "mengshu_candidates" } as Record<string, unknown>;
    Object.defineProperty(accessor, "conflictColumns", { enumerable: true, get: getter });
    for (const insertOnConflictPolicies of [
      [accessor],
      [{ relation: "other_effects", conflictColumns: candidateConflictColumns }],
      [{ relation: "mengshu_candidates", conflictColumns: [] }],
      [{ relation: "mengshu_candidates", conflictColumns: ["select"] }],
      [{ relation: "mengshu_candidates", conflictColumns: ["tenant_id", "tenant_id"] }],
      [{ relation: "mengshu_candidates", conflictColumns: candidateConflictColumns, extra: true }],
      [
        { relation: "mengshu_candidates", conflictColumns: candidateConflictColumns },
        { relation: "mengshu_candidates", conflictColumns: candidateConflictColumns },
      ],
    ]) {
      expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
        allowedRelations: ["mengshu_candidates"],
        insertOnConflictPolicies: insertOnConflictPolicies as never,
      })).toThrow(/allowed relations|conflict policy/i);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test("candidate cast nested policy 拒绝 Proxy/getter/symbol/extra/hole/non-plain/keyword", () => {
    const h = harness();
    const valid = { column: "metadata", type: "jsonb" };
    const proxyTraps = { get: vi.fn(Reflect.get), ownKeys: vi.fn(Reflect.ownKeys) };
    const proxied = new Proxy([valid], proxyTraps as ProxyHandler<typeof valid[]>);
    const getter = vi.fn(() => "jsonb");
    const accessor = { column: "metadata" } as Record<string, unknown>;
    Object.defineProperty(accessor, "type", { enumerable: true, get: getter });
    const symbol = { ...valid } as typeof valid & { [key: symbol]: boolean };
    symbol[Symbol("extra")] = true;
    const hole = Array(1) as Array<typeof valid>;
    const nonPlain = Object.assign(Object.create({}), valid);
    for (const valueCasts of [
      proxied, [accessor], [symbol], [{ ...valid, extra: true }], hole, [nonPlain],
      [{ column: "metadata", type: "select" }],
      [{ column: "metadata", type: "eviltype" }],
      [{ column: "metadata", type: "jsonb" }, { column: "metadata", type: "jsonb" }],
    ]) {
      expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
        allowedRelations: ["mengshu_candidates"],
        insertOnConflictPolicies: [{
          relation: "mengshu_candidates",
          conflictColumns: candidateConflictColumns,
          valueCasts: valueCasts as never,
        }],
      })).toThrow(/allowed relations|conflict policy/i);
    }
    expect(proxyTraps.get).not.toHaveBeenCalled();
    expect(proxyTraps.ownKeys).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  test.each([
    ["COMMIT", []],
    ["CREATE TABLE escaped (id text)", []],
    ["INSERT INTO other_effects (id) VALUES ($1)", ["effect-1"]],
    ["SELECT pg_advisory_lock($1) FROM domain_effects", [1]],
  ])("callback void 非法 query 也被 tracked/drain，回滚且不产生 unhandled: %s", async (sql, params) => {
    const h = harness();
    await expect(h.repository.execute(input(), async (client) => {
      void client.query(sql, params);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(h.effects.size).toBe(0);
    expect(h.receipts.size).toBe(0);
    expect(h.clients[0]?.calls.some((call) => call.sql === sql)).toBe(false);
    expect(h.clients[0]?.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("allowedRelations 在构造时 exact 校验并冻结快照", async () => {
    const h = harness();
    const relations = ["domain_effects"];
    const repository = new PostgresDurableJobV2EffectRepository(h.pool, {
      clock: () => 100,
      allowedRelations: relations,
    });
    relations[0] = "other_effects";

    await expect(repository.execute(input(), async (client) => {
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { ok: true };
    })).resolves.toMatchObject({ status: "applied" });

    for (const allowedRelations of [[], ["pg_catalog"], ["information_schema"],
      ["bad relation"], ["domain_effects", "domain_effects"]]) {
      expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
        allowedRelations,
      })).toThrow(/allowed relations/i);
    }
  });

  test.each([
    "only", "into", "from", "set", "values", "where", "returning", "on", "conflict",
    "do", "nothing", "as", "default", "null", "true", "false", "and", "or", "not", "is", "in",
  ])("allowedRelations 拒绝 SQL 语法词: %s", (relation) => {
    const h = harness();
    expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
      allowedRelations: [relation],
    })).toThrow(/allowed relations/i);
  });

  test("权威 PostgreSQL 18 keyword SSOT 已冻结且覆盖 R4 关键词", () => {
    expect(Object.isFrozen(POSTGRESQL_18_RELATION_KEYWORDS)).toBe(true);
    expect(POSTGRESQL_18_RELATION_KEYWORDS).toHaveLength(494);
    expect(POSTGRESQL_18_RELATION_KEYWORDS).toEqual(expect.arrayContaining([
      "CURRENT_USER", "AUTHORIZATION", "OVERRIDING", "SYSTEM", "USER", "OF",
    ]));
  });

  test.each(POSTGRESQL_18_RELATION_KEYWORDS)(
    "allowedRelations 拒绝 PostgreSQL 18 parser keyword: %s",
    (keyword) => {
      const h = harness();
      expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
        allowedRelations: [keyword.toLowerCase()],
      })).toThrow(/allowed relations/i);
    },
  );

  test.each(["domain_effects", "mengshu_candidates"])(
    "keyword policy 不误伤显式合法 domain relation: %s",
    (relation) => {
      const h = harness();
      expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
        allowedRelations: [relation],
      })).not.toThrow();
    },
  );

  test("引号 relation 保持 exact 语义，不做大小写折叠", async () => {
    const allowed = harness();
    await expect(allowed.repository.execute(input(), async (client) => {
      await client.query('INSERT INTO "domain_effects" ("id") VALUES ($1)', ["effect-1"]);
      return { ok: true };
    })).resolves.toMatchObject({ status: "applied" });

    const rejected = harness();
    await expect(rejected.repository.execute(input(), async (client) => {
      await client.query('INSERT INTO "DOMAIN_EFFECTS" ("id") VALUES ($1)', ["effect-1"]);
      return { ok: true };
    })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    expect(rejected.clients[0]?.calls.some((call) => call.sql.includes('"DOMAIN_EFFECTS"'))).toBe(false);
  });

  test.each([
    "mengshu_schema_migrations",
    "mengshu_jobs_v2",
    "mengshu_job_v2_effect_receipts",
    "mengshu_embedding_spaces",
    "mengshu_active_embedding_space",
    "mengshu_forget_audit",
    "mengshu_forget_outbox",
    "mengshu_forget_receipts",
    "mengshu_jobs_v2_legacy_quarantine",
  ])("allowedRelations 直接拒绝 control-plane relation: %s", (relation) => {
    const h = harness();
    expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
      allowedRelations: [relation],
    })).toThrow(/allowed relations/i);
  });

  test("DELETE FROM ONLY 不能把 ONLY 当 relation 绕过 allowlist", async () => {
    const h = harness();
    const repository = new PostgresDurableJobV2EffectRepository(h.pool, {
      clock: () => 100,
      allowedRelations: ["domain_effects"],
    });

    for (const sql of [
      "DELETE FROM ONLY domain_effects WHERE id = $1",
      "DELETE FROM ONLY mengshu_schema_migrations WHERE version = $1",
    ]) {
      await expect(repository.execute(input(), async (client) => {
        await client.query(sql, ["value-1"]);
        return { ok: true };
      })).rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
      expect(h.clients.at(-1)?.calls.some((call) => call.sql === sql)).toBe(false);
    }
  });

  test("allowedRelations 拒绝 Proxy array 且不触发任何 trap", () => {
    const h = harness();
    const traps = {
      get: vi.fn(Reflect.get),
      getPrototypeOf: vi.fn(Reflect.getPrototypeOf),
      ownKeys: vi.fn(Reflect.ownKeys),
      getOwnPropertyDescriptor: vi.fn(Reflect.getOwnPropertyDescriptor),
    };
    const proxied = new Proxy(["domain_effects"], traps as ProxyHandler<string[]>);

    expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
      allowedRelations: proxied,
    })).toThrow(/allowed relations/i);
    expect(traps.get).not.toHaveBeenCalled();
    expect(traps.getPrototypeOf).not.toHaveBeenCalled();
    expect(traps.ownKeys).not.toHaveBeenCalled();
    expect(traps.getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });

  test("allowedRelations 仅接受无 getter/symbol/extra/hole 的 plain dense array", () => {
    const h = harness();
    const getter = vi.fn(() => "domain_effects");
    const accessor = ["placeholder"];
    Object.defineProperty(accessor, "0", { enumerable: true, configurable: true, get: getter });
    const symbol = ["domain_effects"] as Array<string> & { [key: symbol]: boolean };
    symbol[Symbol("extra")] = true;
    const extra = ["domain_effects"] as string[] & { extra?: boolean };
    extra.extra = true;
    const hole = Array(1) as string[];
    const nonPlain = Object.create(Array.prototype) as string[];
    Object.defineProperties(nonPlain, {
      length: { value: 1, writable: true },
      0: { value: "domain_effects", enumerable: true },
    });

    for (const allowedRelations of [accessor, symbol, extra, hole, nonPlain]) {
      expect(() => new PostgresDurableJobV2EffectRepository(h.pool, {
        allowedRelations,
      })).toThrow(/allowed relations/i);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test("callback 结束立即 revoke；保存的 client 再调用固定失败且不触 DB", async () => {
    const h = harness();
    let saved: PostgresDurableJobV2EffectClient | undefined;
    await h.repository.execute(input(), async (client) => {
      saved = client as PostgresDurableJobV2EffectClient;
      await client.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { ok: true };
    });
    const callsBefore = h.clients[0]!.calls.length;

    await expect(saved!.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-2"]))
      .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_UNSAFE_SQL" });
    void saved!.query("DELETE FROM domain_effects WHERE id = $1", ["effect-3"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.clients[0]?.calls).toHaveLength(callsBefore);
    expect(h.effects).toEqual(new Set(["effect-1"]));
  });

  test("callback 未 await 的 in-flight query 会先 drain，再写 receipt/commit", async () => {
    const h = harness();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const client = new TransactionalFakeClient(h.job, h.effects, h.receipts);
    client.domainWriteGate = gate;
    h.pool.connect.mockResolvedValueOnce(client);

    const execution = h.repository.execute(input(), async (workClient) => {
      void workClient.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { ok: true };
    });
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.sql === "INSERT INTO domain_effects (id) VALUES ($1)"))
        .toBe(true);
    });
    expect(client.calls.some((call) => /INSERT INTO mengshu_job_v2_effect_receipts/.test(call.sql)))
      .toBe(false);

    releaseGate();
    await expect(execution).resolves.toMatchObject({ status: "applied" });
    expect(h.effects).toEqual(new Set(["effect-1"]));
  });

  test("callback 未 await 的 query 即使在 revoke 前已失败也不会丢错或提交 receipt", async () => {
    const h = harness();
    const client = new TransactionalFakeClient(h.job, h.effects, h.receipts);
    client.failNextDomainWrite = true;
    h.pool.connect.mockResolvedValueOnce(client);

    await expect(h.repository.execute(input(), async (workClient) => {
      void workClient.query("INSERT INTO domain_effects (id) VALUES ($1)", ["effect-1"]);
      return { ok: true };
    })).rejects.toThrow("simulated process failure");

    expect(h.receipts.size).toBe(0);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["symbol", { value: Symbol("bad") }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
    ["non-plain", { value: new Date(0) }],
    ["array hole", { value: Array(1) }],
  ])("receipt result 严格拒绝 %s，而不是由 JSON.stringify 静默改写", async (_name, result) => {
    const h = harness();
    await expect(h.repository.execute(input(), async () => result as Record<string, unknown>))
      .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_INVALID_RESULT" });
    expect(h.receipts.size).toBe(0);
    expect(h.clients[0]?.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("receipt result 不执行 getter，拒绝 accessor、symbol key 与循环引用", async () => {
    const getter = vi.fn(() => "secret");
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get: getter });
    const symbolKey = { ok: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("bad")] = true;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    for (const result of [accessor, symbolKey, cycle]) {
      const h = harness();
      await expect(h.repository.execute(input(), async () => result as Record<string, unknown>))
        .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_INVALID_RESULT" });
      expect(h.receipts.size).toBe(0);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test("DB receipt row 必须为 plain data object，decode 不执行 getter/symbol/accessor", async () => {
    for (const variant of ["getter", "symbol", "prototype"] as const) {
      const h = harness([100]);
      const getter = vi.fn(() => fingerprint);
      let row: Record<PropertyKey, unknown> = {
        job_id: "job-1",
        effect_key: "extract_candidate.persist",
        lease_generation: 1,
        result: { ok: true },
        committed_at: 90,
      };
      if (variant === "getter") {
        Object.defineProperty(row, "request_fingerprint", { enumerable: true, get: getter });
      } else {
        row.request_fingerprint = fingerprint;
      }
      if (variant === "symbol") row[Symbol("bad")] = true;
      if (variant === "prototype") row = Object.assign(Object.create({ inherited: true }), row);
      h.receipts.set("job-1:extract_candidate.persist", row as unknown as ReceiptRow);

      await expect(h.repository.execute(input(), async () => ({ ok: true })))
        .rejects.toMatchObject({ code: "DURABLE_JOB_EFFECT_INVALID_RECEIPT" });
      expect(getter).not.toHaveBeenCalled();
    }
  });
});
