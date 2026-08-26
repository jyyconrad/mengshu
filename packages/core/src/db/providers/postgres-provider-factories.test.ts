import { describe, expect, test, vi } from "vitest";

import { createMemoryWriteReceipt } from "../../service/write-kernel-transaction.js";
import {
  isProviderOwnedMemoryWriteKernelTransactionPort,
  type PostgresMemoryWriteKernelClient,
} from "../../service/write-kernel-postgres-transaction.js";
import type { WriteMemoryRecord } from "../../service/write-kernel.js";
import { PostgresProvider } from "./postgres.js";
import { PostgresCandidateDedupReadAdapter } from
  "../../lifecycle/candidate-dedup-read-port.js";
import { PostgresActiveMemoryDerivationReadPort } from
  "../../graph/postgres-active-derivation-read-port.js";
import { PostgresAuthoritativeEntityGraphReadPort } from
  "../../graph/postgres-authoritative-entity-graph-read-port.js";
import { PostgresCandidateEvidenceReadPort } from
  "../../lifecycle/postgres-candidate-evidence-read-port.js";
import { PostgresEvidenceContentReadPort } from
  "../../graph/postgres-evidence-content-read.js";
import { PostgresMemoryViewAssetRepository } from "../../assets/postgres-repository.js";
import { PostgresAgentLoadoutRepository } from "../../loadout/postgres-repository.js";
import { PostgresSlotInvalidationOutboxRepository } from
  "../../context/postgres-slot-invalidation-outbox.js";
import { PostgresContextAssemblyReceiptRepository } from
  "../../context/postgres-assembly-receipt.js";
import { PostgresActiveDerivationOutboxRepository } from
  "../../../../../server/postgres-active-derivation-outbox.js";
import { isProviderOwnedDuplicateEvidenceLinkPort } from
  "../../service/postgres-memory-evidence-link-port.js";
import {
  assertPostgresProviderOwnsGovernedRetrievalCandidateSource,
  assertPostgresProviderOwnsGovernedRetrievalHydrator,
  assertProviderOwnedPostgresGovernedRetrievalCandidateSource,
  assertProviderOwnedPostgresGovernedRetrievalHydrator,
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

describe("PostgresProvider F0 factories", () => {
  test("active derivation outbox pool reuses a dedicated provider client and requires schema v11", async () => {
    const client = {
      query: vi.fn(async (sql: string) => sql === "BEGIN" || sql === "COMMIT"
        ? result()
        : result()),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
      end: vi.fn(),
    };
    const provider = providerWithPool(pool, 11);
    const repository = new PostgresActiveDerivationOutboxRepository(
      provider.createActiveDerivationOutboxPool(),
    );

    await expect(repository.claimPending({ limit: 1 })).resolves.toEqual([]);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const stale = providerWithPool(stalePool, 10);
    await expect(new PostgresActiveDerivationOutboxRepository(
      stale.createActiveDerivationOutboxPool(),
    ).claimPending({ limit: 1 })).rejects.toThrow(/active derivation outbox.*schema v11/i);
    expect(stalePool.connect).not.toHaveBeenCalled();
  });

  test("F2/F3 asset/loadout repositories reuse provider pool and require schema v20", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const provider = providerWithPool(pool, 20);
    const scope = {
      tenantId: "tenant-a", userId: "user-a", appId: "codex",
      projectId: "project-a", agentId: "agent-a", namespace: "memory",
      visibility: "private" as const,
    };
    const assets = provider.createMemoryViewAssetRepository();
    const loadouts = provider.createAgentLoadoutRepository();

    expect(assets).toBeInstanceOf(PostgresMemoryViewAssetRepository);
    expect(loadouts).toBeInstanceOf(PostgresAgentLoadoutRepository);
    await expect(assets.getLatest(scope, "asset-a")).resolves.toBeUndefined();
    await expect(loadouts.getLatest(scope, "loadout-a")).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(2);

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const stale = providerWithPool(stalePool, 19);
    await expect(stale.createMemoryViewAssetRepository().getLatest(scope, "asset-a"))
      .rejects.toThrow(/memory view asset repository.*schema v20/i);
    await expect(stale.createAgentLoadoutRepository().getLatest(scope, "loadout-a"))
      .rejects.toThrow(/agent loadout repository.*schema v20/i);
    expect(stalePool.query).not.toHaveBeenCalled();
  });

  test("F3 invalidation outbox reuses provider pool and requires schema v21", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const provider = providerWithPool(pool, 21);
    const outbox = provider.createSlotInvalidationOutboxRepository();

    expect(outbox).toBeInstanceOf(PostgresSlotInvalidationOutboxRepository);
    await expect(outbox.readPending(10)).resolves.toEqual([]);
    expect(pool.query).toHaveBeenCalledOnce();

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const stale = providerWithPool(stalePool, 20);
    await expect(stale.createSlotInvalidationOutboxRepository().readPending(10))
      .rejects.toThrow(/slot invalidation outbox.*schema v21/i);
    expect(stalePool.query).not.toHaveBeenCalled();
  });

  test("context assembly receipt repository reuses provider pool and requires schema v22", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const scope = {
      tenantId: "tenant-a", userId: "user-a", appId: "codex",
      projectId: "project-a", agentId: "agent-a", namespace: "memory",
      visibility: "private" as const, sessionId: "session-a",
    };
    const repository = providerWithPool(pool, 22).createContextAssemblyReceiptRepository();

    expect(repository).toBeInstanceOf(PostgresContextAssemblyReceiptRepository);
    await expect(repository.getLatest(scope, "session-a")).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const stale = providerWithPool(stalePool, 21).createContextAssemblyReceiptRepository();
    await expect(stale.getLatest(scope, "session-a"))
      .rejects.toThrow(/context assembly receipt repository.*schema v22/i);
    expect(stalePool.query).not.toHaveBeenCalled();
  });

  test("F1 evidence content reader reuses provider pool and requires schema v14", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const provider = providerWithPool(pool, 14);
    const reader = provider.createEvidenceContentReadPort();
    expect(reader).toBeInstanceOf(PostgresEvidenceContentReadPort);
    await expect(reader.read({
      tenantId: "tenant-a", userId: "user-a", appId: "codex",
      projectId: "project-a", agentId: "agent-a", namespace: "memory",
      visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
    }, [{
      ref: "11111111-1111-4111-8111-111111111111",
      source: "message",
    }])).rejects.toThrow(/INCOMPLETE/);
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.connect).not.toHaveBeenCalled();

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    await expect(providerWithPool(stalePool, 13).createEvidenceContentReadPort().read({
      tenantId: "tenant-a", userId: "user-a", appId: "codex",
      projectId: "project-a", agentId: "agent-a", namespace: "memory",
      visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
    }, [{
      ref: "11111111-1111-4111-8111-111111111111",
      source: "message",
    }])).rejects.toThrow(/evidence content read.*schema v14/i);
    expect(stalePool.query).not.toHaveBeenCalled();
  });

  test("D-21 canonical tree reader requires schema v16 before any query", async () => {
    const scope = {
      tenantId: "tenant-a", userId: "user-a", appId: "codex",
      projectId: "project-a", agentId: "agent-a", namespace: "memory",
      visibility: "private" as const,
    };
    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    await expect(providerWithPool(stalePool, 15).createCanonicalTreeReadRepository(scope)
      .getLeaf("leaf-a"))
      .rejects.toThrow(/canonical tree read.*schema v16/i);
    expect(stalePool.query).not.toHaveBeenCalled();

    const readyPool = {
      query: vi.fn(async () => result()), connect: vi.fn(), end: vi.fn(),
    };
    await expect(providerWithPool(readyPool, 16).createCanonicalTreeReadRepository(scope)
      .getLeaf("leaf-a"))
      .resolves.toBeUndefined();
    expect(readyPool.query).toHaveBeenCalledOnce();
  });

  test("governed retrieval candidate source 绑定 provider、schema 与 pool 生命周期", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const provider = providerWithPool(pool, 15);
    const initialize = vi.spyOn(provider, "initialize");
    const source = provider.createGovernedRetrievalCandidateSource();
    const scope = {
      tenantId: "tenant-a", userId: "user-a", appId: "codex",
      projectId: "project-a", agentId: "agent-a", namespace: "memory",
      visibility: "private" as const,
    };

    expect(Object.isFrozen(source)).toBe(true);
    expect(source.contract).toBe("mengshu.postgres-governed-retrieval-candidate-source/v1");
    expect(assertProviderOwnedPostgresGovernedRetrievalCandidateSource(source)).toBe(source);
    expect(assertPostgresProviderOwnsGovernedRetrievalCandidateSource(provider, source)).toBe(source);
    expect(() => assertProviderOwnedPostgresGovernedRetrievalCandidateSource({
      contract: source.contract,
      search: source.search,
    })).toThrow(/provider-owned/i);
    expect(() => assertPostgresProviderOwnsGovernedRetrievalCandidateSource(
      providerWithPool(pool, 15),
      source,
    )).toThrow(/provider-owned/i);

    await expect(source.search({ query: "postgres", scope, limit: 10 })).resolves.toEqual([]);
    expect(initialize).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();

    const stalePool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    await expect(providerWithPool(stalePool, 14).createGovernedRetrievalCandidateSource()
      .search({ query: "postgres", scope, limit: 10 }))
      .rejects.toThrow(/governed retrieval candidate source.*schema v15/i);
    expect(stalePool.query).not.toHaveBeenCalled();
  });

  test("governed retrieval factory mint 冻结 branded port，并绑定当前 provider 生命周期", async () => {
    const pool = {
      query: vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result()),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const provider = providerWithPool(pool, 15);
    const initialize = vi.spyOn(provider, "initialize");
    const hydrator = provider.createGovernedRetrievalHydrator();

    expect(Object.isFrozen(hydrator)).toBe(true);
    expect(hydrator.contract).toBe("mengshu.postgres-governed-retrieval-hydrator/v1");
    expect(assertProviderOwnedPostgresGovernedRetrievalHydrator(hydrator)).toBe(hydrator);
    expect(assertPostgresProviderOwnsGovernedRetrievalHydrator(provider, hydrator)).toBe(hydrator);
    expect(() => assertProviderOwnedPostgresGovernedRetrievalHydrator({
      contract: hydrator.contract,
      hydrate: hydrator.hydrate,
    })).toThrow(/provider-owned/i);
    expect(() => assertPostgresProviderOwnsGovernedRetrievalHydrator(
      providerWithPool(pool, 15),
      hydrator,
    )).toThrow(/provider-owned/i);

    await expect(hydrator.hydrate({
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "request-project", agentId: "agent-a", namespace: "memory",
        visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
      },
      authoritativeRecordId: "memory-a",
      candidates: [{
        candidateId: "candidate-a",
        authoritativeRecordId: "memory-a",
        scope: {
          tenantId: "tenant-a", userId: "user-a", appId: "codex",
          projectId: "project-a", agentId: "agent-a", namespace: "memory",
          visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
        },
        source: "vector",
        nodeType: "memory",
        evidenceIds: ["evidence-a"],
      }],
    })).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
    expect(pool.query.mock.calls[0]?.[1]).toEqual([
      "tenant-a", "user-a", "codex", "project-a", "agent-a", "memory",
      "private", "workspace-a", "session-a", "memory-a",
    ]);
  });

  test("governed retrieval hydrator 在 schema v15 前查询前 fail-closed", async () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const hydrator = providerWithPool(pool, 14).createGovernedRetrievalHydrator();

    await expect(hydrator.hydrate({
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private",
      },
      authoritativeRecordId: "memory-a",
      candidates: [{
        candidateId: "candidate-a", authoritativeRecordId: "memory-a",
        scope: {
          tenantId: "tenant-a", userId: "user-a", appId: "codex",
          projectId: "project-a", agentId: "agent-a", namespace: "memory",
          visibility: "private",
        },
        source: "bm25", nodeType: "memory", evidenceIds: ["evidence-a"],
      }],
    })).rejects.toThrow(/governed retrieval hydration.*schema v15/i);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });

  test("duplicate evidence linker 要求 schema v15 并在 dedicated transaction 内写 ledger", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return sql.includes("RETURNING link_id")
          ? result([{ link_id: params[0] as string }])
          : result();
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => { throw new Error("pool.query must not be used"); }),
      connect: vi.fn(async () => client),
    };
    const provider = providerWithPool(pool, 15);
    const initialize = vi.spyOn(provider, "initialize");
    const port = provider.createDuplicateEvidenceLinkPort();

    expect(isProviderOwnedDuplicateEvidenceLinkPort(port)).toBe(true);
    await expect(port.linkDuplicateEvidence({
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "mengshu",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
      },
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    })).resolves.toMatchObject({
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      linkKind: "duplicate_evidence",
      source: "write_kernel_dedup",
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();
    expect(calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO mengshu_memory_evidence_links"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();

    const stalePool = { query: vi.fn(), connect: vi.fn() };
    const stale = providerWithPool(stalePool, 14);
    await expect(stale.createDuplicateEvidenceLinkPort().linkDuplicateEvidence({
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "mengshu",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private",
      },
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    })).rejects.toThrow(/schema v15/i);
    expect(stalePool.connect).not.toHaveBeenCalled();
  });

  test("duplicate evidence linker 失败时 rollback/release 且错误保持可重试", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("INSERT INTO mengshu_memory_evidence_links")) {
          throw new Error("ledger unavailable");
        }
        return result();
      }),
      release: vi.fn(),
    };
    const provider = providerWithPool({
      query: vi.fn(),
      connect: vi.fn(async () => client),
    }, 15);

    await expect(provider.createDuplicateEvidenceLinkPort().linkDuplicateEvidence({
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "mengshu",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private",
      },
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    })).rejects.toThrow("ledger unavailable");

    expect(calls).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO mengshu_memory_evidence_links"),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  test("candidate evidence read factory 绑定 provider pool 并要求 v14", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const pool = { query: vi.fn(async () => result()), connect: vi.fn() };
    const provider = providerWithPool(pool, 14);
    const port = provider.createCandidateEvidenceReadPort();
    expect(port).toBeInstanceOf(PostgresCandidateEvidenceReadPort);
    await expect(port.readAuthoritativeEvidenceFacts({
      evidenceIds: [id],
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "INCOMPLETE_EVIDENCE" });
    expect(pool.query).toHaveBeenCalledOnce();

    const stale = providerWithPool(pool, 13);
    await expect(stale.createCandidateEvidenceReadPort().readAuthoritativeEvidenceFacts({
      evidenceIds: [id],
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private", workspaceId: "workspace-a", sessionId: "session-a",
      },
      signal: new AbortController().signal,
    })).rejects.toThrow(/candidate evidence read/i);
  });

  test("active derivation read factory 绑定 provider pool 并要求 v14", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
    };
    const provider = providerWithPool(pool, 14);
    const port = provider.createActiveMemoryDerivationReadPort();

    expect(port).toBeInstanceOf(PostgresActiveMemoryDerivationReadPort);
    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: [],
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private",
      },
      signal: new AbortController().signal,
    })).resolves.toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();

    const staleProvider = providerWithPool(pool, 13);
    await expect(staleProvider.createActiveMemoryDerivationReadPort()
      .readCommittedActiveRecords({
        activeMemoryIds: ["memory-a"],
        scope: {
          tenantId: "tenant-a", userId: "user-a", appId: "codex",
          projectId: "project-a", agentId: "agent-a", namespace: "memory",
          visibility: "private",
        },
        signal: new AbortController().signal,
      })).rejects.toThrow(/active derivation read/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("authoritative Entity Graph read factory 绑定 provider pool 并要求 v15", async () => {
    const pool = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
    const provider = providerWithPool(pool, 14);
    const port = provider.createAuthoritativeEntityGraphReadPort();

    expect(port).toBeInstanceOf(PostgresAuthoritativeEntityGraphReadPort);
    await expect(port.read({
      graphKind: "entity",
      activeMemoryId: "memory-a",
      evidenceId: "evidence-a",
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "mengshu",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private",
      },
      signal: new AbortController().signal,
    })).rejects.toThrow(/authoritative entity graph read.*schema v15/i);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("candidate dedup read factory 绑定 provider pool，不向 Runtime 暴露 query client", async () => {
    const pool = {
      query: vi.fn(async () => result()),
      connect: vi.fn(),
    };
    const provider = providerWithPool(pool, 14);
    const port = provider.createCandidateDedupReadPort();

    expect(port).toBeInstanceOf(PostgresCandidateDedupReadAdapter);
    await expect(port.findExisting({
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "private",
      },
      kind: "fact",
      semanticType: "rules",
      embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
      embeddingSpaceState: "known-queryable",
      excludeIds: [],
    })).resolves.toEqual([]);

    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("暴露 provider-owned kernel callback transaction，预检只使用 dedicated client", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
        calls.push(sql);
        return result();
      });
    const client: PostgresMemoryWriteKernelClient = {
      query: query as unknown as PostgresMemoryWriteKernelClient["query"],
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => { throw new Error("pool.query must not be used"); }),
      connect: vi.fn(async () => client),
    };
    const provider = providerWithPool(pool, 14);
    const port = provider.createMemoryWriteKernelTransactionPort();

    expect(isProviderOwnedMemoryWriteKernelTransactionPort(port)).toBe(true);
    await expect(port.transaction(async (tx) => tx.getReceipt({
      tenantId: "tenant-a",
      userId: "user-a",
      clientKey: "request-a",
      storageKey: "a".repeat(64),
    }))).resolves.toBeUndefined();

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(calls[0]).toBe("BEGIN");
    expect(calls.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("active route 使用同一 client 写 canonical memory 且不嵌套 atomic store", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push(sql);
        if (/INSERT INTO "memories"/.test(sql)) {
          return result([{ id: params[0] as string }]);
        }
        return result();
      });
    const client: PostgresMemoryWriteKernelClient = {
      query: query as unknown as PostgresMemoryWriteKernelClient["query"],
      release: vi.fn(),
    };
    const provider = providerWithPool({
      query: vi.fn(),
      connect: vi.fn(async () => client),
    }, 14);
    const atomicFactory = vi.spyOn(provider, "createAtomicMemoryStorePort");
    const memory: WriteMemoryRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      commandType: "saveExplicit",
      mutation: "content",
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memories",
      },
      text: "remember this",
      vector: [0.1, 0.2],
      route: "active",
      valueScore: 0.9,
      importance: 0.7,
      kind: "fact",
      confidence: 0.9,
      provenance: {},
      evidenceIds: [],
      governance: { candidate: { confidence: 0.9 } },
      metadata: {
        embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
        embeddingSpaceState: "known-queryable",
      },
      createdAt: 1_000,
    };

    const fingerprint = "b".repeat(64);
    const identity = {
      tenantId: "tenant-a", userId: "user-a", clientKey: "request-a",
      storageKey: "a".repeat(64),
    };
    await expect(provider.createMemoryWriteKernelTransactionPort().transaction(async (tx) => {
      await tx.getReceipt(identity);
      const mutation = await tx.writeMemory(memory);
      await tx.appendAudit({
        action: "memory.write", recordType: "memory", memoryId: mutation.memoryId,
        requestFingerprint: fingerprint, commandType: "saveExplicit",
        scope: memory.scope, route: "active", at: memory.createdAt,
      });
      await tx.appendOutbox({
        topic: "memory.written", recordType: "memory", memoryId: mutation.memoryId,
        requestFingerprint: fingerprint, commandType: "saveExplicit",
        scope: memory.scope, at: memory.createdAt,
      });
      await tx.saveReceipt(createMemoryWriteReceipt(identity, fingerprint, {
        status: "persisted", route: "active", recordType: "memory",
        memoryId: mutation.memoryId, stored: mutation.stored,
      }));
      return mutation;
    })).resolves.toEqual({
      memoryId: "11111111-1111-4111-8111-111111111111",
      stored: true,
    });

    expect(atomicFactory).not.toHaveBeenCalled();
    expect(calls.some((sql) => /INSERT INTO "memories"/.test(sql))).toBe(true);
    expect(calls.some((sql) => sql.includes("INSERT INTO mengshu_write_receipts"))).toBe(true);
    expect(calls.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("candidate route 使用同一 client 写候选表和 candidate journal", async () => {
    const calls: string[] = [];
    const candidateId = "candidate-a";
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("INSERT INTO mengshu_candidates")) {
        return result([{ id: candidateId }]);
      }
      return result();
    });
    const client: PostgresMemoryWriteKernelClient = {
      query: query as unknown as PostgresMemoryWriteKernelClient["query"],
      release: vi.fn(),
    };
    const provider = providerWithPool({
      query: vi.fn(),
      connect: vi.fn(async () => client),
    }, 14);
    const record: WriteMemoryRecord = {
      id: candidateId,
      commandType: "observeAuto",
      mutation: "content",
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "codex",
        projectId: "project-a", agentId: "agent-a", namespace: "memories",
        visibility: "private",
      },
      text: "remember this candidate",
      metadata: {},
      vector: [0.1, 0.2],
      route: "candidate",
      valueScore: 0.7,
      importance: 0.6,
      kind: "observation",
      confidence: 0.8,
      provenance: { source: "agent" },
      evidenceIds: ["evidence-a"],
      governance: { candidate: { confidence: 0.8, extractor: "validator-v1" } },
      createdAt: 1_000,
    };
    const fingerprint = "b".repeat(64);
    const identity = {
      tenantId: "tenant-a", userId: "user-a", clientKey: "request-a",
      storageKey: "a".repeat(64),
    };

    await expect(provider.createMemoryWriteKernelTransactionPort().transaction(async (tx) => {
      await tx.getReceipt(identity);
      const mutation = await tx.writeMemory(record);
      await tx.appendAudit({
        action: "candidate.write", recordType: "candidate", memoryId: mutation.memoryId,
        requestFingerprint: fingerprint, commandType: "observeAuto",
        scope: record.scope, route: "candidate", at: record.createdAt,
      });
      await tx.appendOutbox({
        topic: "candidate.written", recordType: "candidate", memoryId: mutation.memoryId,
        requestFingerprint: fingerprint, commandType: "observeAuto",
        scope: record.scope, at: record.createdAt,
      });
      await tx.saveReceipt(createMemoryWriteReceipt(identity, fingerprint, {
        status: "persisted", route: "candidate", recordType: "candidate",
        candidateId: mutation.memoryId, memoryId: mutation.memoryId, stored: mutation.stored,
      }));
      return mutation;
    })).resolves.toEqual({ memoryId: candidateId, stored: true });

    expect(calls.some((sql) => sql.startsWith("INSERT INTO mengshu_candidates"))).toBe(true);
    expect(calls.some((sql) => sql.includes("INSERT INTO mengshu_candidate_write_receipts")))
      .toBe(true);
    expect(calls.some((sql) => /INSERT INTO mengshu_write_(audit|outbox|receipts)/.test(sql)))
      .toBe(false);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  test("kernel factory 在 schema v14 缺失时连接前 fail-closed", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const provider = providerWithPool(pool, 13);

    await expect(provider.createMemoryWriteKernelTransactionPort().transaction(async () => undefined))
      .rejects.toThrow(/connection failed/i);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("Work Memory Graph factory 的查询走 pool，写入走 dedicated client 并要求 v13", async () => {
    const directQuery = vi.fn(async () => result());
    const client = {
      query: vi.fn(async (sql: string) => result(sql === "BEGIN" || sql === "COMMIT" ? [] : [])),
      release: vi.fn(),
    };
    const pool = { query: directQuery, connect: vi.fn(async () => client) };
    const provider = providerWithPool(pool, 13);
    const repository = provider.createWorkMemoryGraphRepository();
    const scope = {
      tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
      agentId: "agent-a", namespace: "memory", visibility: "private" as const,
    };

    await expect(repository.findWorkMemoryNodes({ scope })).resolves.toEqual([]);
    await expect(repository.upsertWorkMemoryGraph({ scope, nodes: [], edges: [] }))
      .resolves.toBeUndefined();

    expect(directQuery).toHaveBeenCalledTimes(1);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("node_type = 'evidence'"),
      expect.stringContaining("id = ANY"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("Work Memory Graph factory 在 schema v13 缺失时读写均 fail-closed", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const repository = providerWithPool(pool, 12).createWorkMemoryGraphRepository();
    const scope = {
      tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
      agentId: "agent-a", namespace: "memory", visibility: "private" as const,
    };

    await expect(repository.findWorkMemoryNodes({ scope })).rejects.toThrow(/schema v13/i);
    await expect(repository.upsertWorkMemoryGraph({ scope, nodes: [], edges: [] }))
      .rejects.toThrow(/schema v13/i);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
