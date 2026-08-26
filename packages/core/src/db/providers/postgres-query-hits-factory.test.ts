import { describe, expect, test, vi } from "vitest";

import {
  assertPostgresProviderOwnsEntityGraphQueryHits,
  assertProviderOwnedPostgresEntityGraphQueryHits,
  PostgresProvider,
} from "./postgres.js";

const config = {
  host: "unused",
  port: 5432,
  database: "unused",
  user: "unused",
  password: "unused",
};

function providerWithPool(pool: unknown, schemaVersion: number): PostgresProvider {
  const provider = new PostgresProvider(config, "text-embedding-3-small");
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool,
    schemaVersion,
    schemaContractState: "ready",
  });
  return provider;
}

function result(rows: readonly Record<string, unknown>[] = []) {
  return { rows: [...rows], rowCount: rows.length };
}

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
};

describe("PostgresProvider Entity Graph query hits factory", () => {
  test("铸造冻结的 provider-owned port 并绑定 provider 生命周期", async () => {
    const pool = { query: vi.fn(async () => result()), connect: vi.fn(), end: vi.fn() };
    const provider = providerWithPool(pool, 15);
    const initialize = vi.spyOn(provider, "initialize");
    const port = provider.createEntityGraphQueryHitsPort();

    expect(Object.isFrozen(port)).toBe(true);
    expect(port.contract).toBe("mengshu.postgres-entity-graph-query-hits/v1");
    expect(assertProviderOwnedPostgresEntityGraphQueryHits(port)).toBe(port);
    expect(assertPostgresProviderOwnsEntityGraphQueryHits(provider, port)).toBe(port);
    expect(() => assertProviderOwnedPostgresEntityGraphQueryHits({
      contract: port.contract,
      incrementRecallHits: port.incrementRecallHits,
    })).toThrow(/provider-owned/i);
    expect(() => assertPostgresProviderOwnsEntityGraphQueryHits(
      providerWithPool(pool, 15), port,
    )).toThrow(/provider-owned/i);

    await expect(port.incrementRecallHits({
      memoryIds: ["memory-a"], scope, occurredAt: 10,
    })).resolves.toEqual({ updatedEntityIds: [] });
    expect(initialize).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });

  test("schema v15 前在 SQL 前 fail closed", async () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const port = providerWithPool(pool, 14).createEntityGraphQueryHitsPort();

    await expect(port.incrementRecallHits({
      memoryIds: ["memory-a"], scope, occurredAt: 10,
    })).rejects.toThrow(/entity graph query hits.*schema v15/i);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });
});
