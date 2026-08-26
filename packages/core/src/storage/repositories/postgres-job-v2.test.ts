import { describe, expect, test, vi } from "vitest";

import type { AuthorityScope } from "../../domain/authority-scope.js";
import {
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  leaseDurableJobV2,
  quarantineUnknownDurableJobV2,
  type DurableJobV2,
  type DurableJobV2Scope,
} from "./job-v2.js";
import {
  PostgresDurableJobV2Repository,
  type PostgresDurableJobV2Pool,
  type PostgresDurableJobV2PoolClient,
  type PostgresDurableJobV2QueryResult,
} from "./postgres-job-v2.js";

const scope: DurableJobV2Scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
};
const registry = createDurableJobHandlerRegistry(["build_tree", "extract_candidate"]);
const authority: AuthorityScope = Object.freeze({
  tenantId: scope.tenantId,
  userId: scope.userId,
  allow: Object.freeze({
    appIds: Object.freeze([scope.appId, "codex"]),
    projectIds: Object.freeze([scope.projectId, "project-b"]),
    agentIds: Object.freeze([scope.agentId, "agent-b"]),
    namespaces: Object.freeze([scope.namespace, "preferences"]),
    visibilities: Object.freeze(["private", "workspace"] as const),
  }),
});

function queued(overrides: Partial<DurableJobV2> = {}): DurableJobV2 {
  return createDurableJobV2({
    id: "job-1",
    type: "extract_candidate",
    payload: { candidateId: "candidate-1" },
    dedupeKey: "extract_candidate:candidate-1",
    scope,
    maxAttempts: 3,
    ...overrides,
  }, { registry, now: 100 });
}

function running(job: DurableJobV2 = queued()): DurableJobV2 {
  return leaseDurableJobV2(job, {
    owner: "worker-a",
    now: 120,
    leaseMs: 100,
    tokenFactory: () => "a".repeat(32),
  }).job;
}

function orphanedQueued(): DurableJobV2 {
  const historicalRegistry = createDurableJobHandlerRegistry([
    ...registry.types,
    "legacy_handler",
  ]);
  return createDurableJobV2({
    id: "job-orphan",
    type: "legacy_handler",
    payload: { candidateId: "candidate-orphan", secretRef: "opaque-reference" },
    dedupeKey: "legacy_handler:candidate-orphan",
    scope,
    maxAttempts: 3,
  }, { registry: historicalRegistry, now: 100 });
}

function rowFor(job: DurableJobV2): Record<string, unknown> {
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    dedupe_key: job.dedupeKey,
    scoped_dedupe_key: job.scopedDedupeKey,
    tenant_id: job.scope.tenantId,
    user_id: job.scope.userId,
    app_id: job.scope.appId,
    project_id: job.scope.projectId,
    agent_id: job.scope.agentId,
    namespace: job.scope.namespace,
    visibility: job.scope.visibility,
    status: job.status,
    attempts: job.attempts,
    lease_generation: job.leaseGeneration,
    max_attempts: job.maxAttempts,
    next_attempt_at: job.nextAttemptAt ?? null,
    lease_owner: job.leaseOwner ?? null,
    lease_token: job.leaseToken ?? null,
    lease_until: job.leaseUntil ?? null,
    heartbeat_at: job.heartbeatAt ?? null,
    last_error_code: job.lastError?.code ?? null,
    last_error_retryable: job.lastError?.retryable ?? null,
    last_error_fingerprint: job.lastError?.fingerprint ?? null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

function scopeRow(value: DurableJobV2Scope): Record<string, unknown> {
  return {
    tenant_id: value.tenantId,
    user_id: value.userId,
    app_id: value.appId,
    project_id: value.projectId,
    agent_id: value.agentId,
    namespace: value.namespace,
    visibility: value.visibility,
  };
}

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class FakeClient implements PostgresDurableJobV2PoolClient {
  readonly calls: Call[] = [];
  releaseCount = 0;
  releaseFailure?: Error;

  constructor(
    private readonly handler: (
      sql: string,
      params: readonly unknown[],
    ) => Promise<PostgresDurableJobV2QueryResult> | PostgresDurableJobV2QueryResult,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresDurableJobV2QueryResult<Row>> {
    this.calls.push({ sql, params });
    return await this.handler(sql, params) as PostgresDurableJobV2QueryResult<Row>;
  }

  release(): void {
    this.releaseCount += 1;
    if (this.releaseFailure) throw this.releaseFailure;
  }
}

class FakePool implements PostgresDurableJobV2Pool {
  connectCount = 0;
  constructor(readonly client: FakeClient) {}
  async connect(): Promise<PostgresDurableJobV2PoolClient> {
    this.connectCount += 1;
    return this.client;
  }
}

function leafErrors(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? error.errors.flatMap((child) => leafErrors(child))
    : [error];
}

function repository(
  client: FakeClient,
  overrides: Partial<ConstructorParameters<typeof PostgresDurableJobV2Repository>[1]> = {},
) {
  return new PostgresDurableJobV2Repository(new FakePool(client), {
    registry,
    clock: () => 100,
    tokenFactory: () => "b".repeat(32),
    backoffMs: (attempts) => attempts * 100,
    ...overrides,
  });
}

function transactionControl(sql: string): PostgresDurableJobV2QueryResult | undefined {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
  return undefined;
}

describe("PostgresDurableJobV2Repository enqueue", () => {
  test("未注册 handler 在 connect/SQL 前 fail-closed", async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const pool = new FakePool(client);
    const repo = new PostgresDurableJobV2Repository(pool, {
      registry,
      clock: () => 100,
      tokenFactory: () => "b".repeat(32),
      backoffMs: () => 100,
    });

    await expect(repo.enqueue({
      id: "job-unknown",
      type: "unknown_handler",
      payload: {},
      dedupeKey: "unknown:1",
      scope,
      maxAttempts: 3,
    })).rejects.toMatchObject({ code: "HANDLER_NOT_REGISTERED" });

    expect(pool.connectCount).toBe(0);
    expect(client.calls).toEqual([]);
  });

  test("INSERT 使用固定表、完整 scope 与 scoped key，并在同一 dedicated tx 返回已验证 row", async () => {
    const expected = queued();
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/INSERT INTO mengshu_jobs_v2/.test(sql)) {
        return { rows: [rowFor(expected)], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const repo = repository(client);

    const decoded = await repo.enqueue({
      id: expected.id,
      type: expected.type,
      payload: expected.payload as Record<string, unknown>,
      dedupeKey: expected.dedupeKey,
      scope,
      maxAttempts: expected.maxAttempts,
    });
    expect(decoded).toEqual(expected);
    expect(Reflect.ownKeys(decoded).map(String).sort()).toEqual(
      Reflect.ownKeys(expected).map(String).sort(),
    );
    for (const key of [
      "nextAttemptAt", "leaseOwner", "leaseToken", "leaseUntil", "heartbeatAt", "lastError",
    ]) {
      expect(Object.hasOwn(decoded, key)).toBe(false);
    }

    expect(client.calls.map(({ sql }) => sql.trim())).toEqual([
      "BEGIN",
      expect.stringMatching(/INSERT INTO mengshu_jobs_v2[\s\S]+ON CONFLICT \(scoped_dedupe_key\) DO NOTHING[\s\S]+RETURNING/i),
      "COMMIT",
    ]);
    const params = client.calls[1]!.params;
    expect(params).toEqual(expect.arrayContaining([
      expected.scopedDedupeKey,
      scope.tenantId,
      scope.userId,
      scope.appId,
      scope.projectId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
    ]));
    expect(client.releaseCount).toBe(1);
  });

  test("dedupe conflict 在同 tx 二次 FOR SHARE，并复核 client key/hash/完整 scope", async () => {
    const existing = queued({ id: "job-existing" });
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/INSERT INTO/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FOR SHARE/.test(sql)) return { rows: [rowFor(existing)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).enqueue({
      id: "job-new",
      type: existing.type,
      payload: existing.payload as Record<string, unknown>,
      dedupeKey: existing.dedupeKey,
      scope,
      maxAttempts: 3,
    })).resolves.toEqual(existing);

    expect(client.calls[2]?.sql).toMatch(/WHERE scoped_dedupe_key = \$1[\s\S]+FOR SHARE/i);
    expect(client.calls[2]?.params).toEqual([existing.scopedDedupeKey]);
  });

  test.each([
    ["type", { type: "build_tree" }],
    ["payload", { payload: { candidateId: "candidate-other" } }],
    ["maxAttempts", { maxAttempts: 9 }],
  ] as const)("dedupe conflict 的 %s 与原命令不一致时 rollback", async (_case, override) => {
    const existing = queued({ id: "job-existing" });
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/INSERT INTO/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FOR SHARE/.test(sql)) return { rows: [rowFor(existing)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).enqueue({
      id: "job-new",
      type: existing.type,
      payload: existing.payload as Record<string, unknown>,
      dedupeKey: existing.dedupeKey,
      scope,
      maxAttempts: existing.maxAttempts,
      ...override,
    })).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("INSERT RETURNING 必须与 expected queued 命令完整等价", async () => {
    const expected = queued();
    const unrelated = queued({ maxAttempts: 9 });
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/INSERT INTO/.test(sql)) return { rows: [rowFor(unrelated)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).enqueue({
      id: expected.id, type: expected.type,
      payload: expected.payload as Record<string, unknown>,
      dedupeKey: expected.dedupeKey, scope, maxAttempts: expected.maxAttempts,
    })).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("dedupe hash collision 或 malformed returned row rollback + release", async () => {
    const expected = queued();
    const forged = rowFor(expected);
    forged.tenant_id = "tenant-forged";
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/INSERT INTO/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FOR SHARE/.test(sql)) return { rows: [forged], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).enqueue({
      id: expected.id,
      type: expected.type,
      payload: expected.payload as Record<string, unknown>,
      dedupeKey: expected.dedupeKey,
      scope,
      maxAttempts: 3,
    })).rejects.toMatchObject({ code: "INVALID_JOB" });

    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test("RETURNING optional field 类型非法时在 COMMIT 前 rollback", async () => {
    const expected = queued();
    const malformed = rowFor(expected);
    malformed.lease_owner = 123;
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/INSERT INTO/.test(sql)) return { rows: [malformed], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).enqueue({
      id: expected.id, type: expected.type,
      payload: expected.payload as Record<string, unknown>,
      dedupeKey: expected.dedupeKey, scope, maxAttempts: expected.maxAttempts,
    })).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test.each(["", " ", "1e2", "1.0", "00100"])(
    "required BIGINT string %j 非 canonical 时在 COMMIT 前拒绝",
    async (raw) => {
      const expected = queued();
      const malformed = rowFor(expected);
      malformed.created_at = raw;
      const client = new FakeClient((sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (/INSERT INTO/.test(sql)) return { rows: [malformed], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      });

      await expect(repository(client).enqueue({
        id: expected.id, type: expected.type,
        payload: expected.payload as Record<string, unknown>,
        dedupeKey: expected.dedupeKey, scope, maxAttempts: expected.maxAttempts,
      })).rejects.toThrow(/row created_at is invalid/i);
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );

  test.each(["", " ", "1e2", "1.0", "00220"])(
    "optional BIGINT string %j 非 canonical 时拒绝",
    async (raw) => {
      const candidate = running();
      const malformed = rowFor(candidate);
      malformed.lease_until = raw;
      const client = new FakeClient((sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (/^SELECT/i.test(sql)) return { rows: [malformed], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      });

      await expect(repository(client, { clock: () => 220 }).reap({ scope }))
        .rejects.toThrow(/optional time is invalid/i);
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );

  test("canonical non-negative decimal BIGINT strings 可无损解码", async () => {
    const expected = queued();
    const persisted = rowFor(expected);
    persisted.attempts = "0";
    persisted.lease_generation = "0";
    persisted.max_attempts = "3";
    persisted.created_at = "100";
    persisted.updated_at = "100";
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/INSERT INTO/.test(sql)) return { rows: [persisted], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).enqueue({
      id: expected.id, type: expected.type,
      payload: expected.payload as Record<string, unknown>,
      dedupeKey: expected.dedupeKey, scope, maxAttempts: expected.maxAttempts,
    })).resolves.toEqual(expected);
  });
});

describe("PostgresDurableJobV2Repository runnable scope discovery", () => {
  test("按固定 tenant/user 与 allow arrays 参数化发现真实 runnable 7D scopes，并排除 history cohort", async () => {
    const second: DurableJobV2Scope = {
      tenantId: scope.tenantId,
      userId: scope.userId,
      appId: "codex",
      projectId: "project-b",
      agentId: "agent-b",
      namespace: "preferences",
      visibility: "workspace",
    };
    const client = new FakeClient((sql) => {
      if (/SELECT tenant_id/.test(sql)) {
        return { rows: [scopeRow(scope), scopeRow(second)], rowCount: 2 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository(client, { clock: () => 150 })
      .listRunnableScopes(authority, 2);

    expect(result).toEqual([scope, second]);
    expect(result.every(Object.isFrozen)).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.sql).toMatch(/FROM mengshu_jobs_v2/);
    expect(client.calls[0]!.sql).toMatch(/tenant_id = \$1 AND user_id = \$2/);
    expect(client.calls[0]!.sql).toMatch(/app_id = ANY\(\$3::text\[\]\)/);
    expect(client.calls[0]!.sql).toMatch(/project_id = ANY\(\$4::text\[\]\)/);
    expect(client.calls[0]!.sql).toMatch(/agent_id = ANY\(\$5::text\[\]\)/);
    expect(client.calls[0]!.sql).toMatch(/namespace = ANY\(\$6::text\[\]\)/);
    expect(client.calls[0]!.sql).toMatch(/visibility = ANY\(\$7::text\[\]\)/);
    expect(client.calls[0]!.sql).toMatch(/id NOT LIKE \$8/);
    expect(client.calls[0]!.sql).toMatch(/status = 'queued'/);
    expect(client.calls[0]!.sql).toMatch(/status = 'retry_wait'.+next_attempt_at <= \$9/s);
    expect(client.calls[0]!.sql).toMatch(/status = 'running'.+lease_until <= \$9/s);
    expect(client.calls[0]!.sql).toMatch(/GROUP BY tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility/);
    expect(client.calls[0]!.sql).toMatch(/CASE WHEN \$10::text IS NULL/);
    expect(client.calls[0]!.sql).toMatch(/ROW\(app_id, project_id, agent_id, namespace, visibility\) >/);
    expect(client.calls[0]!.sql).toMatch(/LIMIT \$15/);
    expect(client.calls[0]!.params).toEqual([
      scope.tenantId,
      scope.userId,
      [...authority.allow.appIds],
      [...authority.allow.projectIds],
      [...authority.allow.agentIds],
      [...authority.allow.namespaces],
      [...authority.allow.visibilities],
      "history-job:%",
      150,
      null,
      null,
      null,
      null,
      null,
      2,
    ]);
    expect(client.releaseCount).toBe(1);
  });

  test("cursor 经 authority 复核并生成稳定 scope 顺序的环形分页参数", async () => {
    const second: DurableJobV2Scope = {
      ...scope,
      appId: "codex",
      projectId: "project-b",
      agentId: "agent-b",
      namespace: "preferences",
      visibility: "workspace",
    };
    const client = new FakeClient(() => ({
      rows: [scopeRow(second), scopeRow(scope)],
      rowCount: 2,
    }));

    await expect(repository(client, { clock: () => 150 })
      .listRunnableScopes(authority, 2, scope)).resolves.toEqual([second, scope]);

    expect(client.calls[0]!.params.slice(9)).toEqual([
      scope.appId,
      scope.projectId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
      2,
    ]);
    expect(client.calls[0]!.sql).toMatch(
      /THEN 0 ELSE 1 END,\s+app_id ASC, project_id ASC, agent_id ASC, namespace ASC, visibility ASC/s,
    );
  });

  test("每个 provider row 都按 authority 精确复核，越权、重复或畸形结果 fail-closed", async () => {
    for (const rows of [
      [scopeRow({ ...scope, projectId: "project-denied" })],
      [scopeRow(scope), scopeRow(scope)],
      [{ ...scopeRow(scope), visibility: "invalid" }],
    ]) {
      const client = new FakeClient(() => ({ rows, rowCount: rows.length }));
      await expect(repository(client).listRunnableScopes(authority, 3)).rejects.toThrow();
      expect(client.releaseCount).toBe(1);
    }
  });

  test("非法 authority/limit 在 connect 前拒绝，adapter 返回超限或 rowCount 不一致也拒绝", async () => {
    const client = new FakeClient(() => ({ rows: [scopeRow(scope)], rowCount: 1 }));
    const pool = new FakePool(client);
    const repo = new PostgresDurableJobV2Repository(pool, {
      registry,
      clock: () => 150,
      tokenFactory: () => "b".repeat(32),
      backoffMs: () => 100,
    });
    const missingAllow = { tenantId: scope.tenantId, userId: scope.userId } as AuthorityScope;

    await expect(repo.listRunnableScopes(missingAllow, 1)).rejects.toThrow();
    await expect(repo.listRunnableScopes(authority, 0)).rejects.toThrow(/limit/i);
    await expect(repo.listRunnableScopes(authority, 1, {
      ...scope,
      projectId: "project-denied",
    })).rejects.toThrow(/cursor|authority|allowlist/i);
    expect(pool.connectCount).toBe(0);

    const tooMany = new FakeClient(() => ({
      rows: [scopeRow(scope), scopeRow({ ...scope, projectId: "project-b" })],
      rowCount: 2,
    }));
    await expect(repository(tooMany).listRunnableScopes(authority, 1)).rejects.toThrow();

    const mismatchedCount = new FakeClient(() => ({ rows: [scopeRow(scope)], rowCount: 2 }));
    await expect(repository(mismatchedCount).listRunnableScopes(authority, 2)).rejects.toThrow();
  });
});

describe("PostgresDurableJobV2Repository online cohort isolation", () => {
  test.each(["reap", "quarantineUnknown", "lease"] as const)(
    "%s 在 connect 前拒绝空、重复或不安全的 idAllowlist",
    async (operation) => {
      const client = new FakeClient(() => {
        throw new Error("must not query");
      });
      const pool = new FakePool(client);
      const repo = new PostgresDurableJobV2Repository(pool, {
        registry,
        clock: () => 100,
        tokenFactory: () => "b".repeat(32),
        backoffMs: () => 100,
      });
      const invalidAllowlists = [
        [],
        ["history-job:target-a", "history-job:target-a"],
        [""],
        ["history-job:target-a\n"],
      ] as const;

      for (const idAllowlist of invalidAllowlists) {
        const invoke = () => operation === "reap"
          ? repo.reap({ scope, idAllowlist })
          : operation === "quarantineUnknown"
            ? repo.quarantineUnknown({
                scope,
                authoritativeHandlerTypes: [...registry.types],
                idAllowlist,
              })
            : repo.lease({
                scope,
                owner: "worker-b",
                leaseMs: 100,
                idAllowlist,
              });

        await expect(Promise.resolve().then(invoke)).rejects.toThrow(/id allowlist/i);
      }
      expect(pool.connectCount).toBe(0);
      expect(client.calls).toEqual([]);
    },
  );

  test.each([
    ["reap", 9, 8],
    ["quarantineUnknown", 10, 9],
    ["lease", 10, 9],
  ] as const)(
    "%s 用参数化 text[] 精确限制候选，allowlist 固定在 $%i",
    async (operation, placeholder, parameterIndex) => {
      const client = new FakeClient((sql) => {
        const control = transactionControl(sql);
        if (control) return control;
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      const idAllowlist = ["history-job:target-a", "history-job:target-b"];
      const repo = repository(client);
      const result = operation === "reap"
        ? repo.reap({ scope, idAllowlist })
        : operation === "quarantineUnknown"
          ? repo.quarantineUnknown({
              scope,
              authoritativeHandlerTypes: [...registry.types],
              idAllowlist,
            })
          : repo.lease({ scope, owner: "worker-b", leaseMs: 100, idAllowlist });

      await expect(result).resolves.toEqual({ applied: 0 });
      const select = client.calls[1]!;
      expect(select.sql).toContain(`AND id = ANY($${placeholder}::text[])`);
      expect(select.sql).not.toContain(idAllowlist[0]);
      expect(select.params?.[parameterIndex]).toEqual(idAllowlist);
    },
  );

  test("history leaf、finalize 候选及 finalize barrier 共用同一 idAllowlist", async () => {
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const idAllowlist = ["history-job:target-leaf", "history-job:target-finalize"];

    await expect(repository(client).lease({
      scope,
      owner: "worker-b",
      leaseMs: 100,
      idPrefix: "history-job:",
      idAllowlist,
    })).resolves.toEqual({ applied: 0 });

    const selects = client.calls.filter(({ sql }) => /FOR UPDATE SKIP LOCKED/.test(sql));
    expect(selects).toHaveLength(2);
    expect(selects[0]!.sql).toContain("AND id = ANY($10::text[])");
    expect(selects[1]!.sql.match(/= ANY\(\$10::text\[\]\)/g)).toHaveLength(2);
    expect(selects[1]!.sql).toContain("history_leaf.id = ANY($10::text[])");
    expect(selects[0]!.params?.[9]).toEqual(idAllowlist);
    expect(selects[1]!.params?.[9]).toEqual(idAllowlist);
  });

  test.each(["reap", "quarantineUnknown", "lease"] as const)(
    "%s 对 adapter 返回的 allowlist 外候选二次 fail-closed",
    async (operation) => {
      const candidate = operation === "reap"
        ? running(queued({ id: "history-job:outside", maxAttempts: 1 }))
        : operation === "quarantineUnknown"
          ? { ...orphanedQueued(), id: "history-job:outside" }
          : queued({ id: "history-job:outside" });
      const client = new FakeClient((sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      const repo = repository(client, { clock: () => operation === "reap" ? 220 : 150 });
      const result = operation === "reap"
        ? repo.reap({ scope, idAllowlist: ["history-job:allowed"] })
        : operation === "quarantineUnknown"
          ? repo.quarantineUnknown({
              scope,
              authoritativeHandlerTypes: [...registry.types],
              idAllowlist: ["history-job:allowed"],
            })
          : repo.lease({
              scope,
              owner: "worker-b",
              leaseMs: 100,
              idAllowlist: ["history-job:allowed"],
            });

      await expect(result).rejects.toMatchObject({ code: "INVALID_JOB" });
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );

  test.each(["reap", "quarantineUnknown", "lease"] as const)(
    "%s 支持固定 history 前缀排除且 SQL 不接受调用方片段",
    async (operation) => {
      const client = new FakeClient((sql) => {
        const control = transactionControl(sql);
        if (control) return control;
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      const repo = repository(client);
      const result = operation === "reap"
        ? repo.reap({ scope, excludeIdPrefix: "history-job:" })
        : operation === "quarantineUnknown"
          ? repo.quarantineUnknown({
              scope,
              authoritativeHandlerTypes: [...registry.types],
              excludeIdPrefix: "history-job:",
            })
          : repo.lease({
              scope,
              owner: "worker-b",
              leaseMs: 100,
              excludeIdPrefix: "history-job:",
            });

      await expect(result).resolves.toEqual({ applied: 0 });
      expect(client.calls[1]!.sql).toMatch(
        /visibility = \$7\s+AND id NOT LIKE 'history-job:%'/,
      );
    },
  );

  test("include/exclude 同传或任一非固定前缀时在 connect 前 fail-closed", async () => {
    const client = new FakeClient(() => {
      throw new Error("must not query");
    });
    const pool = new FakePool(client);
    const repo = new PostgresDurableJobV2Repository(pool, {
      registry,
      clock: () => 100,
      tokenFactory: () => "b".repeat(32),
      backoffMs: () => 100,
    });

    expect(() => repo.lease({
      scope,
      owner: "worker-b",
      leaseMs: 100,
      idPrefix: "history-job:",
      excludeIdPrefix: "history-job:",
    })).toThrow(/mutually exclusive/i);
    await expect(repo.quarantineUnknown({
      scope,
      authoritativeHandlerTypes: [...registry.types],
      excludeIdPrefix: "job:",
    })).rejects.toThrow(/prefix is invalid/i);
    expect(pool.connectCount).toBe(0);
  });
});

describe("PostgresDurableJobV2Repository lease/reap", () => {
  test("history finalize 即使排序在前也被同 target leaf barrier 排除且不消耗 attempt", async () => {
    const leaf = queued({
      id: "history-job:append-z",
      type: "build_tree",
      payload: {
        scope: { ...scope, workspaceId: "workspace-1", sessionId: "session-1" },
        traceId: "memory-1",
        treeType: "source",
        treeKey: "session-1",
        leaf: { id: "memory-1" },
      },
      dedupeKey: "build_tree:append-z",
    });
    const leasedLeaf = leaseDurableJobV2(leaf, {
      owner: "worker-b", now: 120, leaseMs: 100, tokenFactory: () => "b".repeat(32),
    }).job;
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(leaf)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [rowFor(leasedLeaf)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client, { clock: () => 120 }).lease({
      scope, owner: "worker-b", leaseMs: 100,
    })).resolves.toEqual({ applied: 1, job: leasedLeaf });

    const select = client.calls[1]!;
    expect(select.sql).toMatch(
      /payload#>>'\{finalize,mode\}' = 'history_rebuild'[\s\S]+EXISTS \([\s\S]+history_leaf.status <> 'completed'/,
    );
    expect(select.sql).toMatch(
      /history_leaf\.payload \? 'leaf'[\s\S]+treeType'[\s\S]+treeKey'[\s\S]+workspaceId[\s\S]+sessionId/,
    );
    expect(select.sql).toMatch(
      /history_leaf\.status <> 'completed' OR NOT EXISTS \([\s\S]+mengshu_job_v2_effect_receipts[\s\S]+build_tree\.persist\.v1/,
    );
    expect(select.sql).not.toMatch(/history_leaf\.created_at|history_leaf\.run_id/);
    expect(select.sql).toMatch(/id LIKE 'history-job:%'/);
    expect(leaf.attempts).toBe(0);
    expect(leasedLeaf.attempts).toBe(1);
  });

  test("lease barrier 只约束 history finalize，普通在线 build_tree 保持原阈值调度", async () => {
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).lease({ scope, owner: "worker-b", leaseMs: 100 }))
      .resolves.toEqual({ applied: 0 });
    const select = client.calls[1]!.sql;
    expect(select).toContain("id LIKE 'history-job:%'");
    expect(select).toContain("payload#>>'{finalize,mode}' = 'history_rebuild'");
    expect(select).not.toMatch(/maxLeafCount|maxTokenCount|forceSeal/);
  });

  test("history cohort 先租 leaf，仅在 scope leaf receipts 齐备后评估 finalize", async () => {
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client).lease({
      scope, owner: "worker-b", leaseMs: 100, idPrefix: "history-job:",
    })).resolves.toEqual({ applied: 0 });

    const selects = client.calls.filter(({ sql }) => /FOR UPDATE SKIP LOCKED/.test(sql));
    expect(selects).toHaveLength(2);
    expect(selects[0]!.sql).toContain("payload ? 'leaf'");
    expect(selects[0]!.sql).not.toContain("payload#>>'{finalize,mode}'");
    expect(selects[1]!.sql).toContain("payload#>>'{finalize,mode}' = 'history_rebuild'");
    expect(selects[1]!.sql).toContain("history_leaf.tenant_id = $1");
    expect(selects[1]!.sql).toContain("history_leaf.status <> 'completed'");
    expect(selects[1]!.sql).toContain("effect_key = 'build_tree.persist.v1'");
    expect(selects[1]!.sql).not.toContain(
      "history_leaf.payload->>'treeKey' = mengshu_jobs_v2.payload->>'treeKey'",
    );
  });

  test.each(["lease", "reap"] as const)(
    "%s 的 history cohort 使用固定 id prefix，普通调用不增加候选过滤",
    async (operation) => {
      const client = new FakeClient((sql) => {
        const control = transactionControl(sql);
        if (control) return control;
        if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      const repo = repository(client);
      const run = (idPrefix?: string) => operation === "lease"
        ? repo.lease({ scope, owner: "worker-b", leaseMs: 100, ...(idPrefix ? { idPrefix } : {}) })
        : repo.reap({ scope, ...(idPrefix ? { idPrefix } : {}) });

      await expect(run()).resolves.toEqual({ applied: 0 });
      const ordinarySql = client.calls[1]!.sql;
      await expect(run("history-job:")).resolves.toEqual({ applied: 0 });
      const cohortSql = client.calls[4]!.sql;

      expect(cohortSql).toMatch(
        /visibility = \$7\s+AND id LIKE 'history-job:%'\s+AND/,
      );
      expect(ordinarySql).not.toMatch(
        /visibility = \$7\s+AND id LIKE 'history-job:%'\s+AND/,
      );
    },
  );

  test.each(["lease", "reap"] as const)(
    "%s 对非固定 history id prefix 在连接数据库前同步拒绝",
    (operation) => {
      const client = new FakeClient(() => {
        throw new Error("must not query");
      });
      const repo = repository(client);
      const invoke = () => operation === "lease"
        ? repo.lease({ scope, owner: "worker-b", leaseMs: 100, idPrefix: "history-job:x" })
        : repo.reap({ scope, idPrefix: "job:" });

      expect(invoke).toThrow(/id prefix is invalid/i);
      expect(client.calls).toEqual([]);
    },
  );

  test("quarantineUnknown 用 authoritative type-array + due scope + SKIP LOCKED 原子转 DLQ", async () => {
    const candidate = orphanedQueued();
    const expected = quarantineUnknownDurableJobV2(candidate, {
      authoritativeRegistry: registry,
      now: 150,
    }).job!;
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [rowFor(expected)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository(client, { clock: () => 150 }).quarantineUnknown({
      scope,
      authoritativeHandlerTypes: [...registry.types],
    });

    expect(result).toEqual({ applied: 1, job: expected });
    expect(client.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN", expect.any(String), expect.any(String), "COMMIT",
    ]);
    expect(client.calls[1]?.sql).toMatch(
      /status IN \('queued', 'retry_wait'\)[\s\S]+next_attempt_at <=[\s\S]+NOT \(type = ANY\(\$8::text\[\]\)\)[\s\S]+FOR UPDATE SKIP LOCKED/i,
    );
    expect(client.calls[1]?.params).toEqual([
      ...Object.values(scope), [...registry.types], 150,
    ]);
    expect(client.calls[2]?.sql).toMatch(
      /UPDATE mengshu_jobs_v2[\s\S]+status[\s\S]+scoped_dedupe_key[\s\S]+updated_at[\s\S]+RETURNING/i,
    );
    const updateParams = client.calls[2]?.params ?? [];
    expect(updateParams).toContain("HANDLER_NOT_REGISTERED");
    expect(updateParams).toContain(false);
    expect(updateParams).toEqual(expect.arrayContaining([
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]));
    expect(JSON.stringify(updateParams)).not.toContain("opaque-reference");
  });

  test("quarantineUnknown 无 candidate 或 CAS miss 均 applied=0，保留并发安全", async () => {
    const noCandidateClient = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(repository(noCandidateClient).quarantineUnknown({
      scope,
      authoritativeHandlerTypes: [...registry.types],
    })).resolves.toEqual({ applied: 0 });
    expect(noCandidateClient.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN", expect.any(String), "COMMIT",
    ]);

    const candidate = orphanedQueued();
    const casMissClient = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(repository(casMissClient, { clock: () => 150 }).quarantineUnknown({
      scope,
      authoritativeHandlerTypes: [...registry.types],
    })).resolves.toEqual({ applied: 0, job: candidate });
    expect(casMissClient.calls[2]?.sql).toMatch(
      /status = \$22[\s\S]+attempts = \$23[\s\S]+lease_generation = \$24[\s\S]+updated_at = \$25/i,
    );
  });

  test("quarantineUnknown 对 forged scope/registered candidate rollback", async () => {
    const otherScope = { ...scope, tenantId: "tenant-other" };
    const candidates = [
      {
        ...orphanedQueued(),
        scope: otherScope,
        scopedDedupeKey: "f".repeat(64),
      } satisfies DurableJobV2,
      queued(),
    ];
    for (const candidate of candidates) {
      const client = new FakeClient((sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
        throw new Error(`unexpected SQL: ${sql}`);
      });

      await expect(repository(client, { clock: () => 150 }).quarantineUnknown({
        scope,
        authoritativeHandlerTypes: [...registry.types],
      })).rejects.toMatchObject({ code: "INVALID_JOB" });
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(client.releaseCount).toBe(1);
    }
  });

  test("quarantineUnknown 空/非法/partial registry 在 connect 前 fail-closed", async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const pool = new FakePool(client);
    const repo = new PostgresDurableJobV2Repository(pool, {
      registry,
      clock: () => 150,
      tokenFactory: () => "b".repeat(32),
      backoffMs: () => 100,
    });

    for (const authoritativeHandlerTypes of [[], ["bad type"], ["build_tree"]]) {
      await expect(repo.quarantineUnknown({ scope, authoritativeHandlerTypes }))
        .rejects.toMatchObject({ code: expect.any(String) });
    }
    expect(pool.connectCount).toBe(0);
  });

  test("无 candidate 时不生成 token，scope/type eligibility SELECT 使用 SKIP LOCKED", async () => {
    const tokenFactory = vi.fn(() => "b".repeat(32));
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client, { tokenFactory }).lease({
      scope,
      owner: "worker-b",
      leaseMs: 100,
    })).resolves.toEqual({ applied: 0 });

    expect(tokenFactory).not.toHaveBeenCalled();
    expect(client.calls[1]?.sql).toMatch(/type = ANY[\s\S]+FOR UPDATE SKIP LOCKED/i);
    expect(client.calls[1]?.params).toEqual(expect.arrayContaining([
      scope.tenantId, scope.userId, scope.appId, scope.projectId,
      scope.agentId, scope.namespace, scope.visibility,
      [...registry.types],
    ]));
  });

  test("lease candidate 后才生成 token，UPDATE 用 old state/generation/scope CAS", async () => {
    const candidate = queued();
    const leased = leaseDurableJobV2(candidate, {
      owner: "worker-b", now: 120, leaseMs: 100, tokenFactory: () => "b".repeat(32),
    }).job;
    const tokenFactory = vi.fn(() => "b".repeat(32));
    const client = new FakeClient((sql) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/^SELECT[\s\S]+SKIP LOCKED/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [rowFor(leased)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository(client, { clock: () => 120, tokenFactory }).lease({
      scope,
      owner: "worker-b",
      leaseMs: 100,
    });

    expect(result).toEqual({ applied: 1, job: leased });
    expect(tokenFactory).toHaveBeenCalledTimes(1);
    expect(client.calls[2]?.sql).toMatch(/UPDATE mengshu_jobs_v2[\s\S]+tenant_id[\s\S]+status[\s\S]+attempts[\s\S]+lease_generation[\s\S]+RETURNING/i);
    expect(client.calls[2]?.params).toEqual(expect.arrayContaining([
      candidate.id,
      candidate.scopedDedupeKey,
      scope.tenantId,
      scope.userId,
      "queued",
      0,
    ]));
  });

  test("reap 仅锁定 final expired lease 并以 owner/token/generation/leaseUntil CAS", async () => {
    const candidate = running(queued({ maxAttempts: 1 }));
    const client = new FakeClient((sql, params) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) {
        const actual: DurableJobV2 = {
          ...candidate,
          status: "dead_letter",
          leaseOwner: undefined,
          leaseToken: undefined,
          leaseUntil: undefined,
          heartbeatAt: undefined,
          lastError: {
            code: "LEASE_EXPIRED",
            retryable: false,
            fingerprint: String(params.find(
              (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
            )),
          },
          updatedAt: 220,
        };
        return { rows: [rowFor(actual)], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository(client, { clock: () => 220 }).reap({ scope });

    expect(result.applied).toBe(1);
    expect(client.calls[1]?.sql).toMatch(/attempts >= max_attempts[\s\S]+FOR UPDATE SKIP LOCKED/i);
    expect(client.calls[2]?.sql).toMatch(/lease_owner[\s\S]+lease_token[\s\S]+lease_generation[\s\S]+lease_until/i);
  });

  test.each(["lease", "reap"] as const)("%s 对 SQL adapter 返回的跨 scope candidate 二次 fail-closed", async (operation) => {
    const otherScope: DurableJobV2Scope = { ...scope, tenantId: "tenant-other" };
    const candidate = operation === "lease"
      ? queued({ scope: otherScope })
      : running(queued({ scope: otherScope, maxAttempts: 1 }));
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const repo = repository(client, { clock: () => operation === "lease" ? 120 : 220 });

    const execution = operation === "lease"
      ? repo.lease({ scope, owner: "worker-b", leaseMs: 100 })
      : repo.reap({ scope });
    await expect(execution).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});

describe("PostgresDurableJobV2Repository fenced CAS", () => {
  test.each(["renew", "complete", "fail"] as const)(
    "%s 先按 id+scope FOR UPDATE，再以 owner/token/generation/expiry CAS",
    async (operation) => {
      const candidate = running();
      const client = new FakeClient((sql) => {
        const control = transactionControl(sql);
        if (control) return control;
        if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
        if (/^UPDATE/i.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      const repo = repository(client, { clock: () => 150 });
      const fenced = {
        id: candidate.id,
        scope,
        owner: candidate.leaseOwner!,
        leaseToken: candidate.leaseToken!,
        leaseGeneration: candidate.leaseGeneration,
      };
      const result = operation === "renew"
        ? await repo.renew({ ...fenced, leaseMs: 100 })
        : operation === "complete"
          ? await repo.complete(fenced)
          : await repo.fail({
              ...fenced,
              failure: { code: "PROVIDER_ERROR", retryable: true, message: "secret-raw-error" },
            });

      expect(result).toEqual({ applied: 0, job: candidate });
      expect(client.calls[1]?.sql).toMatch(/WHERE id = \$1[\s\S]+tenant_id[\s\S]+FOR UPDATE/i);
      expect(client.calls[2]?.sql).toMatch(/lease_owner[\s\S]+lease_token[\s\S]+lease_generation[\s\S]+lease_until >[\s\S]+RETURNING/i);
      expect(client.calls[2]?.params).toEqual(expect.arrayContaining([
        candidate.id,
        scope.tenantId,
        scope.userId,
        candidate.leaseOwner,
        candidate.leaseToken,
        candidate.leaseGeneration,
      ]));
      expect(client.calls.flatMap(({ params }) => params).join("|")).not.toContain("secret-raw-error");
    },
  );

  test("fail SQL 只持久化安全 code/retryable/fingerprint，不含 raw message", async () => {
    const candidate = running();
    const client = new FakeClient((sql, params) => {
      const control = transactionControl(sql);
      if (control) return control;
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) {
        const updated: DurableJobV2 = {
          ...candidate,
          status: "retry_wait",
          nextAttemptAt: 250,
          leaseOwner: undefined,
          leaseToken: undefined,
          leaseUntil: undefined,
          heartbeatAt: undefined,
          lastError: {
            code: String(params.find((value) => value === "PROVIDER_ERROR")),
            retryable: true,
            fingerprint: String(params.find((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))),
          },
          updatedAt: 150,
        };
        return { rows: [rowFor(updated)], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await repository(client, { clock: () => 150 }).fail({
      id: candidate.id,
      scope,
      owner: candidate.leaseOwner!,
      leaseToken: candidate.leaseToken!,
      leaseGeneration: candidate.leaseGeneration,
      failure: {
        code: "PROVIDER_ERROR",
        retryable: true,
        message: "password=must-never-enter-sql-params",
      },
    });

    expect(result).toMatchObject({ applied: 1, job: { status: "retry_wait" } });
    const allParams = client.calls.flatMap(({ params }) => params);
    expect(JSON.stringify(allParams)).not.toContain("must-never-enter-sql-params");
    expect(allParams).toContain("PROVIDER_ERROR");
    expect(allParams).toContain(true);
    expect(allParams).toEqual(expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]));
  });

  test("CAS RETURNING 即使 shape 合法但换成其他 scope identity 也必须 rollback", async () => {
    const candidate = running();
    const otherScope: DurableJobV2Scope = { ...scope, tenantId: "tenant-other" };
    const other = running(queued({ scope: otherScope }));
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [rowFor(other)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client, { clock: () => 150 }).renew({
      id: candidate.id,
      scope,
      owner: candidate.leaseOwner!,
      leaseToken: candidate.leaseToken!,
      leaseGeneration: candidate.leaseGeneration,
      leaseMs: 100,
    })).rejects.toMatchObject({ code: "INVALID_JOB" });

    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("CAS RETURNING identity 正确但状态不是纯状态机目标时 rollback", async () => {
    const candidate = running();
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/^SELECT/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      if (/^UPDATE/i.test(sql)) return { rows: [rowFor(candidate)], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(repository(client, { clock: () => 150 }).renew({
      id: candidate.id, scope,
      owner: candidate.leaseOwner!, leaseToken: candidate.leaseToken!,
      leaseGeneration: candidate.leaseGeneration, leaseMs: 100,
    })).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("每个入口在 connect 前拒绝非法 server canonical scope", async () => {
    const client = new FakeClient(() => ({ rows: [], rowCount: 0 }));
    const pool = new FakePool(client);
    const repo = new PostgresDurableJobV2Repository(pool, {
      registry,
      clock: () => 150,
      tokenFactory: () => "b".repeat(32),
      backoffMs: () => 100,
    });
    const invalidScope = { ...scope, tenantId: "" };
    const fenced = {
      id: "job-1", scope: invalidScope, owner: "worker-a",
      leaseToken: "a".repeat(32), leaseGeneration: 1,
    };
    const operations = [
      () => repo.quarantineUnknown({
        scope: invalidScope,
        authoritativeHandlerTypes: [...registry.types],
      }),
      () => repo.lease({ scope: invalidScope, owner: "worker-a", leaseMs: 100 }),
      () => repo.renew({ ...fenced, leaseMs: 100 }),
      () => repo.complete(fenced),
      () => repo.fail({ ...fenced, failure: { code: "ERROR", retryable: false } }),
      () => repo.reap({ scope: invalidScope }),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: "INVALID_JOB" });
    }
    expect(pool.connectCount).toBe(0);
  });
});

describe("PostgresDurableJobV2Repository transaction cleanup", () => {
  test("operation + rollback + release failure 均保留在 AggregateError", async () => {
    const operationFailure = new Error("operation-failed");
    const rollbackFailure = new Error("rollback-failed");
    const releaseFailure = new Error("release-failed");
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN") return { rows: [], rowCount: 0 };
      if (sql === "ROLLBACK") throw rollbackFailure;
      throw operationFailure;
    });
    client.releaseFailure = releaseFailure;

    const failure = await repository(client).lease({
      scope, owner: "worker-a", leaseMs: 100,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(leafErrors(failure)).toEqual([operationFailure, rollbackFailure, releaseFailure]);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain("password");
    expect(client.releaseCount).toBe(1);
    expect(client.calls.map(({ sql }) => sql)).toEqual(["BEGIN", expect.any(String), "ROLLBACK"]);
  });
});
