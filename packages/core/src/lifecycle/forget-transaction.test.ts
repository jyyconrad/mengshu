import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import type {
  AuthorityScopedForgetReceipt,
  AuthorityScopedForgetResult,
  ForgetAuditEvent,
  ForgetOutboxEvent,
  ForgetTransactionContext,
  ForgetTransactionPort,
  ForgetTargetSelection,
} from "../domain/service-types.js";
import {
  AuthorityScopedForgetError,
  executeAuthorityScopedForget,
} from "./forget-transaction.js";

const ownedScope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private",
};

const authority = {
  tenantId: "tenant-a",
  userId: "user-a",
  allow: {
    appIds: ["codex"],
    projectIds: ["project-a"],
    agentIds: ["agent-a"],
    namespaces: ["memories"],
    visibilities: ["private" as const],
  },
};

const clientScope = {
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private" as const,
};

function record(id: string, scope: MemoryScope = ownedScope): MemoryRecord {
  return {
    id,
    scope,
    kind: "fact",
    text: `memory ${id}`,
    contentHash: `hash-${id}`,
    importance: 0.7,
    category: "other",
    dataType: "memory",
    tableName: "memories",
    metadata: {},
    provenance: { source: "test", createdAt: 1 },
    lifecycleStatus: "active",
    createdAt: 1,
  };
}

interface TransactionState {
  records: Map<string, MemoryRecord>;
  audits: ForgetAuditEvent[];
  outbox: ForgetOutboxEvent[];
  receipts: Map<string, AuthorityScopedForgetReceipt>;
}

class FakeForgetTransactionPort implements ForgetTransactionPort {
  state: TransactionState;
  selections: ForgetTargetSelection[] = [];
  transactions = 0;

  constructor(
    records: MemoryRecord[],
    private readonly failAt?: "replace" | "delete" | "audit" | "outbox" | "receipt",
  ) {
    this.state = {
      records: new Map(records.map((item) => [item.id, structuredClone(item)])),
      audits: [],
      outbox: [],
      receipts: new Map(),
    };
  }

  async transaction<T>(work: (transaction: ForgetTransactionContext) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const working = structuredClone(this.state);
    const context: ForgetTransactionContext = {
      findTargets: async (selection) => {
        this.selections.push(selection);
        if (selection.kind === "ids") {
          return selection.filters
            .map((filter) => working.records.get(String(filter.filter.id)))
            .filter((item): item is MemoryRecord => Boolean(item));
        }
        return Array.from(working.records.values()).filter((item) => {
          const filter = selection.filter.filter;
          return (
            item.scope.tenantId === filter.tenantId &&
            item.scope.userId === filter.userId &&
            item.scope.appId === filter.appId &&
            item.scope.projectId === filter.projectId &&
            item.scope.agentId === filter.agentId &&
            item.scope.namespace === filter.namespace &&
            item.scope.visibility === filter.visibility &&
            (filter.category === undefined || item.category === filter.category)
          );
        });
      },
      replace: async (recordsToReplace) => {
        for (const item of recordsToReplace) working.records.set(item.id, structuredClone(item));
        if (this.failAt === "replace") throw new Error("replace failure");
      },
      delete: async (ids) => {
        for (const id of ids) working.records.delete(id);
        if (this.failAt === "delete") throw new Error("delete failure");
      },
      appendAudit: async (events) => {
        working.audits.push(...structuredClone(events));
        if (this.failAt === "audit") throw new Error("audit failure");
      },
      appendOutbox: async (events) => {
        working.outbox.push(...structuredClone(events));
        if (this.failAt === "outbox") throw new Error("outbox failure");
      },
      getReceipt: async (scope, idempotencyKey) =>
        working.receipts.get(`${scope.tenantId}\0${scope.userId}\0${idempotencyKey}`),
      saveReceipt: async (receipt) => {
        working.receipts.set(
          `${receipt.scope.tenantId}\0${receipt.scope.userId}\0${receipt.idempotencyKey}`,
          structuredClone(receipt),
        );
        if (this.failAt === "receipt") throw new Error("receipt failure");
      },
    };
    const result = await work(context);
    this.state = working;
    return result;
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    serverAuthority: authority,
    clientScope,
    action: "revoke" as const,
    ids: ["owned"],
    idempotencyKey: "forget-request-1",
    actor: "user-a",
    reason: "incorrect memory",
    now: 2_000,
    ...overrides,
  };
}

describe("executeAuthorityScopedForget", () => {
  test("按 ID 查询后发现任一记录跨 tenant/user 时整批拒绝且零写入", async () => {
    const foreign = record("foreign", {
      ...ownedScope,
      tenantId: "tenant-b",
      userId: "user-b",
    });
    const port = new FakeForgetTransactionPort([record("owned"), foreign]);

    await expect(
      executeAuthorityScopedForget(port, input({ ids: ["owned", "foreign"] })),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND_OR_FORBIDDEN" });

    expect(port.state.records.get("owned")?.lifecycleStatus).toBe("active");
    expect(port.state.records.get("foreign")?.lifecycleStatus).toBe("active");
    expect(port.state.audits).toEqual([]);
    expect(port.state.outbox).toEqual([]);
    expect(port.state.receipts.size).toBe(0);
  });

  test("filter 不透传 raw authority，并强制合并 server-owned scope", async () => {
    const port = new FakeForgetTransactionPort([record("owned")]);

    await expect(
      executeAuthorityScopedForget(
        port,
        input({ ids: undefined, filter: { tenantId: "tenant-b", category: "other" } }),
      ),
    ).rejects.toMatchObject({ code: "FILTER_KEY_NOT_ALLOWED" });
    expect(port.transactions).toBe(0);

    const result = await executeAuthorityScopedForget(
      port,
      input({
        ids: undefined,
        filter: { category: "other" },
        action: "delete",
        idempotencyKey: "forget-filter-1",
      }),
    );

    expect(result).toMatchObject({ affected: 1, transactional: true });
    expect(port.selections.at(-1)).toMatchObject({
      kind: "filter",
      filter: {
        operation: "delete",
        filter: {
          tenantId: "tenant-a",
          userId: "user-a",
          appId: "codex",
          projectId: "project-a",
          agentId: "agent-a",
          namespace: "memories",
          visibility: "private",
          category: "other",
        },
      },
    });
  });

  test("clientScope 携带 tenantId/userId 时由 AuthorityScope fail-closed", async () => {
    const port = new FakeForgetTransactionPort([record("owned")]);

    await expect(
      executeAuthorityScopedForget(
        port,
        input({ clientScope: { ...clientScope, tenantId: "tenant-b", userId: "user-b" } }),
      ),
    ).rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN" });
    expect(port.transactions).toBe(0);
  });

  test.each([
    ["ids/filter 同时出现", { filter: { category: "other" } }, "INVALID_REQUEST"],
    ["ids/filter 均缺失", { ids: undefined }, "INVALID_REQUEST"],
    ["重复 ids", { ids: ["owned", "owned"] }, "INVALID_REQUEST"],
    ["空 filter", { ids: undefined, filter: {} }, "INVALID_REQUEST"],
    ["filter scope 与 clientScope 冲突", { ids: undefined, filter: { projectId: "project-b" } }, "TARGET_NOT_FOUND_OR_FORBIDDEN"],
    ["非法 action", { action: "purge" }, "INVALID_REQUEST"],
    ["非法 idempotency key", { idempotencyKey: "bad key" }, "IDEMPOTENCY_REQUIRED"],
    ["非法 timestamp", { now: -1 }, "INVALID_REQUEST"],
  ])("%s 在事务开始前拒绝", async (_name, overrides, code) => {
    const port = new FakeForgetTransactionPort([record("owned")]);

    await expect(
      executeAuthorityScopedForget(port, input(overrides)),
    ).rejects.toMatchObject({ code });
    expect(port.transactions).toBe(0);
  });

  test.each([
    ["replace", "revoke"],
    ["delete", "delete"],
    ["audit", "revoke"],
    ["outbox", "revoke"],
    ["receipt", "revoke"],
  ] as const)(
    "%s 故障会回滚记录、audit、outbox 和 receipt",
    async (failAt, action) => {
      const port = new FakeForgetTransactionPort([record("owned")], failAt);

      await expect(
        executeAuthorityScopedForget(port, input({ action })),
      ).rejects.toThrow(`${failAt} failure`);

      expect(port.state.records.get("owned")?.lifecycleStatus).toBe("active");
      expect(port.state.records.get("owned")?.metadata.forgetLog).toBeUndefined();
      expect(port.state.audits).toEqual([]);
      expect(port.state.outbox).toEqual([]);
      expect(port.state.receipts.size).toBe(0);
    },
  );

  test("幂等重试返回 receipt，不重复记录变更、audit 或 outbox", async () => {
    const port = new FakeForgetTransactionPort([record("owned")]);

    const first = await executeAuthorityScopedForget(port, input());
    const second = await executeAuthorityScopedForget(port, input());

    expect(first).toMatchObject({ affected: 1, idempotentReplay: false, transactional: true });
    expect(second).toMatchObject({ affected: 1, idempotentReplay: true, transactional: true });
    expect(port.state.audits).toHaveLength(1);
    expect(port.state.outbox).toHaveLength(1);
    expect(port.state.records.get("owned")?.metadata.forgetLog).toHaveLength(1);
    expect(port.state.receipts.size).toBe(1);
  });

  test("同一幂等键用于不同请求时 fail-closed", async () => {
    const port = new FakeForgetTransactionPort([record("owned")]);
    await executeAuthorityScopedForget(port, input());

    await expect(
      executeAuthorityScopedForget(port, input({ action: "archive" })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("revoke 保持 lifecycle 与 forgetLog 兼容合同并产生无正文 outbox", async () => {
    const port = new FakeForgetTransactionPort([record("owned")]);

    const result: AuthorityScopedForgetResult = await executeAuthorityScopedForget(port, input());
    const updated = port.state.records.get("owned");

    expect(result.affectedIds).toEqual(["owned"]);
    expect(updated).toMatchObject({ lifecycleStatus: "revoked" });
    expect(updated?.metadata.lifecycleStatus).toBe("revoked");
    expect(updated?.metadata.forgetLog).toEqual([
      expect.objectContaining({ action: "revoke", actor: "user-a", at: 2_000 }),
    ]);
    expect(port.state.outbox[0]).not.toHaveProperty("text");
  });

  test("archive 已归档记录是幂等 no-op，但仍保存请求 receipt", async () => {
    const archived = record("owned");
    archived.lifecycleStatus = "archived";
    archived.metadata.lifecycleStatus = "archived";
    const port = new FakeForgetTransactionPort([archived]);

    const result = await executeAuthorityScopedForget(port, input({ action: "archive" }));

    expect(result).toMatchObject({ affected: 0, deleted: 0, transactional: true });
    expect(port.state.audits).toEqual([]);
    expect(port.state.outbox).toEqual([]);
    expect(port.state.receipts.size).toBe(1);
  });

  test("无 transaction port 时显式拒绝，不能伪造 transactional=true", async () => {
    await expect(executeAuthorityScopedForget(undefined, input())).rejects.toEqual(
      expect.objectContaining<Partial<AuthorityScopedForgetError>>({
        code: "TRANSACTION_UNAVAILABLE",
      }),
    );
  });
});
