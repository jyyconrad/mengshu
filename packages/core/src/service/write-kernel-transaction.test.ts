import { describe, expect, test, vi } from "vitest";
import {
  createMemoryWriteReceipt,
  createWriteCommandFingerprint,
  createWriteIdempotencyIdentity,
  isProviderOwnedAtomicMemoryStorePort,
  PostgresAtomicMemoryStorePort,
  type PostgresMemoryWriteClient,
  validateMemoryWriteReceipt,
} from "./write-kernel-transaction.js";
import type { MemoryRecord } from "../domain/types.js";
import type { MemoryWriteCommand, WriteScope } from "./write-kernel.js";

const scope: WriteScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private",
};

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    scope: { ...scope, workspaceId: "workspace-a", sessionId: "session-a" },
    kind: "preference",
    semanticType: "profile",
    text: "durable write",
    contentHash: "hash-1",
    importance: 0.8,
    category: "preference",
    dataType: "memory",
    tableName: "memories",
    metadata: { source: "user" },
    provenance: { source: "user", createdAt: 1_000 },
    createdAt: 1_000,
    vector: [0.1, 0.2],
    ...overrides,
  };
}

class AtomicWriteClient implements PostgresMemoryWriteClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  receiptRows: Record<string, unknown>[] = [];
  failSql?: RegExp;
  failRelease = false;
  releaseCount = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (this.failSql?.test(sql)) throw new Error("forced atomic write failure");
    if (/FROM mengshu_write_receipts/.test(sql)) {
      return { rows: this.receiptRows as Row[], rowCount: this.receiptRows.length };
    }
    return { rows: [], rowCount: 1 };
  }

  release(): void {
    this.releaseCount += 1;
    if (this.failRelease) throw new Error("forced release failure");
  }
}

function command(
  metadata: Record<string, unknown> = { a: 1, b: 2 },
): Extract<MemoryWriteCommand, { type: "saveExplicit" }> {
  return {
    type: "saveExplicit",
    idempotencyKey: "write-1",
    serverAuthority: { tenantId: scope.tenantId, userId: scope.userId },
    clientScope: {
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
    },
    text: "durable write",
    metadata,
  };
}

describe("write kernel transaction identity", () => {
  test("storage identity 由 server tenant/user/client key 决定并跨 owner 隔离", () => {
    const first = createWriteIdempotencyIdentity(scope, "same-client-key");
    const reordered = createWriteIdempotencyIdentity({ ...scope }, "same-client-key");
    const tenantB = createWriteIdempotencyIdentity(
      { ...scope, tenantId: "tenant-b" },
      "same-client-key",
    );
    const userB = createWriteIdempotencyIdentity(
      { ...scope, userId: "user-b" },
      "same-client-key",
    );

    expect(first).toEqual(reordered);
    expect(first.storageKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.storageKey).not.toContain("same-client-key");
    expect(new Set([first.storageKey, tenantB.storageKey, userB.storageKey])).toHaveProperty("size", 3);
  });

  test.each(["", "bad key", "x".repeat(201)])("非法 client key %j fail-closed", (key) => {
    expect(() => createWriteIdempotencyIdentity(scope, key)).toThrow(/idempotency/i);
  });

  test("owner identity 缺 tenant/user 时 fail-closed", () => {
    expect(() => createWriteIdempotencyIdentity({ ...scope, tenantId: "" }, "write-1")).toThrow(/tenantId/);
    expect(() => createWriteIdempotencyIdentity({ ...scope, userId: "" }, "write-1")).toThrow(/userId/);
  });

  test("fingerprint 对 object key 顺序稳定，但覆盖 resolved scope 与 command payload", () => {
    const first = createWriteCommandFingerprint(scope, command({ a: 1, b: 2 }));
    const reordered = createWriteCommandFingerprint(scope, command({ b: 2, a: 1 }));
    const changedText = createWriteCommandFingerprint(scope, {
      ...command({ a: 1, b: 2 }),
      text: "changed",
    });
    const changedScope = createWriteCommandFingerprint(
      { ...scope, projectId: "project-b" },
      command({ a: 1, b: 2 }),
    );

    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(changedText);
    expect(first).not.toBe(changedScope);
  });

  test("fingerprint 拒绝循环 metadata，避免不可持久化 identity", () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    expect(() => createWriteCommandFingerprint(scope, command(metadata))).toThrow(/serializable/i);
  });

  test("fingerprint 拒绝非 plain JSON metadata", () => {
    expect(() => createWriteCommandFingerprint(scope, command({ when: new Date(0) }))).toThrow(/plain JSON/);
  });

  test("receipt 严格校验 fingerprint、durable result shape 和 owner identity", () => {
    const identity = createWriteIdempotencyIdentity(scope, "write-1");
    const fingerprint = createWriteCommandFingerprint(scope, command());
    const receipt = createMemoryWriteReceipt(identity, fingerprint, {
      status: "persisted",
      route: "active",
      memoryId: "memory-1",
    });

    expect(validateMemoryWriteReceipt(receipt, identity)).toEqual(receipt);
    expect(() => createMemoryWriteReceipt(identity, "not-sha256", receipt.result)).toThrow(/fingerprint/);
    expect(() => createMemoryWriteReceipt(identity, fingerprint, {
      status: "persisted",
      route: "drop",
      memoryId: "memory-1",
    } as never)).toThrow(/durable result shape/);
    expect(() => validateMemoryWriteReceipt(receipt, createWriteIdempotencyIdentity(
      { ...scope, tenantId: "tenant-b" },
      "write-1",
    ))).toThrow(/identity mismatch/);
  });
});

describe("PostgresAtomicMemoryStorePort", () => {
  test("record、audit、outbox、receipt 使用同一 dedicated client transaction", async () => {
    const client = new AtomicWriteClient();
    const insert = vi.fn(async (receivedClient: PostgresMemoryWriteClient, item: MemoryRecord) => {
      expect(receivedClient).toBe(client);
      return { requestedId: item.id, persistedId: item.id, stored: true };
    });
    const port = new PostgresAtomicMemoryStorePort(
      { connect: async () => client },
      insert,
      () => 2_000,
    );

    await expect(port.store(record())).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      stored: true,
    });

    expect(isProviderOwnedAtomicMemoryStorePort(port)).toBe(true);
    expect(isProviderOwnedAtomicMemoryStorePort({ store: port.store.bind(port) })).toBe(false);
    expect(insert).toHaveBeenCalledTimes(1);
    const sql = client.calls.map((call) => call.sql);
    expect(sql[0]).toBe("BEGIN");
    expect(sql.some((item) => /INSERT INTO mengshu_write_audit/.test(item))).toBe(true);
    expect(sql.some((item) => /INSERT INTO mengshu_write_outbox/.test(item))).toBe(true);
    expect(sql.some((item) => /INSERT INTO mengshu_write_receipts/.test(item))).toBe(true);
    expect(sql.at(-1)).toBe("COMMIT");
    const audit = client.calls.find((call) => /INSERT INTO mengshu_write_audit/.test(call.sql));
    expect(audit?.sql).toContain("'memory.store'");
    const outbox = client.calls.find((call) => /INSERT INTO mengshu_write_outbox/.test(call.sql));
    expect(outbox?.params.slice(3, 12)).toEqual([
      "tenant-a", "user-a", "project-a", "codex", "agent-a", "memories",
      "private", "workspace-a", "session-a",
    ]);
    expect(client.releaseCount).toBe(1);
  });

  test("audit 失败会回滚 record，且 receipt/outbox/commit 都不可见", async () => {
    const client = new AtomicWriteClient();
    client.failSql = /INSERT INTO mengshu_write_audit/;
    const insert = vi.fn(async (_client: PostgresMemoryWriteClient, item: MemoryRecord) => ({
      requestedId: item.id,
      persistedId: item.id,
      stored: true,
    }));
    const port = new PostgresAtomicMemoryStorePort({ connect: async () => client }, insert);

    await expect(port.store(record())).rejects.toThrow("forced atomic write failure");

    const sql = client.calls.map((call) => call.sql);
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(sql.some((item) => /INSERT INTO mengshu_write_outbox/.test(item))).toBe(false);
    expect(sql.some((item) => /INSERT INTO mengshu_write_receipts/.test(item))).toBe(false);
    expect(sql).not.toContain("COMMIT");
    expect(client.releaseCount).toBe(1);
  });

  test("authority duplicate 只提交 receipt，不伪造 memory.store audit/outbox", async () => {
    const client = new AtomicWriteClient();
    const insert = vi.fn(async (_client: PostgresMemoryWriteClient, item: MemoryRecord) => ({
      requestedId: item.id,
      persistedId: "22222222-2222-4222-8222-222222222222",
      stored: false,
    }));
    const port = new PostgresAtomicMemoryStorePort({ connect: async () => client }, insert);

    await expect(port.store(record())).resolves.toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      stored: false,
    });
    const sql = client.calls.map((call) => call.sql);
    expect(sql.some((item) => /INSERT INTO mengshu_write_audit/.test(item))).toBe(false);
    expect(sql.some((item) => /INSERT INTO mengshu_write_outbox/.test(item))).toBe(false);
    expect(sql.some((item) => /INSERT INTO mengshu_write_receipts/.test(item))).toBe(true);
  });

  test("commit 后 PoolClient release 失败返回 durable cleanup receipt，不伪装写入失败", async () => {
    const client = new AtomicWriteClient();
    client.failRelease = true;
    const port = new PostgresAtomicMemoryStorePort(
      { connect: async () => client },
      async (_client, item) => ({
        requestedId: item.id,
        persistedId: item.id,
        stored: true,
      }),
    );

    await expect(port.store(record())).resolves.toEqual({
      id: record().id,
      stored: true,
      cleanupFailed: true,
    });
    expect(client.calls.map((call) => call.sql).at(-1)).toBe("COMMIT");
  });

  test("receipt replay 在 insert 前返回，并校验 fingerprint", async () => {
    const firstClient = new AtomicWriteClient();
    const firstInsert = vi.fn(async (_client: PostgresMemoryWriteClient, item: MemoryRecord) => ({
      requestedId: item.id,
      persistedId: item.id,
      stored: true,
    }));
    const firstPort = new PostgresAtomicMemoryStorePort({ connect: async () => firstClient }, firstInsert);
    await firstPort.store(record());
    const saved = firstClient.calls.find((call) => /INSERT INTO mengshu_write_receipts/.test(call.sql));
    expect(saved).toBeDefined();

    const replayClient = new AtomicWriteClient();
    replayClient.receiptRows = [{
      storage_key: saved!.params[0],
      tenant_id: saved!.params[1],
      user_id: saved!.params[2],
      request_fingerprint: saved!.params[3],
      result: JSON.parse(String(saved!.params[4])),
    }];
    const replayInsert = vi.fn();
    const replayPort = new PostgresAtomicMemoryStorePort(
      { connect: async () => replayClient },
      replayInsert,
    );

    await expect(replayPort.store(record({ vector: [9, 9] }))).resolves.toEqual({
      id: record().id,
      stored: true,
    });
    expect(replayInsert).not.toHaveBeenCalled();
    expect(replayClient.calls.map((call) => call.sql).at(-1)).toBe("COMMIT");

    replayClient.receiptRows[0] = {
      ...replayClient.receiptRows[0],
      request_fingerprint: "f".repeat(64),
    };
    await expect(replayPort.store(record())).rejects.toThrow(/idempotency conflict/);
    expect(replayClient.calls.map((call) => call.sql).at(-1)).toBe("ROLLBACK");
  });
});
