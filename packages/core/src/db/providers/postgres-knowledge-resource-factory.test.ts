import { describe, expect, test, vi } from "vitest";

import { KnowledgeResourceCapability } from "../../resources/knowledge-resource-capability.js";
import { PostgresProvider } from "./postgres.js";

const config = {
  host: "unused",
  port: 5432,
  database: "unused",
  user: "unused",
  password: "unused",
};
const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
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

describe("Postgres Knowledge resource capability factory", () => {
  test("mints a provider-owned read capability and requires canonical scope schema", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const capability = providerWithPool(pool, 2).createKnowledgeResourceCapability();

    expect(capability).toBeInstanceOf(KnowledgeResourceCapability);
    await expect(capability.index(scope)).resolves.toEqual({ resources: [], warnings: [] });
    expect(pool.query).toHaveBeenCalledOnce();

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const stale = providerWithPool(stalePool, 1).createKnowledgeResourceCapability();
    await expect(stale.index(scope)).resolves.toEqual({
      resources: [],
      warnings: ["knowledge_resource_unavailable"],
    });
    expect(stalePool.query).not.toHaveBeenCalled();
  });
});
