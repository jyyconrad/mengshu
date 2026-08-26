import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  linkDuplicateEvidenceWithClient,
  type PostgresMemoryEvidenceLinkQueryClient,
} from "./postgres-memory-evidence-link-port.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

describe("Postgres memory evidence link port", () => {
  test("使用完整 9D scope 与确定性 ID 幂等写入 duplicate evidence ledger", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ link_id: params[0] }], rowCount: 1 };
    });
    const client = { query: query as PostgresMemoryEvidenceLinkQueryClient["query"] };
    const input = {
      scope,
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    };

    const first = await linkDuplicateEvidenceWithClient(client, input);
    const replay = await linkDuplicateEvidenceWithClient(client, input);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      linkId: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeFingerprint: authorityScopeFingerprint(scope),
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      linkKind: "duplicate_evidence",
      source: "write_kernel_dedup",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("INSERT INTO mengshu_memory_evidence_links");
    expect(calls[0]!.sql).toContain("ON CONFLICT");
    expect(calls[0]!.sql).toContain("RETURNING link_id");
    expect(calls[0]!.sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
    expect(calls[0]!.params).toEqual([
      first.linkId,
      authorityScopeFingerprint(scope),
      "tenant-a",
      "user-a",
      "mengshu",
      "project-a",
      "agent-a",
      "working-context",
      "private",
      "workspace-a",
      "session-a",
      "active-existing",
      "evidence-memory-1",
      "duplicate_evidence",
      "write_kernel_dedup",
      123,
    ]);
  });

  test("任一 scope 维度变化都会改变 fingerprint 与 deterministic link_id", async () => {
    const ids: string[] = [];
    const client: PostgresMemoryEvidenceLinkQueryClient = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        _sql: string,
        params: readonly unknown[] = [],
      ) {
        ids.push(String(params[0]));
        return { rows: [{ link_id: params[0] }] as unknown as Row[], rowCount: 1 };
      },
    };
    const common = {
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    };

    const base = await linkDuplicateEvidenceWithClient(client, { scope, ...common });
    const changed = await linkDuplicateEvidenceWithClient(client, {
      scope: { ...scope, sessionId: "session-b" },
      ...common,
    });

    expect(base.scopeFingerprint).not.toBe(changed.scopeFingerprint);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("缺省 workspace/session 归一为空列但仍使用原始 9D scope 计算 fingerprint", async () => {
    const params: unknown[][] = [];
    const client: PostgresMemoryEvidenceLinkQueryClient = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        _sql: string,
        values: readonly unknown[] = [],
      ) {
        params.push([...values]);
        return { rows: [{ link_id: values[0] }] as unknown as Row[], rowCount: 1 };
      },
    };
    const minimalScope = { ...scope, workspaceId: undefined, sessionId: undefined };

    await expect(linkDuplicateEvidenceWithClient(client, {
      scope: minimalScope,
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    })).resolves.toMatchObject({
      scopeFingerprint: authorityScopeFingerprint(minimalScope),
    });
    expect(params[0]?.slice(9, 11)).toEqual(["", ""]);
  });

  test("query 失败或未返回唯一 link receipt 时拒绝完成", async () => {
    const input = {
      scope,
      targetMemoryId: "active-existing",
      evidenceMemoryId: "evidence-memory-1",
      createdAt: 123,
    };
    const failed: PostgresMemoryEvidenceLinkQueryClient = {
      async query() {
        throw new Error("postgres unavailable");
      },
    };
    const missing: PostgresMemoryEvidenceLinkQueryClient = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>() {
        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    await expect(linkDuplicateEvidenceWithClient(failed, input)).rejects.toThrow(
      "postgres unavailable",
    );
    await expect(linkDuplicateEvidenceWithClient(missing, input)).rejects.toThrow(
      /receipt is invalid/i,
    );
  });
});
