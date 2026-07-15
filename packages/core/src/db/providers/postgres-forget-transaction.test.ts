import { describe, expect, test, vi } from "vitest";
import { normalizeProviderFilter } from "../../domain/provider-filter.js";
import type {
  AuthorityScopedForgetReceipt,
  ForgetAuditEvent,
  ForgetOutboxEvent,
  ForgetTargetSelection,
} from "../../domain/service-types.js";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import { recordToMemoryEntry } from "../../domain/legacy-mapping.js";
import { PostgresProvider } from "./postgres.js";
import {
  postgresForgetStorageIdempotencyKey,
  PostgresForgetTransactionPort,
  type PostgresForgetPool,
  type PostgresForgetPoolClient,
} from "./postgres-forget-transaction.js";

interface Call {
  sql: string;
  params: readonly unknown[];
}

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private",
};

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "owned memory",
  content_hash: "hash-owned",
  importance: 0.8,
  category: "fact",
  data_type: "memory",
  metadata: { source: "user", semanticType: "profile" },
  created_at: new Date(1_000),
  tenant_id: scope.tenantId,
  user_id: scope.userId,
  product_id: scope.appId,
  canonical_project_id: scope.projectId,
  producer_id: scope.agentId,
  namespace: scope.namespace,
  visibility: scope.visibility,
  lifecycle_status: "active",
};

class FakeClient implements PostgresForgetPoolClient {
  calls: Call[] = [];
  releaseCount = 0;
  targetRows: Record<string, unknown>[] = [row];
  receiptRows: Record<string, unknown>[] = [];
  failSql?: RegExp;
  failRelease = false;
  mutationRowCount = 1;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (this.failSql?.test(sql)) throw new Error(`forced SQL failure: ${sql}`);
    if (/^SELECT[\s\S]*FROM\s+"(?:memories|knowledge)"/i.test(sql)) {
      return { rows: this.targetRows as Row[], rowCount: this.targetRows.length };
    }
    if (/FROM\s+mengshu_forget_receipts/i.test(sql)) {
      return { rows: this.receiptRows as Row[], rowCount: this.receiptRows.length };
    }
    if (/INSERT INTO\s+"memories"/i.test(sql)) {
      const metadata = JSON.parse(String(params[7])) as Record<string, unknown>;
      this.targetRows = [{
        id: params[0],
        text: params[1],
        content_hash: params[2],
        importance: params[4],
        category: params[5],
        data_type: params[6],
        metadata,
        created_at: new Date(String(params[8])),
        user_id: params[11],
        tenant_id: params[14],
        canonical_project_id: params[15],
        product_id: params[16],
        producer_id: params[17],
        namespace: params[18],
        visibility: params[19],
        lifecycle_status: params[20],
      }];
      return { rows: [{ id: params[0] }] as unknown as Row[], rowCount: 1 };
    }
    if (/^(?:UPDATE|DELETE)\s/i.test(sql)) {
      return { rows: [], rowCount: this.mutationRowCount };
    }
    return { rows: [], rowCount: 1 };
  }

  release(): void {
    this.releaseCount += 1;
    if (this.failRelease) throw new Error("forced release failure");
  }
}

class FakePool implements PostgresForgetPool {
  connectCount = 0;
  query = vi.fn(async () => {
    throw new Error("pool.query must not be used for forget transaction");
  });

  constructor(readonly client: FakeClient) {}

  async connect(): Promise<PostgresForgetPoolClient> {
    this.connectCount += 1;
    return this.client;
  }
}

class StoreThenForgetPool implements PostgresForgetPool {
  readonly client = new FakeClient();
  readonly calls: Call[] = [];

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: never[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (/INSERT INTO\s+"memories"/i.test(sql)) {
      const metadata = JSON.parse(String(params[7])) as Record<string, unknown>;
      this.client.targetRows = [{
        id: params[0],
        text: params[1],
        content_hash: params[2],
        importance: params[4],
        category: params[5],
        data_type: params[6],
        metadata,
        created_at: new Date(String(params[8])),
        user_id: params[11],
        tenant_id: params[14],
        canonical_project_id: params[15],
        product_id: params[16],
        producer_id: params[17],
        namespace: params[18],
        visibility: params[19],
        lifecycle_status: params[20],
      }];
    }
    return { rows: [], rowCount: 1 };
  }

  async connect(): Promise<PostgresForgetPoolClient> {
    return this.client;
  }
}

function normalized(extra: Record<string, unknown>) {
  return normalizeProviderFilter(
    { tenantId: scope.tenantId, userId: scope.userId },
    {
      operation: "delete",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: {
        appId: scope.appId,
        projectId: scope.projectId,
        agentId: scope.agentId,
        namespace: scope.namespace,
        visibility: scope.visibility,
        ...extra,
      },
    },
  );
}

function idSelection(): ForgetTargetSelection {
  return {
    kind: "ids",
    scope,
    tableName: "memories",
    dataTypes: ["memory"],
    filters: [normalized({ id: row.id })],
  };
}

function audit(record: MemoryRecord): ForgetAuditEvent {
  return {
    idempotencyKey: "forget-1",
    action: "revoke",
    targetId: record.id,
    scope: record.scope,
    actor: "user-a",
    reason: "incorrect",
    at: 2_000,
    before: { lifecycleStatus: "active" },
    after: { lifecycleStatus: "revoked" },
  };
}

function outbox(record: MemoryRecord): ForgetOutboxEvent {
  return {
    eventId: `forget-1:${record.id}`,
    idempotencyKey: "forget-1",
    topic: "memory.lifecycle.changed",
    action: "revoke",
    targetId: record.id,
    scope: record.scope,
    occurredAt: 2_000,
  };
}

function receipt(): AuthorityScopedForgetReceipt {
  return {
    idempotencyKey: "forget-1",
    scope,
    requestFingerprint: "a".repeat(64),
    result: {
      action: "revoke",
      affected: 1,
      deleted: 0,
      affectedIds: [row.id],
      transactional: true,
      idempotentReplay: false,
    },
  };
}

describe("PostgresForgetTransactionPort", () => {
  test("dedicated PoolClient 上完成 lock/find/replace/audit/outbox/receipt/commit 后 release", async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const port = new PostgresForgetTransactionPort(pool);

    await port.transaction(async (tx) => {
      expect(await tx.getReceipt(scope, "forget-1")).toBeUndefined();
      const records = await tx.findTargets(idSelection());
      expect(records).toHaveLength(1);
      const updated = {
        ...records[0]!,
        lifecycleStatus: "revoked" as const,
        metadata: { ...records[0]!.metadata, lifecycleStatus: "revoked" },
      };
      await tx.replace([updated]);
      await tx.appendAudit([audit(updated)]);
      await tx.appendOutbox([outbox(updated)]);
      await tx.saveReceipt(receipt());
    });

    expect(pool.connectCount).toBe(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.some((call) => /pg_advisory_xact_lock/.test(call.sql))).toBe(true);
    const select = client.calls.find((call) => /FOR UPDATE/.test(call.sql));
    expect(select?.sql).toContain('FROM "memories"');
    expect(select?.sql.match(/\btenant_id\s*=\s*\$/g)).toHaveLength(1);
    expect(select?.sql).not.toContain("tenant-a");
    expect(select?.sql).not.toContain("project-a");
    expect(select?.params).toEqual(expect.arrayContaining(["tenant-a", "user-a", "project-a"]));
    const update = client.calls.find((call) => /^UPDATE\s/i.test(call.sql));
    expect(update?.sql.match(/\btenant_id\s*=\s*\$/g)).toHaveLength(1);
    expect(client.calls.some((call) => /INSERT INTO mengshu_forget_audit/.test(call.sql))).toBe(true);
    expect(client.calls.some((call) => /INSERT INTO mengshu_forget_outbox/.test(call.sql))).toBe(true);
    expect(client.calls.some((call) => /INSERT INTO mengshu_forget_receipts/.test(call.sql))).toBe(true);
    const storageKey = postgresForgetStorageIdempotencyKey(scope, "forget-1");
    expect(client.calls.find((call) => /INSERT INTO mengshu_forget_audit/.test(call.sql))?.params[0]).toBe(storageKey);
    expect(client.calls.find((call) => /INSERT INTO mengshu_forget_outbox/.test(call.sql))?.params[1]).toBe(storageKey);
    expect(client.calls.find((call) => /INSERT INTO mengshu_forget_receipts/.test(call.sql))?.params[0]).toBe(storageKey);
    expect(storageKey).not.toContain("forget-1");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.releaseCount).toBe(1);
  });

  test("delete 只能删除本事务 findTargets 已锁定的 canonical scope 记录", async () => {
    const client = new FakeClient();
    const port = new PostgresForgetTransactionPort(new FakePool(client));

    await port.transaction(async (tx) => {
      await expect(tx.delete([row.id])).rejects.toThrow(/locked|findTargets/i);
      await tx.findTargets(idSelection());
      await tx.delete([row.id]);
    });

    const statement = client.calls.find((call) => /^DELETE\s+FROM/i.test(call.sql));
    expect(statement?.sql).toContain('DELETE FROM "memories"');
    expect(statement?.sql.match(/\btenant_id\s*=\s*\$/g)).toHaveLength(1);
    expect(statement?.sql).toMatch(/tenant_id\s*=\s*\$/);
    expect(statement?.sql).toMatch(/user_id\s*=\s*\$/);
    expect(statement?.params).toEqual(expect.arrayContaining([[row.id], "tenant-a", "user-a"]));
  });

  test("filter selection 使用固定列/metadata 表达式和参数，不拼接 table/value", async () => {
    const client = new FakeClient();
    const port = new PostgresForgetTransactionPort(new FakePool(client));
    const filter = normalized({ category: "fact", source: "user", pinned: true });

    await port.transaction(async (tx) => {
      await tx.findTargets({
        kind: "filter",
        scope,
        tableName: "memories",
        dataTypes: ["memory"],
        filter,
      });
    });

    const statement = client.calls.find((call) => /FOR UPDATE/.test(call.sql))!;
    expect(statement.sql).toContain('metadata->>\'source\'');
    expect(statement.sql).toContain('metadata->>\'pinned\'');
    expect(statement.sql).not.toContain("tenant-a");
    expect(statement.sql).not.toContain("user-a");
    expect(statement.params).toEqual(expect.arrayContaining(["tenant-a", "user-a", "fact", "user", "true"]));
  });

  test("伪造表名或未归一化 selection 会 rollback 并拒绝执行动态 SQL", async () => {
    const client = new FakeClient();
    const port = new PostgresForgetTransactionPort(new FakePool(client));
    const unsafe = { ...idSelection(), tableName: 'memories"; DROP TABLE memories; --' } as unknown as ForgetTargetSelection;

    await expect(port.transaction((tx) => tx.findTargets(unsafe))).rejects.toThrow(/table|selection/i);
    expect(client.calls.map((call) => call.sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releaseCount).toBe(1);
  });

  test("work 失败 rollback 并 release；rollback/release 二次故障保留所有错误", async () => {
    const client = new FakeClient();
    const port = new PostgresForgetTransactionPort(new FakePool(client));

    await expect(
      port.transaction(async () => {
        throw new Error("work failure");
      }),
    ).rejects.toThrow("work failure");
    expect(client.calls.map((call) => call.sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releaseCount).toBe(1);

    const doubleFailure = new FakeClient();
    doubleFailure.failSql = /^ROLLBACK$/;
    doubleFailure.failRelease = true;
    await expect(
      new PostgresForgetTransactionPort(new FakePool(doubleFailure)).transaction(async () => {
        throw new Error("primary failure");
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(doubleFailure.releaseCount).toBe(1);
  });

  test("commit 后 release 失败向上传播，已持久化 receipt 可使上层安全重试", async () => {
    const client = new FakeClient();
    client.failRelease = true;
    const port = new PostgresForgetTransactionPort(new FakePool(client));

    await expect(port.transaction(async () => "committed")).rejects.toThrow("release failure");
    expect(client.calls.map((call) => call.sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.releaseCount).toBe(1);
  });

  test("receipt 读取先获取同 idempotency key advisory lock 并严格解码", async () => {
    const client = new FakeClient();
    client.receiptRows = [{
      idempotency_key: postgresForgetStorageIdempotencyKey(scope, "forget-1"),
      request_fingerprint: "a".repeat(64),
      result: receipt().result,
    }];
    const port = new PostgresForgetTransactionPort(new FakePool(client));

    await expect(port.transaction((tx) => tx.getReceipt(scope, "forget-1"))).resolves.toEqual(receipt());
    expect(client.calls.slice(1, 3).map((call) => call.sql)).toEqual([
      expect.stringMatching(/pg_advisory_xact_lock/),
      expect.stringMatching(/FROM mengshu_forget_receipts/),
    ]);
  });

  test("tenant A/B 使用同一 client idempotency key 时 storage/advisory namespace 互不冲突", async () => {
    const client = new FakeClient();
    const port = new PostgresForgetTransactionPort(new FakePool(client));
    const scopeB = { ...scope, tenantId: "tenant-b", userId: "user-b" };

    await port.transaction(async (tx) => {
      expect(await tx.getReceipt(scope, "same-client-key")).toBeUndefined();
      expect(await tx.getReceipt(scopeB, "same-client-key")).toBeUndefined();
    });

    const advisoryKeys = client.calls
      .filter((call) => /pg_advisory_xact_lock/.test(call.sql))
      .map((call) => call.params[0]);
    expect(advisoryKeys).toEqual([
      postgresForgetStorageIdempotencyKey(scope, "same-client-key"),
      postgresForgetStorageIdempotencyKey(scopeB, "same-client-key"),
    ]);
    expect(advisoryKeys[0]).not.toBe(advisoryKeys[1]);
  });

  test.each([
    ["data_type", { data_type: "unsafe" }],
    ["visibility", { visibility: "unsafe" }],
    ["metadata", { metadata: null }],
    ["lifecycle_status", { lifecycle_status: "unsafe" }],
    ["importance", { importance: 9 }],
    ["created_at", { created_at: "not-a-date" }],
    ["tenant_id", { tenant_id: "" }],
  ])("持久化行 %s 非法时在 mutation 前 fail-closed", async (_field, override) => {
    const client = new FakeClient();
    client.targetRows = [{ ...row, ...override }];
    const port = new PostgresForgetTransactionPort(new FakePool(client));

    await expect(port.transaction((tx) => tx.findTargets(idSelection()))).rejects.toThrow(/invalid/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("selection 只能执行一次，且 empty/inconsistent/scope mismatch 均 fail-closed", async () => {
    const repeatedClient = new FakeClient();
    await expect(
      new PostgresForgetTransactionPort(new FakePool(repeatedClient)).transaction(async (tx) => {
        await tx.findTargets(idSelection());
        await tx.findTargets(idSelection());
      }),
    ).rejects.toThrow(/only be called once/i);

    const baseSelection = idSelection();
    if (baseSelection.kind !== "ids") throw new Error("test fixture must be an ids selection");
    const invalidSelections: ForgetTargetSelection[] = [
      { ...baseSelection, filters: [] },
      {
        ...baseSelection,
        filters: [normalized({ id: row.id }), normalized({ id: "22222222-2222-4222-8222-222222222222", category: "fact" })],
      },
      { ...baseSelection, scope: { ...scope, projectId: "project-b" } },
    ];
    for (const selection of invalidSelections) {
      const client = new FakeClient();
      await expect(
        new PostgresForgetTransactionPort(new FakePool(client)).transaction((tx) => tx.findTargets(selection)),
      ).rejects.toThrow(/selection|empty|inconsistent|mismatch/i);
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  test("provider 返回 scope 外记录、replace 改 scope、mutation rowCount 丢失均回滚", async () => {
    const outside = new FakeClient();
    outside.targetRows = [{ ...row, canonical_project_id: "project-b" }];
    await expect(
      new PostgresForgetTransactionPort(new FakePool(outside)).transaction((tx) => tx.findTargets(idSelection())),
    ).rejects.toThrow(/outside authority scope/i);

    const scopeMutation = new FakeClient();
    await expect(
      new PostgresForgetTransactionPort(new FakePool(scopeMutation)).transaction(async (tx) => {
        const [target] = await tx.findTargets(idSelection());
        await tx.replace([{ ...target!, scope: { ...target!.scope, projectId: "project-b" } }]);
      }),
    ).rejects.toThrow(/replacement scope mismatch/i);

    for (const operation of ["replace", "delete"] as const) {
      const lost = new FakeClient();
      lost.mutationRowCount = 0;
      await expect(
        new PostgresForgetTransactionPort(new FakePool(lost)).transaction(async (tx) => {
          const [target] = await tx.findTargets(idSelection());
          if (operation === "replace") await tx.replace([target!]);
          else await tx.delete([target!.id]);
        }),
      ).rejects.toThrow(/lost locked record/i);
    }
  });

  test("audit/outbox 只能引用 findTargets 锁定且 scope 相同的记录", async () => {
    const missing = new FakeClient();
    await expect(
      new PostgresForgetTransactionPort(new FakePool(missing)).transaction((tx) =>
        tx.appendAudit([audit({ ...row, scope } as unknown as MemoryRecord)])),
    ).rejects.toThrow(/locked records/i);

    for (const eventType of ["audit", "outbox"] as const) {
      const client = new FakeClient();
      await expect(
        new PostgresForgetTransactionPort(new FakePool(client)).transaction(async (tx) => {
          const [target] = await tx.findTargets(idSelection());
          const foreignScope = { ...target!.scope, projectId: "project-b" };
          if (eventType === "audit") await tx.appendAudit([{ ...audit(target!), scope: foreignScope }]);
          else await tx.appendOutbox([{ ...outbox(target!), scope: foreignScope }]);
        }),
      ).rejects.toThrow(/event scope mismatch/i);
    }
  });

  test("receipt key、多行、内容或 save identity 异常时 fail-closed", async () => {
    const badKey = new FakeClient();
    await expect(
      new PostgresForgetTransactionPort(new FakePool(badKey)).transaction((tx) => tx.getReceipt(scope, "bad key")),
    ).rejects.toThrow(/idempotency|namespace/i);

    const multiple = new FakeClient();
    multiple.receiptRows = [
      { idempotency_key: postgresForgetStorageIdempotencyKey(scope, "forget-1"), request_fingerprint: "a".repeat(64), result: receipt().result },
      { idempotency_key: postgresForgetStorageIdempotencyKey(scope, "forget-1"), request_fingerprint: "a".repeat(64), result: receipt().result },
    ];
    await expect(
      new PostgresForgetTransactionPort(new FakePool(multiple)).transaction((tx) => tx.getReceipt(scope, "forget-1")),
    ).rejects.toThrow(/multiple rows/i);

    const invalidResult = new FakeClient();
    invalidResult.receiptRows = [{
      idempotency_key: postgresForgetStorageIdempotencyKey(scope, "forget-1"),
      request_fingerprint: "a".repeat(64),
      result: { ...receipt().result, transactional: false },
    }];
    await expect(
      new PostgresForgetTransactionPort(new FakePool(invalidResult)).transaction((tx) => tx.getReceipt(scope, "forget-1")),
    ).rejects.toThrow(/result is invalid/i);

    const invalidSave = new FakeClient();
    await expect(
      new PostgresForgetTransactionPort(new FakePool(invalidSave)).transaction((tx) =>
        tx.saveReceipt({ ...receipt(), requestFingerprint: "not-sha256" })),
    ).rejects.toThrow(/identity is invalid/i);
  });

  test("PostgresProvider 工厂返回使用 provider pool dedicated client 的真实 port", async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const provider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");
    (provider as unknown as { pool: FakePool }).pool = pool;

    await provider.createForgetTransactionPort().transaction(async () => "ok");

    expect(pool.connectCount).toBe(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.calls.map((call) => call.sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.releaseCount).toBe(1);
  });

  test("MemoryRecord 映射、INSERT canonical 参数与 forget findTargets 形成无损闭环", async () => {
    const pool = new StoreThenForgetPool();
    const provider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");
    (provider as unknown as { pool: StoreThenForgetPool }).pool = pool;

    const record: MemoryRecord = {
      id: row.id,
      scope,
      kind: "fact",
      text: "owned memory",
      contentHash: "hash-round-trip",
      importance: 0.8,
      category: "fact",
      dataType: "memory",
      tableName: "memories",
      metadata: {
        source: "user",
        embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
        embeddingSpaceState: "known-queryable",
      },
      provenance: { source: "user" },
      lifecycleStatus: "active",
      createdAt: 1_000,
    };
    await provider.store([recordToMemoryEntry(record, [0.1, 0.2])]);

    const insert = pool.client.calls.find((call) => /INSERT INTO\s+"memories"/i.test(call.sql));
    expect(insert?.params.slice(14, 21)).toEqual([
      scope.tenantId,
      scope.projectId,
      scope.appId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
      "active",
    ]);

    const found = await provider.createForgetTransactionPort().transaction((tx) =>
      tx.findTargets(idSelection()),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.scope).toEqual(scope);
    expect(found[0]?.id).toBe(record.id);
    const lockedSelect = pool.client.calls.find((call) => /FOR UPDATE/.test(call.sql));
    expect(lockedSelect?.params).toEqual(expect.arrayContaining([
      scope.tenantId,
      scope.userId,
      scope.projectId,
      scope.appId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
    ]));
  });
});
