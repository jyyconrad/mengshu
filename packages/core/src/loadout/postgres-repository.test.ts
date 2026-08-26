import { describe, expect, test, vi } from "vitest";

import { PostgresAgentLoadoutRepository } from "./postgres-repository.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { AgentLoadout, AgentLoadoutReceipt } from "./types.js";

const scope = {
  tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
  agentId: "agent-a", namespace: "memory", visibility: "private" as const,
};
const loadout: AgentLoadout = {
  id: "loadout-1",
  scope,
  appId: scope.appId,
  agentId: scope.agentId,
  projectId: scope.projectId,
  version: 1,
  visibility: "private",
  slotBindings: [{
    assetId: "asset-1", slot: "rules", disclosureMode: "slot_summary",
    priority: 10, required: false, maxTokens: 200,
  }],
  nativeMemoryPolicy: {
    semanticTypes: ["profile", "task_context", "rules", "experience", "resource"],
    scopeReuse: "project_only",
    treeDepth: "topic",
    tokenBudgets: { profile: 500, task_context: 500, rules: 500, experience: 500, resource: 500 },
  },
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};
const receipt: AgentLoadoutReceipt = {
  requestKey: "request-1",
  requestHash: "a".repeat(64),
  loadoutId: loadout.id,
  loadoutVersion: 1,
};

describe("PostgresAgentLoadoutRepository", () => {
  test("resolves the unique current loadout by exact scope identity", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) =>
      ({ rows: [{
        scope_fingerprint: authorityScopeFingerprint(scope), loadout_id: loadout.id,
        latest_version: loadout.version, version: loadout.version, app_id: loadout.appId,
        agent_id: loadout.agentId, project_id: loadout.projectId,
        visibility: loadout.visibility, descriptor: loadout,
      }], rowCount: 1 }));
    const repo = new PostgresAgentLoadoutRepository({ query, connect: vi.fn() as never });
    await expect(repo.resolveCurrent(scope)).resolves.toEqual(loadout);
    expect(query.mock.calls[0]?.[0]).toContain("loadout-repository:resolve-current");
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/), scope.appId, scope.agentId, scope.projectId,
    ]);
  });

  test("fails closed when more than one current loadout matches", async () => {
    const repo = new PostgresAgentLoadoutRepository({
      query: async () => ({ rows: [{ descriptor: loadout }, { descriptor: loadout }], rowCount: 2 }),
      connect: vi.fn() as never,
    });
    await expect(repo.resolveCurrent(scope)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("persists append-only loadout version and idempotency receipt transactionally", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push(sql);
        if (sql.includes("loadout-repository:receipt-lock") ||
            sql.includes("loadout-repository:head-lock")) return { rows: [], rowCount: 0 };
        if (sql.includes("loadout-repository:insert-version")) {
          return { rows: [{ version: loadout.version }], rowCount: 1 };
        }
        if (sql.includes("loadout-repository:upsert-head")) {
          return { rows: [{ latest_version: loadout.version }], rowCount: 1 };
        }
        if (sql.includes("loadout-repository:insert-receipt")) {
          return { rows: [{ request_key: receipt.requestKey }], rowCount: 1 };
        }
        if (sql.includes("loadout-repository:insert-audit")) {
          return { rows: [{ audit_id: "1" }], rowCount: 1 };
        }
        if (sql.includes("loadout-repository:insert-outbox")) {
          return { rows: [{ event_id: params[0] }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const repo = new PostgresAgentLoadoutRepository({
      connect: async () => client,
      query: client.query,
    });
    await expect(repo.appendVersion({ loadout, receipt, expectedLatestVersion: 0 }))
      .resolves.toEqual({ loadout, receipt, replayed: false });
    expect(calls).toEqual([
      "BEGIN",
      expect.stringContaining("loadout-repository:receipt-lock"),
      expect.stringContaining("loadout-repository:head-lock"),
      expect.stringContaining("loadout-repository:insert-version"),
      expect.stringContaining("loadout-repository:upsert-head"),
      expect.stringContaining("loadout-repository:insert-receipt"),
      expect.stringContaining("loadout-repository:insert-audit"),
      expect.stringContaining("loadout-repository:insert-outbox"),
      "COMMIT",
    ]);
  });

  test("concurrent same-key replay returns persisted loadout despite generated timestamps", async () => {
    const persisted = loadout;
    const concurrent = {
      ...loadout,
      createdAt: "2026-08-13T00:00:01.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z",
    };
    const client = {
      query: vi.fn(async (sql: string) => sql.includes("loadout-repository:receipt-lock")
        ? {
            rows: [{
              receipt, scope_fingerprint: authorityScopeFingerprint(scope),
              request_key: receipt.requestKey, request_hash: receipt.requestHash,
              loadout_id: receipt.loadoutId, loadout_version: receipt.loadoutVersion,
              descriptor: persisted, version_app_id: persisted.appId,
              version_agent_id: persisted.agentId, version_project_id: persisted.projectId,
              version_visibility: persisted.visibility,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    const repo = new PostgresAgentLoadoutRepository({ connect: async () => client, query: client.query });

    await expect(repo.appendVersion({ loadout: concurrent, receipt, expectedLatestVersion: 0 }))
      .resolves.toEqual({ loadout: persisted, receipt, replayed: true });
  });

  test("reads and validates the latest descriptor", async () => {
    const repo = new PostgresAgentLoadoutRepository({
      query: async () => ({ rows: [{
        scope_fingerprint: authorityScopeFingerprint(scope), loadout_id: loadout.id,
        latest_version: loadout.version, version: loadout.version, app_id: loadout.appId,
        agent_id: loadout.agentId, project_id: loadout.projectId,
        visibility: loadout.visibility, descriptor: loadout,
      }], rowCount: 1 }),
      connect: vi.fn() as never,
    });
    await expect(repo.getLatest(scope, loadout.id)).resolves.toEqual(loadout);
  });

  test("rejects a self-consistent descriptor that disagrees with relational columns", async () => {
    const repo = new PostgresAgentLoadoutRepository({
      query: async () => ({ rows: [{
        scope_fingerprint: authorityScopeFingerprint(scope), loadout_id: loadout.id,
        latest_version: loadout.version + 1, version: loadout.version,
        app_id: "other-app", agent_id: loadout.agentId, project_id: loadout.projectId,
        visibility: loadout.visibility, descriptor: loadout,
      }], rowCount: 1 }),
      connect: vi.fn() as never,
    });
    await expect(repo.getLatest(scope, loadout.id)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("rejects an idempotency replay whose persisted descriptor differs", async () => {
    const persisted = { ...loadout, slotBindings: [] };
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("loadout-repository:receipt-lock")) return {
          rows: [{
            receipt, scope_fingerprint: authorityScopeFingerprint(scope),
            request_key: receipt.requestKey, request_hash: receipt.requestHash,
            loadout_id: receipt.loadoutId, loadout_version: receipt.loadoutVersion,
            descriptor: persisted, version_app_id: persisted.appId,
            version_agent_id: persisted.agentId, version_project_id: persisted.projectId,
            version_visibility: persisted.visibility,
          }],
          rowCount: 1,
        };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const repo = new PostgresAgentLoadoutRepository({ connect: async () => client, query: client.query });
    await expect(repo.appendVersion({ loadout, receipt, expectedLatestVersion: 0 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  test.each(["version", "head", "receipt", "audit", "outbox"] as const)(
    "rolls back when the %s write does not return exactly one row",
    async (zeroWrite) => {
      const calls: string[] = [];
      const client = {
        query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
          calls.push(sql);
          if (sql.includes("loadout-repository:receipt-lock") ||
              sql.includes("loadout-repository:head-lock")) return { rows: [], rowCount: 0 };
          const stage = sql.includes("insert-version") ? "version"
            : sql.includes("upsert-head") ? "head"
              : sql.includes("insert-receipt") ? "receipt"
                : sql.includes("insert-audit") ? "audit"
                  : sql.includes("insert-outbox") ? "outbox" : undefined;
          if (!stage) return { rows: [], rowCount: 0 };
          if (stage === zeroWrite) return { rows: [], rowCount: 0 };
          const values = {
            version: { version: loadout.version }, head: { latest_version: loadout.version },
            receipt: { request_key: receipt.requestKey }, audit: { audit_id: "1" },
            outbox: { event_id: params[0] },
          };
          return { rows: [values[stage]], rowCount: 1 };
        }),
        release: vi.fn(),
      };
      const repo = new PostgresAgentLoadoutRepository({ connect: async () => client, query: client.query });
      await expect(repo.appendVersion({ loadout, receipt, expectedLatestVersion: 0 }))
        .rejects.toMatchObject({ code: zeroWrite === "head" ? "VERSION_CONFLICT" : "INVALID_INPUT" });
      expect(calls.at(-1)).toBe("ROLLBACK");
    },
  );
});
