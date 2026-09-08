import { describe, expect, test, vi } from "vitest";
import type {
  MemoryWriteReceipt,
  WriteIdempotencyIdentity,
} from "./write-kernel-transaction.js";
import {
  PostgresMemoryWriteKernelTransactionError,
  PostgresMemoryWriteKernelTransactionPort,
  isProviderOwnedMemoryWriteKernelTransactionPort,
  getPostgresMemoryWriteKernelFailureDiagnostic,
  type PostgresMemoryWriteKernelClient,
} from "./write-kernel-postgres-transaction.js";
import type {
  MemoryWriteTransactionContext,
  WriteMemoryRecord,
} from "./write-kernel.js";

const identity: WriteIdempotencyIdentity = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  clientKey: "request-a",
  storageKey: "a".repeat(64),
});

const scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private" as const,
});

const content: WriteMemoryRecord = {
  id: "memory-a",
  commandType: "saveExplicit",
  mutation: "content",
  scope,
  text: "Remember the production transaction contract.",
  metadata: {},
  vector: [0.1, 0.2],
  route: "active",
  valueScore: 0.9,
  kind: "preference",
  provenance: { source: "user" },
  evidenceIds: [],
  governance: { candidate: {} },
  createdAt: 1_000,
};

function receipt(overrides: Partial<MemoryWriteReceipt> = {}): MemoryWriteReceipt {
  return {
    identity,
    requestFingerprint: "b".repeat(64),
    result: {
      status: "persisted",
      route: "active",
      memoryId: "memory-a",
      stored: true,
    },
    ...overrides,
  };
}

function normalizedReceipt(overrides: Partial<MemoryWriteReceipt> = {}): MemoryWriteReceipt {
  const current = receipt(overrides);
  return {
    ...current,
    result: { ...current.result, recordType: "memory" } as MemoryWriteReceipt["result"],
  };
}

class Client implements PostgresMemoryWriteKernelClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  receiptRows: Record<string, unknown>[] = [];
  candidateReceiptRows: Record<string, unknown>[] = [];
  failSql?: RegExp;
  failRelease = false;
  releaseCount = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (this.failSql?.test(sql)) throw new Error("forced database failure with secret payload");
    if (/FROM mengshu_candidate_write_receipts/.test(sql)) {
      return { rows: this.candidateReceiptRows as Row[], rowCount: this.candidateReceiptRows.length };
    }
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

function harness(client = new Client()) {
  const mutate = vi.fn(async (
    _client: PostgresMemoryWriteKernelClient,
    memory: WriteMemoryRecord,
  ) => ({ memoryId: memory.id, stored: true }));
  const port = new PostgresMemoryWriteKernelTransactionPort(
    { connect: async () => client },
    mutate,
  );
  return { client, mutate, port };
}

describe("host-only transaction diagnostics", () => {
  test.each(["42P18", "secret-provider-code", "23505 body", "abcde"])("bounds mutation SQLSTATE %s without error payloads", async code => {
    const client = new Client();
    const port = new PostgresMemoryWriteKernelTransactionPort({ connect: async () => client }, async () => {
      throw Object.assign(new Error("secret body and connection config"), { code, detail: "secret detail" });
    });
    const error = await port.transaction(commitContent).catch((failure: unknown) => failure);
    const diagnostic = getPostgresMemoryWriteKernelFailureDiagnostic(error);
    expect(diagnostic).toEqual({ phase: "mutation", code: "TRANSACTION_FAILED", ...(code === "42P18" ? { sqlState: code } : {}) });
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  test("retains the exact stage for an unmodified private contract error", async () => {
    const { port } = harness();
    const error = await port.transaction(tx => tx.writeMemory(content)).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(error)).toEqual({ phase: "mutation", code: "TRANSACTION_CONTRACT" });
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(new Error("forged error"))).toBeUndefined();
  });

  test("connect failure keeps only the SQLSTATE in the host diagnostic", async () => {
    const port = new PostgresMemoryWriteKernelTransactionPort({ connect: async () => {
      throw Object.assign(new Error("secret connect config"), { code: "53300" });
    } }, async () => ({ memoryId: "memory", stored: true }));
    const error = await port.transaction(commitContent).catch((failure: unknown) => failure);
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(error)).toEqual({ phase: "connect", code: "CONNECTION_FAILED", sqlState: "53300" });
    expect(String(error)).toBe("Error: Postgres memory write kernel connection failed");
  });

  test.each([
    ["begin", /^BEGIN$/], ["receipt_read", /FROM mengshu_write_receipts/],
    ["audit", /INSERT INTO mengshu_write_audit/], ["outbox", /INSERT INTO mengshu_write_outbox/],
    ["receipt_write", /INSERT INTO mengshu_write_receipts/], ["commit", /^COMMIT$/],
  ] as const)("retains bounded SQLSTATE and phase at %s", async (phase, failSql) => {
    const client = new Client(), query = client.query.bind(client);
    client.query = async (sql, params) => {
      if (failSql.test(sql)) throw Object.assign(new Error("private query/body/config"), { code: "57014" });
      return query(sql, params);
    };
    const { port } = harness(client);
    const error = await port.transaction(commitContent).catch((failure: unknown) => failure);
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(error)).toEqual({ phase, code: "TRANSACTION_FAILED", sqlState: "57014" });
    expect(client.releaseCount).toBe(1);
  });

  test("an error code accessor cannot replace the transaction failure", async () => {
    const client = new Client();
    const port = new PostgresMemoryWriteKernelTransactionPort({ connect: async () => client }, async () => {
      throw Object.defineProperty(new Error("private body"), "code", { get: () => { throw new Error("private getter"); } });
    });
    const error = await port.transaction(commitContent).catch((failure: unknown) => failure);
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(error)).toEqual({ phase: "mutation", code: "TRANSACTION_FAILED" });
    expect(String(error)).not.toContain("private");
  });
});

async function commitContent(
  context: MemoryWriteTransactionContext,
  durableReceipt = receipt(),
): Promise<MemoryWriteReceipt> {
  expect(await context.getReceipt(identity)).toBeUndefined();
  const mutation = await context.writeMemory(content);
  await context.appendAudit({
    action: "memory.write",
    memoryId: mutation.memoryId,
    requestFingerprint: durableReceipt.requestFingerprint,
    commandType: "saveExplicit",
    scope,
    route: "active",
    at: 1_000,
  });
  await context.appendOutbox({
    topic: "memory.written",
    memoryId: mutation.memoryId,
    requestFingerprint: durableReceipt.requestFingerprint,
    commandType: "saveExplicit",
    scope,
    at: 1_000,
  });
  await context.saveReceipt(durableReceipt);
  return durableReceipt;
}

describe("PostgresMemoryWriteKernelTransactionPort", () => {
  test("provider hooks share the canonical client and complete before COMMIT", async () => {
    const client = new Client();
    const afterBegin = vi.fn(async (c: PostgresMemoryWriteKernelClient) => {
      expect(c).toBe(client);
      await c.query("/* evolution transaction limits */ SELECT 1");
    });
    const beforeMutation = vi.fn(async (c: PostgresMemoryWriteKernelClient) => {
      expect(c).toBe(client);
      await c.query("/* evolution guard */ SELECT 1");
    });
    const afterReceipt = vi.fn(async (c: PostgresMemoryWriteKernelClient) => {
      expect(c).toBe(client);
      await c.query("/* evolution receipt */ SELECT 1");
    });
    const port = new PostgresMemoryWriteKernelTransactionPort({ connect: async () => client },
      async () => ({ memoryId: content.id, stored: true }), { afterBegin, beforeMutation, afterReceipt });
    await port.transaction(commitContent);
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(afterBegin).toHaveBeenCalledTimes(1);
    expect(client.calls[1]?.sql).toContain("evolution transaction limits");
    expect(afterReceipt).toHaveBeenCalledTimes(1);
    expect(client.calls.at(-2)?.sql).toContain("evolution receipt");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });
  test("failed evolution receipt hook rolls back canonical, audit and kernel receipt", async () => {
    const client = new Client();
    const port = new PostgresMemoryWriteKernelTransactionPort({ connect: async () => client },
      async () => ({ memoryId: content.id, stored: true }), {
        afterReceipt: async () => { throw new Error("fencing lost"); },
      });
    await expect(port.transaction(commitContent)).rejects.toThrow();
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
  });
  test("brands only provider-owned transaction ports", () => {
    const { port } = harness();
    expect(isProviderOwnedMemoryWriteKernelTransactionPort(port)).toBe(true);
    expect(isProviderOwnedMemoryWriteKernelTransactionPort({
      transaction: async () => undefined,
    })).toBe(false);
  });

  test("commits mutation, audit, outbox and kernel receipt on one client", async () => {
    const { client, mutate, port } = harness();

    await expect(port.transaction(commitContent)).resolves.toEqual(receipt());

    expect(mutate).toHaveBeenCalledWith(client, content);
    expect(client.releaseCount).toBe(1);
    const sql = client.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("pg_advisory_xact_lock");
    expect(sql[2]).toContain("FROM mengshu_write_receipts");
    expect(sql[3]).toContain("FROM mengshu_candidate_write_receipts");
    expect(sql[4]).toContain("INSERT INTO mengshu_write_audit");
    expect(sql[5]).toContain("INSERT INTO mengshu_write_outbox");
    expect(sql[6]).toContain("INSERT INTO mengshu_write_receipts");
    expect(sql[7]).toBe("COMMIT");
    expect(JSON.parse(String(client.calls[6]?.params[4]))).toEqual(normalizedReceipt().result);
  });

  test("candidate route writes only the candidate journal and receipt", async () => {
    const { client, port } = harness();
    const candidate = { ...content, id: "candidate-a", route: "candidate" as const };
    const durableReceipt = receipt({
      result: {
        status: "persisted",
        route: "candidate",
        recordType: "candidate",
        candidateId: "candidate-a",
        memoryId: "candidate-a",
        stored: true,
      },
    });

    await port.transaction(async (context) => {
      expect(await context.getReceipt(identity)).toBeUndefined();
      const mutation = await context.writeMemory(candidate);
      await context.appendAudit({
        action: "candidate.write",
        recordType: "candidate",
        memoryId: mutation.memoryId,
        requestFingerprint: durableReceipt.requestFingerprint,
        commandType: "saveExplicit",
        scope,
        route: "candidate",
        at: 1_000,
      });
      await context.appendOutbox({
        topic: "candidate.written",
        recordType: "candidate",
        memoryId: mutation.memoryId,
        requestFingerprint: durableReceipt.requestFingerprint,
        commandType: "saveExplicit",
        scope,
        at: 1_000,
      });
      await context.saveReceipt(durableReceipt);
    });

    const sql = client.calls.map((call) => call.sql.replace(/\s+/g, " ").trim());
    expect(sql).toEqual(expect.arrayContaining([
      expect.stringContaining("INSERT INTO mengshu_candidate_write_audit"),
      expect.stringContaining("INSERT INTO mengshu_candidate_write_outbox"),
      expect.stringContaining("INSERT INTO mengshu_candidate_write_receipts"),
    ]));
    expect(sql.some((value) => /INSERT INTO mengshu_write_(audit|outbox|receipts)/.test(value)))
      .toBe(false);
  });

  test("lookup/evidence routes stay on the memory journal", async () => {
    for (const route of ["lookup_only", "evidence_only"] as const) {
      const { client, port } = harness();
      const governed = { ...content, route };
      const durableReceipt = receipt({
        result: {
          status: "persisted",
          route,
          recordType: "memory",
          memoryId: "memory-a",
          stored: true,
        },
      });
      await port.transaction(async (context) => {
        await context.getReceipt(identity);
        const mutation = await context.writeMemory(governed);
        await context.appendAudit({
          action: "memory.write", recordType: "memory", memoryId: mutation.memoryId,
          requestFingerprint: durableReceipt.requestFingerprint,
          commandType: "saveExplicit", scope, route, at: 1_000,
        });
        await context.appendOutbox({
          topic: "memory.written", recordType: "memory", memoryId: mutation.memoryId,
          requestFingerprint: durableReceipt.requestFingerprint,
          commandType: "saveExplicit", scope, at: 1_000,
        });
        await context.saveReceipt(durableReceipt);
      });
      const sql = client.calls.map((call) => call.sql);
      expect(sql.some((value) => value.includes("INSERT INTO mengshu_write_receipts"))).toBe(true);
      expect(sql.some((value) => value.includes("INSERT INTO mengshu_candidate_write"))).toBe(false);
    }
  });

  test("strictly decodes a committed kernel receipt for replay", async () => {
    const { client, mutate, port } = harness();
    client.receiptRows = [{
      storage_key: identity.storageKey,
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      request_fingerprint: "b".repeat(64),
      result: receipt().result,
    }];

    const replayed = await port.transaction(async (context) => context.getReceipt(identity));

    expect(replayed).toEqual(normalizedReceipt());
    expect(mutate).not.toHaveBeenCalled();
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("strictly decodes a committed candidate receipt for replay", async () => {
    const { client, mutate, port } = harness();
    const candidateResult = {
      status: "persisted" as const,
      route: "candidate" as const,
      recordType: "candidate" as const,
      candidateId: "candidate-a",
      memoryId: "candidate-a",
      stored: true,
    };
    client.candidateReceiptRows = [{
      storage_key: identity.storageKey,
      request_fingerprint: "b".repeat(64),
      candidate_id: "candidate-a",
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      app_id: scope.appId,
      project_id: scope.projectId,
      agent_id: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
      workspace_id: "",
      session_id: "",
      route: "candidate",
      result: candidateResult,
    }];

    await expect(port.transaction((context) => context.getReceipt(identity)))
      .resolves.toEqual(receipt({ result: candidateResult }));
    expect(mutate).not.toHaveBeenCalled();
  });

  test("fails closed when the same idempotency key exists in both receipt journals", async () => {
    const { client, port } = harness();
    client.receiptRows = [{
      storage_key: identity.storageKey,
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      request_fingerprint: "b".repeat(64),
      result: receipt().result,
    }];
    client.candidateReceiptRows = [{
      storage_key: identity.storageKey,
      request_fingerprint: "b".repeat(64),
      candidate_id: "candidate-a",
      tenant_id: identity.tenantId,
      user_id: identity.userId,
      app_id: scope.appId,
      project_id: scope.projectId,
      agent_id: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
      workspace_id: "",
      session_id: "",
      route: "candidate",
      result: {
        status: "persisted", route: "candidate", recordType: "candidate",
        candidateId: "candidate-a", memoryId: "candidate-a", stored: true,
      },
    }];

    await expect(port.transaction((context) => context.getReceipt(identity)))
      .rejects.toThrow(/both receipt journals/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("rejects a malformed or cross-owner receipt and rolls back", async () => {
    const { client, port } = harness();
    client.receiptRows = [{
      storage_key: identity.storageKey,
      tenant_id: "tenant-b",
      user_id: identity.userId,
      request_fingerprint: "b".repeat(64),
      result: receipt().result,
    }];

    await expect(port.transaction(async (context) => context.getReceipt(identity)))
      .rejects.toThrow("receipt row is invalid");
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
  });

  test("binds a callback transaction to one idempotency identity", async () => {
    const { client, port } = harness();
    const other = { ...identity, clientKey: "request-b", storageKey: "c".repeat(64) };

    await expect(port.transaction(async (context) => {
      await context.getReceipt(identity);
      return context.getReceipt(other);
    })).rejects.toThrow("identity conflict");
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("fails closed before a mutation when receipt lock was not acquired", async () => {
    const { client, mutate, port } = harness();

    await expect(port.transaction((context) => context.writeMemory(content)))
      .rejects.toThrow("receipt identity must be locked");
    expect(mutate).not.toHaveBeenCalled();
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("v11 journal rejects lifecycle events and rolls the mutation back", async () => {
    const { client, port } = harness();
    const lifecycle: WriteMemoryRecord = {
      id: "memory-a",
      commandType: "correctMemory",
      mutation: "lifecycle",
      targetId: "memory-a",
      lifecycleAction: "archive",
      scope,
      metadata: {},
      createdAt: 1_000,
    };

    await expect(port.transaction(async (context) => {
      await context.getReceipt(identity);
      await context.writeMemory(lifecycle);
      await context.appendAudit({
        action: "memory.write",
        memoryId: "memory-a",
        requestFingerprint: "b".repeat(64),
        commandType: "correctMemory",
        correctionKind: "archive",
        scope,
        at: 1_000,
      });
    })).rejects.toThrow("forget transaction");
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("rolls back database failures without exposing the provider payload", async () => {
    const { client, port } = harness();
    client.failSql = /INSERT INTO mengshu_write_outbox/;

    const failure = await port.transaction(commitContent).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PostgresMemoryWriteKernelTransactionError);
    expect(failure).toMatchObject({
      name: "PostgresMemoryWriteKernelTransactionError",
      code: "MEMORY_WRITE_TX_OUTBOX_FAILED",
      message: "Postgres memory write kernel transaction failed at outbox",
    });
    expect(String(failure)).not.toContain("secret payload");
    expect(client.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
  });

  test("mutation PostgreSQL SQLSTATE is exposed only as a sanitized stage code", async () => {
    const client = new Client();
    const databaseFailure = Object.assign(new Error("provider response contains secret"), {
      code: "42P18",
    });
    const port = new PostgresMemoryWriteKernelTransactionPort(
      { connect: async () => client },
      vi.fn(async () => { throw databaseFailure; }),
    );

    const failure = await port.transaction(commitContent).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "MEMORY_WRITE_TX_MUTATION_FAILED_42P18",
      message: "Postgres memory write kernel transaction failed at mutation",
    });
    expect(String(failure)).not.toContain("provider response");
  });

  test("commit and rollback failures have a stable sanitized classification", async () => {
    const { client, port } = harness();
    client.failSql = /COMMIT|ROLLBACK/;

    const failure = await port.transaction(commitContent).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "MEMORY_WRITE_TX_ROLLBACK_FAILED",
      message: "Postgres memory write kernel transaction and rollback failed",
    });
    expect(String(failure)).not.toContain("secret payload");
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(failure)).toEqual({ phase: "rollback", code: "ROLLBACK_FAILED" });
  });

  test("surfaces post-commit release failure so replay can recover from the receipt", async () => {
    const { client, port } = harness();
    client.failRelease = true;

    const failure = await port.transaction(commitContent).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("committed but connection cleanup failed");
    expect(getPostgresMemoryWriteKernelFailureDiagnostic(failure)).toEqual({ phase: "cleanup", code: "CLEANUP_FAILED" });
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.releaseCount).toBe(1);
  });
});
