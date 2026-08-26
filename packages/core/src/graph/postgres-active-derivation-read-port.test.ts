import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import {
  PostgresActiveMemoryDerivationReadPort,
  type PostgresActiveDerivationQueryClient,
} from "./postgres-active-derivation-read-port.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "workspace",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

function result(rows: readonly Record<string, unknown>[]) {
  return { rows: [...rows], rowCount: rows.length };
}

function client(
  query: (sql: string, params?: readonly unknown[]) => Promise<ReturnType<typeof result>>,
): PostgresActiveDerivationQueryClient {
  return { query: query as PostgresActiveDerivationQueryClient["query"] };
}

function metadata(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    admissionRoute: "active",
    contextEligible: true,
    valueScore: 0.92,
    importance: 0.81,
    memoryContainer: "project",
    semanticType: "rules",
    confidence: 0.88,
    sourceNodeIds: [`evidence-${id}`],
    embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
    embeddingSpaceState: "known-queryable",
    governance: {
      commandType: "observeAuto",
      candidate: {
        confidence: 0.88,
        riskFlags: [],
        evidence: { eventIds: [`evidence-${id}`] },
      },
      provenance: {
        source: "agent",
        sourceId: `evidence-${id}`,
        sessionId: "session-a",
        createdAt: 1_000,
      },
      evidenceIds: [`evidence-${id}`],
      native: {
        kind: "decision",
        semanticType: "rules",
        category: "other",
        dataType: "memory",
      },
    },
    ...overrides,
  };
}

function activeRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    text: `memory ${id}`,
    vector_text: "[0.1,0.2]",
    importance: 0.81,
    category: "other",
    data_type: "memory",
    physical_data_type: "memory",
    data_type_compatibility: null,
    created_at_ms: "1000",
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    app_id: scope.appId,
    project_id: scope.projectId,
    agent_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
    lifecycle_status: "active",
    legacy_quarantine_reason: null,
    metadata: metadata(id),
    ...overrides,
  };
}

function evidenceRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = activeRow(id, {
    text: `evidence ${id}`,
    importance: 0.45,
    lifecycle_status: "archived",
    metadata: {
      admissionRoute: "evidence_only",
      contextEligible: false,
      importance: 0.45,
      memoryContainer: "session_candidate",
      eventType: "observation",
      source: "agent-fast-path",
      governance: {
        commandType: "importEvidence",
        candidate: {
          phase: "raw_evidence",
          evidenceOnly: true,
          quote: `evidence ${id}`,
          sourceId: id,
        },
        provenance: {
          source: "agent-fast-path",
          sourceId: id,
          sessionId: "session-a",
          createdAt: 900,
        },
        evidenceIds: [id],
        native: {
          kind: "observation",
          container: "session_candidate",
          category: "core",
          dataType: "memory",
        },
      },
      sourceNodeIds: [id],
    },
  });
  return { ...row, created_at_ms: "900", category: "core", ...overrides };
}

function explicitSaveEvidenceRow(id: string): Record<string, unknown> {
  const row = evidenceRow(id);
  const metadata = row.metadata as Record<string, unknown>;
  const governance = metadata.governance as Record<string, unknown>;
  return {
    ...row,
    metadata: {
      ...metadata,
      eventType: "explicit_save",
      source: "user",
      governance: {
        ...governance,
        provenance: {
          source: "user",
          sourceId: id,
        },
      },
    },
  };
}

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Postgres active derivation read port", () => {
  test("只按 receipt activeMemoryIds 回读 committed active，保持请求顺序和原生分类", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result([
      activeRow("memory-b"),
      activeRow("memory-a"),
    ]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));

    const records = await port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a", "memory-b"],
      scope,
      signal: abortSignal(),
    });

    expect(records.map((record) => record.id)).toEqual(["memory-a", "memory-b"]);
    expect(records[0]).toMatchObject({
      mutation: "content",
      route: "active",
      kind: "decision",
      semanticType: "rules",
      evidenceIds: ["evidence-memory-a"],
      scope,
    });
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("id::text = ANY($10::text[])");
    expect(sql).toContain("lifecycle_status = 'active'");
    expect(sql).toContain("metadata->>'admissionRoute' = 'active'");
    expect(sql).toContain("metadata->>'contextEligible' = 'true'");
    expect(sql).toContain("mengshu_history_rebuild_source_rows history_source");
    expect(sql).toContain("NOT (history_source.source_row ? 'importance')");
    expect(sql).toContain("history_plan.plan_receipt_hash = metadata #>> '{historyRebuild,planReceiptHash}'");
    expect(sql).toContain("history_source.source_row->>'dataType' = data_type");
    expect(sql).toContain("history_plan.semantic_type = metadata->>'semanticType'");
    expect(params).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      ["memory-a", "memory-b"],
    ]);
  });

  test("history rebuild importance floor 仅接受 provider 经冻结 ledger 证明后的映射值", async () => {
    const historicalMetadata = metadata("memory-a", {
      importance: 0.70,
      historyRebuild: {
        runId: "history-run-a",
        sourceHash: "a".repeat(64),
        disposition: "backfill",
        planReceiptHash: "b".repeat(64),
      },
    });
    const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) => {
      expect(sql).toContain("history_source.record_id = memories.id");
      expect(sql).toContain("history_run.state = 'completed'");
      return result([activeRow("memory-a", {
        importance: 0.70,
        metadata: historicalMetadata,
      })]);
    });
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));

    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    })).resolves.toEqual([expect.objectContaining({ id: "memory-a", importance: 0.70 })]);
  });

  test("history rebuild 旧物理 data_type 仅接受 ledger 证明后的 memory 映射", async () => {
    const historicalMetadata = metadata("memory-a");
    const governance = historicalMetadata.governance as Record<string, unknown>;
    const native = governance.native as Record<string, unknown>;
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result([
      activeRow("memory-a", {
        data_type: "memory",
        physical_data_type: "decision",
        data_type_compatibility: "history-memory-data-type/v1",
        metadata: {
          ...historicalMetadata,
          governance: { ...governance, native: { ...native, dataType: "decision" } },
        },
      }),
    ]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));

    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    })).resolves.toEqual([expect.objectContaining({ id: "memory-a", dataType: "memory" })]);
  });

  test("receipt 指定记录缺失、重复或返回额外记录时 fail-closed", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) =>
      result([activeRow("memory-a")]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));

    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a", "memory-b"], scope, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);
    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a", "memory-a"], scope, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);

    query.mockResolvedValueOnce(result([activeRow("memory-a"), activeRow("memory-extra")]));
    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);
  });

  test("active evidenceIds 为空时保留 committed record，由派生层产出可解释 unavailable", async () => {
    const activeMetadata = metadata("memory-a", { sourceNodeIds: [] });
    const governance = activeMetadata.governance as Record<string, unknown>;
    const candidate = governance.candidate as Record<string, unknown>;
    const candidateEvidence = candidate.evidence as Record<string, unknown>;
    const row = activeRow("memory-a", {
      metadata: {
        ...activeMetadata,
        governance: {
          ...governance,
          evidenceIds: [],
          candidate: { ...candidate, evidence: { ...candidateEvidence, eventIds: [] } },
        },
      },
    });
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result([row]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));
    const records = await port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });

    expect(records[0]!.evidenceIds).toEqual([]);
    await expect(port.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledOnce();
  });

  test.each([
    ["authority scope 不一致", { project_id: "project-b" }],
    ["非 active lifecycle", { lifecycle_status: "archived" }],
    ["被 quarantine", { legacy_quarantine_reason: "legacy_scope_unknown" }],
    ["provider 未经 ledger 证明而返回 importance 空值", {
      importance: null,
      metadata: metadata("memory-a", { importance: 0.70 }),
    }],
    ["旧物理 data_type 缺少兼容证明", {
      physical_data_type: "decision",
    }],
    ["普通 memory 行伪造兼容证明", {
      data_type_compatibility: "history-memory-data-type/v1",
    }],
    ["contextEligible 镜像错误", {
      metadata: metadata("memory-a", { contextEligible: false }),
    }],
    ["MemoryKind 镜像缺失", {
      metadata: metadata("memory-a", {
        governance: {
          ...(metadata("memory-a").governance as Record<string, unknown>),
          native: { semanticType: "rules", category: "other", dataType: "memory" },
        },
      }),
    }],
    ["semanticType 双写冲突", {
      metadata: metadata("memory-a", { semanticType: "profile" }),
    }],
    ["container 双写冲突", {
      metadata: metadata("memory-a", {
        governance: {
          ...(metadata("memory-a").governance as Record<string, unknown>),
          native: {
            kind: "decision", semanticType: "rules", container: "personal",
            category: "other", dataType: "memory",
          },
        },
      }),
    }],
  ])("%s 时不允许进入派生", async (_name, rowOverrides) => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) =>
      result([activeRow("memory-a", rowOverrides)]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));

    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);
  });

  test("evidence facts 只读取 active records 声明的 evidence_only 行并核验完整 scope", async () => {
    const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) =>
      sql.includes("metadata->>'admissionRoute' = 'active'")
        ? result([activeRow("memory-a")])
        : result([evidenceRow("evidence-memory-a")])
    );
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));
    const records = await port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });

    const facts = await port.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    });

    expect(facts).toEqual([{
      evidenceId: "evidence-memory-a",
      scope,
      evidenceKind: "observation",
      label: "evidence evidence-memory-a",
      metadata: expect.objectContaining({
        admissionRoute: "evidence_only",
        eventType: "observation",
      }),
      createdAt: 900,
    }]);
    const [sql, params] = query.mock.calls[1]!;
    expect(sql).toContain("metadata->>'admissionRoute' = 'evidence_only'");
    expect(sql).toContain("metadata->>'contextEligible' = 'false'");
    expect(params?.at(-1)).toEqual(["evidence-memory-a"]);
  });

  test("回读遵循 writer 权威镜像，不要求 candidate confidence 或 native container 必然存在", async () => {
    const active = activeRow("memory-a");
    const activeMetadata = active.metadata as Record<string, unknown>;
    const activeGovernance = activeMetadata.governance as Record<string, unknown>;
    const activeCandidate = activeGovernance.candidate as Record<string, unknown>;
    delete activeCandidate.confidence;

    const evidence = evidenceRow("evidence-memory-a");
    const evidenceMetadata = evidence.metadata as Record<string, unknown>;
    const evidenceGovernance = evidenceMetadata.governance as Record<string, unknown>;
    const evidenceNative = evidenceGovernance.native as Record<string, unknown>;
    delete evidenceNative.container;

    const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) =>
      sql.includes("metadata->>'admissionRoute' = 'active'")
        ? result([active])
        : result([evidence])
    );
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));
    const records = await port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });

    await expect(port.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).resolves.toHaveLength(1);
  });

  test("显式保存 raw evidence 映射为 message，provenance session 缺省但存在时必须同 scope", async () => {
    const recordsPort = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([activeRow("memory-a")]),
    )));
    const records = await recordsPort.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });
    const explicit = explicitSaveEvidenceRow("evidence-memory-a");
    const port = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([explicit]),
    )));

    await expect(port.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).resolves.toEqual([expect.objectContaining({
      evidenceId: "evidence-memory-a",
      evidenceKind: "message",
      metadata: expect.objectContaining({ eventType: "explicit_save" }),
    })]);

    const metadata = explicit.metadata as Record<string, unknown>;
    const governance = metadata.governance as Record<string, unknown>;
    const mismatched = {
      ...explicit,
      metadata: {
        ...metadata,
        governance: {
          ...governance,
          provenance: {
            ...(governance.provenance as Record<string, unknown>),
            sessionId: "session-b",
          },
        },
      },
    };
    const mismatchedPort = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([mismatched]),
    )));
    await expect(mismatchedPort.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);
  });

  test("evidence kind 不被普通 metadata 猜测，跨 scope 或未知事件行 fail-closed", async () => {
    const recordsPort = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([activeRow("memory-a")]),
    )));
    const records = await recordsPort.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });
    const fakeKind = evidenceRow("evidence-memory-a", {
      metadata: {
        ...(evidenceRow("evidence-memory-a").metadata as Record<string, unknown>),
        evidenceKind: "message",
        eventType: "message",
      },
    });
    const port = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([fakeKind]),
    )));
    await expect(port.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);

    const crossScope = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([
        evidenceRow("evidence-memory-a", { project_id: "project-b" }),
      ]),
    )));
    await expect(crossScope.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);
  });

  test("tree facts 仅消费 validator governance 中显式、完整、可交叉核验的 envelope", async () => {
    const treeRouting = {
      version: 1,
      evidenceId: "evidence-memory-a",
      sourceId: "conversation-a",
      entityIds: ["entity-a"],
      scopeVisibility: "workspace",
      riskFlags: ["sensitive"],
      topicLabels: ["Runtime Architecture"],
      topicHotnessEligible: true,
      explicitGlobal: false,
      isWorkspaceRule: true,
    };
    const activeMetadata = metadata("memory-a");
    const governance = activeMetadata.governance as Record<string, unknown>;
    const candidate = governance.candidate as Record<string, unknown>;
    const row = activeRow("memory-a", {
      metadata: {
        ...activeMetadata,
        governance: {
          ...governance,
          candidate: { ...candidate, riskFlags: ["sensitive"], treeRouting },
        },
      },
    });
    const port = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([row]),
    )));
    const records = await port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });

    expect(await port.readTreeFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).toEqual([{
      memoryId: "memory-a",
      scope,
      evidenceId: treeRouting.evidenceId,
      sourceId: treeRouting.sourceId,
      entityIds: treeRouting.entityIds,
      scopeVisibility: treeRouting.scopeVisibility,
      riskFlags: treeRouting.riskFlags,
      topicLabels: treeRouting.topicLabels,
      topicHotnessEligible: treeRouting.topicHotnessEligible,
      explicitGlobal: treeRouting.explicitGlobal,
      isWorkspaceRule: treeRouting.isWorkspaceRule,
    }]);
  });

  test("缺失显式 tree envelope 时返回空，不从同名 metadata 或 candidate targetScope 猜路由", async () => {
    const base = metadata("memory-a", {
      topicLabels: ["must-not-use"],
      topicHotnessEligible: true,
      sourceId: "must-not-use",
      entityIds: ["must-not-use"],
    });
    const governance = base.governance as Record<string, unknown>;
    const row = activeRow("memory-a", {
      metadata: {
        ...base,
        governance: {
          ...governance,
          candidate: {
            ...(governance.candidate as Record<string, unknown>),
            targetScope: "workspace",
            riskFlags: [],
          },
        },
      },
    });
    const port = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([row]),
    )));
    const records = await port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });

    await expect(port.readTreeFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).resolves.toEqual([]);
  });

  test("aborted 读取不访问 provider", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result([]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));
    const controller = new AbortController();
    controller.abort();

    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(query).not.toHaveBeenCalled();
  });

  test("空 receipt 和空 fact batch 直接返回空且不访问 provider", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result([]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));
    const signal = abortSignal();

    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: [], scope, signal,
    })).resolves.toEqual([]);
    await expect(port.readEvidenceFacts({
      memoryIds: [], records: [], signal,
    })).resolves.toEqual([]);
    await expect(port.readTreeFacts({
      memoryIds: [], records: [], signal,
    })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test("空 receipt 仍验证完整 authority，evidence source 镜像冲突时拒绝", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => result([]));
    const port = new PostgresActiveMemoryDerivationReadPort(client(query));
    await expect(port.readCommittedActiveRecords({
      activeMemoryIds: [],
      scope: { ...scope, visibility: undefined },
      signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);

    const activePort = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([activeRow("memory-a")]),
    )));
    const records = await activePort.readCommittedActiveRecords({
      activeMemoryIds: ["memory-a"], scope, signal: abortSignal(),
    });
    const badEvidence = evidenceRow("evidence-memory-a");
    const badMetadata = badEvidence.metadata as Record<string, unknown>;
    badMetadata.sourceNodeIds = ["other-source"];
    const evidencePort = new PostgresActiveMemoryDerivationReadPort(client(vi.fn(
      async (_sql: string, _params: readonly unknown[] = []) => result([badEvidence]),
    )));
    await expect(evidencePort.readEvidenceFacts({
      memoryIds: ["memory-a"], records, signal: abortSignal(),
    })).rejects.toThrow(/active derivation read/i);
  });
});
