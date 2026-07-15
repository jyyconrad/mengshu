import { describe, expect, test } from "vitest";
import type { MemoryAutodbRegistry } from "../../runtime/registry.js";
import {
  executePostgresScopeBackfill,
  ScopeBackfillExecutorError,
  type PostgresScopeBackfillClient,
  type PostgresScopeBackfillQueryResult,
} from "./scope-backfill-executor.js";

const registry: MemoryAutodbRegistry = {
  version: 2,
  projects: {
    "project-alpha": {
      workspaceId: "workspace-alpha",
      manifestPath: "/registry/project-alpha/manifest.json",
      canonicalRoot: "/repos/alpha",
      lastSeenRoot: "/repos/alpha",
      aliases: [{ value: "alpha", normalized: "alpha", source: "slug" }],
    },
  },
  workspaces: { "workspace-alpha": { projectIds: ["project-alpha"] } },
};

const completeMetadata = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "workspace",
  productId: "mengshu",
  producerId: "codex",
  projectId: "project-alpha",
};

const ID_1 = "00000000-0000-4000-8000-000000000001";
const ID_2 = "00000000-0000-4000-8000-000000000002";
const ID_3 = "00000000-0000-4000-8000-000000000003";
const ID_4 = "00000000-0000-4000-8000-000000000004";
const ID_5 = "00000000-0000-4000-8000-000000000005";
const ID_OTHER = "00000000-0000-4000-8000-000000000099";

interface Call {
  sql: string;
  params: readonly unknown[];
}

class FakeClient implements PostgresScopeBackfillClient {
  readonly calls: Call[] = [];

  constructor(
    private readonly responder: (
      sql: string,
      params: readonly unknown[],
      callIndex: number,
    ) => PostgresScopeBackfillQueryResult | Promise<PostgresScopeBackfillQueryResult>,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresScopeBackfillQueryResult<Row>> {
    const callIndex = this.calls.push({ sql, params }) - 1;
    return await this.responder(sql, params, callIndex) as PostgresScopeBackfillQueryResult<Row>;
  }
}

function commandResult(): PostgresScopeBackfillQueryResult {
  return { rows: [], rowCount: 0 };
}

function noRemainingRows(): PostgresScopeBackfillQueryResult {
  return { rows: [{ remaining_count: "0" }], rowCount: 1 };
}

function jsonbType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value === "string" ? "string" : typeof value;
}

function row(id: string, metadata: unknown): Record<string, unknown> {
  const metadataObject = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined;
  const provenancePresent = metadataObject !== undefined &&
    Object.prototype.hasOwnProperty.call(metadataObject, "provenance");
  const provenance = provenancePresent ? metadataObject.provenance : null;
  return {
    id,
    metadata,
    metadata_type: jsonbType(metadata),
    provenance_present: provenancePresent,
    provenance,
    provenance_type: provenancePresent ? jsonbType(provenance) : null,
  };
}

describe("executePostgresScopeBackfill / contract", () => {
  test("默认 dry-run：分页规划并统计 resolved/quarantined/conflict，数据库零写", async () => {
    const rows = [
      row(ID_1, completeMetadata),
      row(ID_2, { ...completeMetadata, projectId: "unknown-project" }),
      row(ID_3, { ...completeMetadata, provenance: { tenantId: "tenant-b" } }),
    ];
    let page = 0;
    const client = new FakeClient((sql, params) => {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(/FOR UPDATE|SKIP LOCKED/);
      expect(params).toHaveLength(2);
      page += 1;
      return page === 1
        ? { rows, rowCount: rows.length }
        : { rows: [], rowCount: 0 };
    });

    const result = await executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      batchSize: 10,
    });

    expect(result).toEqual({
      mode: "dry-run",
      table: "memories",
      scanned: 3,
      resolved: 1,
      quarantined: 1,
      conflict: 1,
      skipped: 0,
      batches: 1,
    });
    expect(client.calls.every(({ sql }) => /^SELECT /.test(sql))).toBe(true);
    expect(client.calls[0]?.sql).toMatch(/\(\$1::uuid IS NULL OR id > \$1::uuid\)/);
    expect(client.calls[0]?.sql).toMatch(/ORDER BY id ASC/);
    expect(client.calls[0]?.sql).toContain("jsonb_typeof(metadata) = 'object'");
    expect(client.calls[0]?.sql).not.toMatch(/id::text\s*(?:>|ASC|=)|ORDER BY id::text/);
  });

  test("apply 必须同时显式确认 maintenance 与 quiescence，且失败时零查询", async () => {
    const client = new FakeClient(() => commandResult());

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: false,
    })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_MAINTENANCE_REQUIRED" });
    expect(client.calls).toHaveLength(0);
  });

  test.each(["documents", "memories; DROP TABLE knowledge", "\"memories\""])(
    "只接受 memories/knowledge 白名单：%s",
    async (table) => {
      const client = new FakeClient(() => commandResult());
      await expect(executePostgresScopeBackfill(client, {
        table: table as "memories",
        registry,
      })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_INVALID_OPTIONS" });
      expect(client.calls).toHaveLength(0);
    },
  );
});

describe("executePostgresScopeBackfill / apply", () => {
  test("500 resolved 行每批固定单次 bulk UPDATE，不产生逐行 roundtrip", async () => {
    const rows = Array.from({ length: 500 }, (_, index) =>
      row(`00000000-0000-4000-8${String(index).padStart(3, "0")}-${String(index + 1).padStart(12, "0")}`, completeMetadata));
    let selected = false;
    const client = new FakeClient((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT COUNT/.test(sql)) return noRemainingRows();
      if (/^SELECT /.test(sql)) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE /.test(sql)) {
        const payload = JSON.parse(String(params[0])) as Array<{ id: string }>;
        return { rows: payload.map(({ id }) => ({ id })), rowCount: payload.length };
      }
      throw new Error("unexpected SQL");
    });

    const result = await executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      batchSize: 500,
    });

    expect(result.resolved).toBe(500);
    expect(client.calls.filter(({ sql }) => /^UPDATE /.test(sql))).toHaveLength(1);
  });

  test("resolved/quarantine/malformed 混合批次最多三个固定 bulk UPDATE", async () => {
    const mixedRows = [
      row(ID_1, completeMetadata),
      row(ID_2, { ...completeMetadata, projectId: "unknown-project" }),
      row(ID_3, "malformed"),
    ];
    let selected = false;
    const client = new FakeClient((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT") return commandResult();
      if (/^SELECT COUNT/.test(sql)) return noRemainingRows();
      if (/^SELECT /.test(sql)) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return { rows: mixedRows, rowCount: mixedRows.length };
      }
      if (/^UPDATE /.test(sql)) {
        const payload = JSON.parse(String(params[0])) as Array<{ id: string }>;
        return { rows: payload.map(({ id }) => ({ id })), rowCount: payload.length };
      }
      throw new Error("unexpected SQL");
    });

    const result = await executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    });

    expect(result).toMatchObject({ resolved: 1, quarantined: 2, conflict: 0 });
    expect(client.calls.filter(({ sql }) => /^UPDATE /.test(sql))).toHaveLength(3);
  });

  test("bulk UPDATE 部分 RETURNING 时视为并发 drift 并回滚整批", async () => {
    const batchRows = [row(ID_1, completeMetadata), row(ID_2, completeMetadata)];
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT /.test(sql)) return { rows: batchRows, rowCount: batchRows.length };
      if (/^UPDATE /.test(sql)) return { rows: [{ id: ID_1 }], rowCount: 1 };
      throw new Error("unexpected SQL");
    });

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_CONCURRENT_DRIFT" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
  });

  test("锁住或漏扫的 pending 行不能因主查询返回空而被宣告成功", async () => {
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT COUNT/.test(sql)) {
        return { rows: [{ remaining_count: "1" }], rowCount: 1 };
      }
      if (/^SELECT /.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error("unexpected SQL");
    });

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_CONCURRENT_DRIFT" });
    const lockingSelect = client.calls.find(({ sql }) => /^SELECT /.test(sql) && !/^SELECT COUNT/.test(sql));
    expect(lockingSelect?.sql).toMatch(/FOR UPDATE NOWAIT$/);
    expect(lockingSelect?.sql).toMatch(/ORDER BY id ASC/);
    expect(lockingSelect?.sql).not.toMatch(/ORDER BY id::text|WHERE id::text/);
    expect(lockingSelect?.sql).not.toContain("SKIP LOCKED");
    expect(client.calls.some(({ sql }) => /^SELECT COUNT/.test(sql))).toBe(true);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("scalar/array/null metadata 与非法 provenance object 被固定隔离且同批继续", async () => {
    const malformed = new Map<string, unknown>([
      [ID_1, "legacy-scalar"],
      [ID_2, ["legacy-array"]],
      [ID_3, null],
      [ID_4, { ...completeMetadata, provenance: ["not-an-object"] }],
    ]);
    let selected = false;
    const client = new FakeClient((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT") return commandResult();
      if (/^SELECT COUNT/.test(sql)) return noRemainingRows();
      if (/^SELECT /.test(sql)) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return {
          rows: [
            row(ID_1, malformed.get(ID_1)),
            row(ID_2, malformed.get(ID_2)),
            row(ID_3, malformed.get(ID_3)),
            row(ID_4, malformed.get(ID_4)),
            row(ID_5, completeMetadata),
          ],
          rowCount: 5,
        };
      }
      if (/^UPDATE /.test(sql)) {
        const payload = JSON.parse(String(params[0])) as Array<{
          id: string;
          quarantine_reason?: string;
          old_metadata: unknown;
        }>;
        if (sql.includes("tenant_id = staged.tenant_id")) {
          expect(payload.map(({ id }) => id)).toEqual([ID_5]);
          expect(sql).toMatch(/metadata = target\.metadata \|\| staged\.audit_patch/);
        } else {
          expect(payload.map(({ id }) => id)).toEqual([ID_1, ID_2, ID_3, ID_4]);
          expect(sql).toMatch(/SET legacy_quarantine_reason = staged\.quarantine_reason/);
          expect(sql).not.toMatch(/metadata\s*=/);
          expect(payload.every((item) => item.quarantine_reason === "invalid-metadata-shape"))
            .toBe(true);
          for (const item of payload) expect(item.old_metadata).toEqual(malformed.get(item.id));
        }
        return { rows: payload.map(({ id }) => ({ id })), rowCount: payload.length };
      }
      throw new Error("unexpected SQL");
    });

    const result = await executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      batchSize: 5,
    });

    expect(result).toMatchObject({
      scanned: 5,
      resolved: 1,
      quarantined: 4,
      conflict: 0,
    });
    expect(client.calls.filter(({ sql }) => /^UPDATE /.test(sql))).toHaveLength(2);
  });

  test("数据库返回非 UUID id 时整批 fail-closed", async () => {
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT /.test(sql)) {
        return { rows: [row("not-a-uuid", completeMetadata)], rowCount: 1 };
      }
      throw new Error("unexpected SQL");
    });

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_INVALID_DB_RESULT" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("resolved 行在事务中参数化写 canonical scope/producer/scope_key 与脱敏审计 patch", async () => {
    let selected = false;
    const client = new FakeClient((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT COUNT/.test(sql)) return noRemainingRows();
      if (/^SELECT /.test(sql)) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return { rows: [row(ID_1, { ...completeMetadata, secret: "never-log-me" })], rowCount: 1 };
      }
      if (/^UPDATE /.test(sql)) {
        expect(sql).toContain('UPDATE "memories"');
        expect(sql).toMatch(/tenant_id = staged\.tenant_id/);
        expect(sql).toMatch(/scope_key = staged\.scope_key/);
        expect(sql).toMatch(/target\.metadata IS NOT DISTINCT FROM staged\.old_metadata/);
        expect(sql).toMatch(/target\.id = staged\.id/);
        expect(sql).toMatch(/target\.scope_key IS NULL/);
        expect(sql).toMatch(/target\.legacy_quarantine_reason IS NULL/);
        expect(sql).not.toMatch(/WHERE id::text|ORDER BY id::text/);
        expect(sql).not.toContain("tenant-a");
        const payload = JSON.parse(String(params[0])) as Array<Record<string, unknown>>;
        expect(payload).toHaveLength(1);
        expect(payload[0]).toMatchObject({
          id: ID_1,
          tenant_id: "tenant-a",
          user_id: "user-a",
          canonical_project_id: "project-alpha",
          product_id: "mengshu",
          producer_id: "codex",
          namespace: "memories",
          visibility: "workspace",
          app_name: "app-a",
          agent_id: "agent-a",
          workspace_id: "workspace-alpha",
          scope_key: "tenant-a:app-a:user-a:project-alpha:agent-a:memories",
        });
        const patch = payload[0]?.audit_patch as Record<string, unknown>;
        expect(patch).toMatchObject({
          scope: { projectId: "project-alpha", workspaceId: "workspace-alpha" },
          producer: { productId: "mengshu", producerId: "codex" },
          mengshuScopeBackfill: {
            status: "resolved",
            eligibility: {
              eligibleForRecall: true,
              eligibleForContext: true,
              eligibleForAnn: true,
            },
          },
        });
        expect(JSON.stringify(patch)).not.toContain("never-log-me");
        expect(JSON.stringify(patch)).toMatch(/[a-f0-9]{64}/);
        return { rows: [{ id: ID_1 }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      batchSize: 1,
    });

    expect(result).toMatchObject({ scanned: 1, resolved: 1, quarantined: 0, conflict: 0 });
    expect(client.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN", expect.stringMatching(/^SELECT /), expect.stringMatching(/^UPDATE /), "COMMIT",
      "BEGIN", expect.stringMatching(/^SELECT /), expect.stringMatching(/^SELECT COUNT/), "COMMIT",
    ]);
  });

  test("未知项目只写 quarantine reason 与 deny eligibility，不写任何身份列", async () => {
    let selected = false;
    const client = new FakeClient((sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT COUNT/.test(sql)) return noRemainingRows();
      if (/^SELECT /.test(sql)) {
        if (selected) return { rows: [], rowCount: 0 };
        selected = true;
        return {
          rows: [row(ID_4, { ...completeMetadata, projectId: "not-registered" })],
          rowCount: 1,
        };
      }
      if (/^UPDATE /.test(sql)) {
        expect(sql).toMatch(/^UPDATE "knowledge"/);
        expect(sql).not.toMatch(/tenant_id\s*=|user_id\s*=|canonical_project_id\s*=|scope_key\s*=/);
        expect(sql).toMatch(/target\.metadata IS NOT DISTINCT FROM staged\.old_metadata/);
        const payload = JSON.parse(String(params[0])) as Array<{
          id: string;
          quarantine_reason: string;
          audit_patch: Record<string, unknown>;
        }>;
        expect(payload).toHaveLength(1);
        expect(payload[0]?.quarantine_reason).toContain("unknown-project-reference");
        const patch = payload[0]?.audit_patch;
        expect(patch).toMatchObject({
          mengshuScopeBackfill: {
            status: "legacy-quarantine",
            eligibility: {
              eligibleForRecall: false,
              eligibleForContext: false,
              eligibleForAnn: false,
            },
          },
        });
        expect(JSON.stringify(patch)).not.toContain('"tenantId":"local"');
        return { rows: [{ id: ID_4 }], rowCount: 1 };
      }
      throw new Error("unexpected SQL");
    });

    const result = await executePostgresScopeBackfill(client, {
      table: "knowledge",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    });

    expect(result).toMatchObject({ resolved: 0, quarantined: 1, conflict: 0 });
  });

  test("相同执行器重复运行不重复写已处理行", async () => {
    let persisted = false;
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return commandResult();
      if (/^SELECT COUNT/.test(sql)) return noRemainingRows();
      if (/^SELECT /.test(sql)) {
        return persisted
          ? { rows: [], rowCount: 0 }
          : { rows: [row(ID_1, completeMetadata)], rowCount: 1 };
      }
      if (/^UPDATE /.test(sql)) {
        persisted = true;
        return { rows: [{ id: ID_1 }], rowCount: 1 };
      }
      throw new Error("unexpected SQL");
    });
    const options = {
      table: "memories" as const,
      registry,
      mode: "apply" as const,
      maintenance: true as const,
      quiescenceConfirmed: true as const,
    };

    const first = await executePostgresScopeBackfill(client, options);
    const updatesAfterFirst = client.calls.filter(({ sql }) => /^UPDATE /.test(sql)).length;
    const second = await executePostgresScopeBackfill(client, options);

    expect(first.resolved).toBe(1);
    expect(second).toMatchObject({ scanned: 0, resolved: 0, quarantined: 0, conflict: 0 });
    expect(client.calls.filter(({ sql }) => /^UPDATE /.test(sql))).toHaveLength(updatesAfterFirst);
  });

  test.each([
    { name: "optimistic concurrency drift", update: { rows: [], rowCount: 0 } },
    { name: "malformed UPDATE shape", update: { rows: [{ id: ID_1 }], rowCount: 2 } },
    { name: "wrong RETURNING id", update: { rows: [{ id: ID_OTHER }], rowCount: 1 } },
  ])("$name 时整批 rollback", async ({ update }) => {
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT /.test(sql)) return { rows: [row(ID_1, completeMetadata)], rowCount: 1 };
      if (/^UPDATE /.test(sql)) return update;
      throw new Error("unexpected SQL");
    });

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toBeInstanceOf(ScopeBackfillExecutorError);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
  });

  test("SELECT rowCount/rows 不一致或 row shape 非法时 rollback", async () => {
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return commandResult();
      if (/^SELECT /.test(sql)) return { rows: [{ id: ID_1, metadata: "secret" }], rowCount: 2 };
      throw new Error("unexpected SQL");
    });

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_INVALID_DB_RESULT" });
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("数据库错误消息含敏感值时，对外错误保持固定脱敏", async () => {
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return commandResult();
      throw new Error("password=super-secret metadata=private-value");
    });

    let thrown: unknown;
    try {
      await executePostgresScopeBackfill(client, {
        table: "memories",
        registry,
        mode: "apply",
        maintenance: true,
        quiescenceConfirmed: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ScopeBackfillExecutorError);
    expect(String(thrown)).not.toContain("super-secret");
    expect(String(thrown)).not.toContain("private-value");
  });

  test("rollback 自身失败也只暴露固定错误，不泄漏底层消息", async () => {
    const client = new FakeClient((sql) => {
      if (sql === "BEGIN") return commandResult();
      if (sql === "ROLLBACK") throw new Error("rollback-password");
      throw new Error("query-password");
    });

    await expect(executePostgresScopeBackfill(client, {
      table: "memories",
      registry,
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toMatchObject({ code: "SCOPE_BACKFILL_ROLLBACK_FAILED" });
  });
});
