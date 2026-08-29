import { describe, expect, test } from "vitest";

import {
  MarkdownWorksetImporter,
  markdownWorksetActivationConfirmationToken,
  markdownWorksetRollbackConfirmationToken,
  prepareMarkdownWorksetImport,
  type MarkdownWorksetImportActivationReceipt,
} from "../packages/core/src/db/migrations/markdown-workset-importer.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetSnapshotSha256,
  renderNativeRecordMarkdown,
  type MarkdownWorksetNativeRecord,
} from "../packages/core/src/db/migrations/markdown-workset.js";
import {
  PostgresMarkdownWorksetImportActivationPort,
  PostgresMarkdownWorksetImportError,
  type PostgresMarkdownWorksetImportPool,
  type PostgresMarkdownWorksetImportPoolClient,
  type PostgresMarkdownWorksetImportQueryResult,
} from "./postgres-markdown-workset-import.js";

const SOURCE_MANIFEST_HASH = "d".repeat(64);
const FIXED_NOW = Date.parse("2026-08-28T08:00:00.000Z");
const FIXED_ISO = new Date(FIXED_NOW).toISOString();

function nativeRecord(index: number): MarkdownWorksetNativeRecord {
  return {
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-${String(index).padStart(12, "0")}`,
    sourceTable: index === 2 ? "knowledge" : "memories",
    text: `governed source ${index}`,
    contentHash: `legacy-content-${index}`,
    vector: [index / 10, 0.25, -0.5],
    importance: index === 2 ? 0.6 : 0.8,
    category: "fact",
    dataType: index === 2 ? "knowledge" : "memory",
    metadata: { index, nested: { b: 2, a: 1 } },
    createdAt: `2026-08-28T0${index}:00:00.000Z`,
    projectName: "memory-autodb",
    appName: "codex",
  };
}

function sourceRef(record: MarkdownWorksetNativeRecord): string {
  return `${record.sourceTable}:${record.id}`;
}

function databaseRow(record: MarkdownWorksetNativeRecord): Record<string, unknown> {
  return {
    id: record.id,
    text: record.text,
    content_hash: record.contentHash,
    vector: `[${record.vector.join(",")}]`,
    importance: record.importance,
    category: record.category,
    data_type: record.dataType,
    metadata: record.metadata,
    created_at: record.createdAt,
    project_name: record.projectName ?? null,
    app_name: record.appName ?? null,
    user_id: record.userId ?? null,
    agent_id: record.agentId ?? null,
    workspace_id: record.workspaceId ?? null,
    tenant_id: record.tenantId ?? null,
    canonical_project_id: record.canonicalProjectId ?? null,
    product_id: record.productId ?? null,
    producer_id: record.producerId ?? null,
    namespace: record.namespace ?? null,
    visibility: record.visibility ?? null,
    lifecycle_status: record.lifecycleStatus ?? null,
    embedding_space_id: record.embeddingSpaceId ?? null,
    embedding_space_state: record.embeddingSpaceState ?? null,
    legacy_quarantine_reason: record.legacyQuarantineReason ?? null,
    scope_key: record.scopeKey ?? null,
  };
}

function fixture() {
  const keep = nativeRecord(1);
  const archive = nativeRecord(2);
  const records = [
    createMarkdownWorksetRecord({
      phase: "governed",
      disposition: "canonical_keep",
      canonicalTargetRef: sourceRef(keep),
      policyVersion: "history-curation/v1",
      record: keep,
    }),
    createMarkdownWorksetRecord({
      phase: "governed",
      disposition: "archive_stale",
      policyVersion: "history-curation/v1",
      record: archive,
    }),
  ];
  const files = records.map((record, index) => ({
    relativePath: `governed/${index + 1}.md`,
    markdown: renderNativeRecordMarkdown(record),
  }));
  const manifest = createMarkdownWorksetManifest({
    migrationRunId: "postgres-markdown-import-001",
    phase: "governed",
    policyVersion: "history-curation/v1",
    createdAt: "2026-08-28T07:00:00.000Z",
    files,
  });
  const plan = prepareMarkdownWorksetImport({ mode: "prepare", manifest, files });
  const currentRecords = [keep, archive].map((record) => createMarkdownWorksetRecord({
    phase: "source",
    record,
  }));
  return {
    plan,
    raw: {
      memories: [databaseRow(keep)],
      knowledge: [databaseRow(archive)],
    },
    currentSnapshotHash: markdownWorksetSnapshotSha256(currentRecords),
  };
}

interface FakeReceiptRow {
  readonly activation_id: string;
  readonly run_id: string;
  readonly operation: "activate" | "rollback";
  readonly request_hash: string;
  readonly source_manifest_sha256: string;
  readonly governed_manifest_sha256: string;
  readonly verification_sha256: string;
  readonly before_snapshot_sha256: string;
  readonly after_snapshot_sha256: string;
  readonly confirmation_hash: string;
  readonly result: unknown;
  readonly created_at: string;
}

interface FakeState {
  memories: Record<string, unknown>[];
  knowledge: Record<string, unknown>[];
  runs: Map<string, Record<string, unknown>>;
  beforeRows: Array<Record<string, unknown>>;
  stagedRows: Array<Record<string, unknown>>;
  mappings: Array<Record<string, unknown>>;
  receipts: FakeReceiptRow[];
}

function cloneState(state: FakeState): FakeState {
  return structuredClone(state);
}

class FakePoolClient implements PostgresMarkdownWorksetImportPoolClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  releaseCount = 0;
  state: FakeState;
  private backup?: FakeState;
  driftOnTableLock = false;
  corruptStageHash = false;
  corruptReadback = false;
  failLiveInsert = false;
  corruptReceipt = false;
  private replaced = false;

  constructor(raw: { memories: Record<string, unknown>[]; knowledge: Record<string, unknown>[] }) {
    this.state = {
      memories: structuredClone(raw.memories),
      knowledge: structuredClone(raw.knowledge),
      runs: new Map(),
      beforeRows: [],
      stagedRows: [],
      mappings: [],
      receipts: [],
    };
  }

  release(): void {
    this.releaseCount += 1;
  }

  async query(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresMarkdownWorksetImportQueryResult> {
    this.calls.push({ sql, params });
    const tagged = (tag: string) => sql.includes(`/* markdown-workset-import:${tag} */`);
    if (sql === "BEGIN ISOLATION LEVEL SERIALIZABLE") {
      this.backup = cloneState(this.state);
      return { rows: [], rowCount: null };
    }
    if (sql === "COMMIT") {
      this.backup = undefined;
      return { rows: [], rowCount: null };
    }
    if (sql === "ROLLBACK") {
      if (this.backup) this.state = this.backup;
      this.backup = undefined;
      return { rows: [], rowCount: null };
    }
    if (tagged("run-lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (tagged("receipt-read")) {
      const [runId, operation] = params;
      const rows = this.state.receipts.filter((row) =>
        row.run_id === runId && row.operation === operation);
      return { rows, rowCount: rows.length };
    }
    if (tagged("read-memories") || tagged("read-knowledge")) {
      const table = tagged("read-memories") ? "memories" : "knowledge";
      const rows = structuredClone(this.state[table]);
      if (this.corruptReadback && this.replaced && table === "memories" && rows[0]) {
        rows[0].text = "corrupted after insert";
      }
      return { rows: rows.map((row) => ({ row_payload: row })), rowCount: rows.length };
    }
    if (tagged("run-insert")) {
      const [runId, sourceManifest, sourceSnapshot, governedManifest, governedSnapshot,
        verification, policyVersion, sourceCount, mappedCount, liveCount, now] = params;
      if (!this.state.runs.has(String(runId))) {
        this.state.runs.set(String(runId), {
          run_id: runId,
          source_manifest_sha256: sourceManifest,
          source_snapshot_sha256: sourceSnapshot,
          governed_manifest_sha256: governedManifest,
          governed_snapshot_sha256: governedSnapshot,
          verification_sha256: verification,
          policy_version: policyVersion,
          status: "staging",
          source_count: String(sourceCount),
          mapped_count: String(mappedCount),
          staged_live_count: String(liveCount),
          prepared_at: String(now),
          updated_at: String(now),
        });
        return { rows: [{ run_id: runId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (tagged("run-read")) {
      const row = this.state.runs.get(String(params[0]));
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (tagged("before-insert")) {
      const [runId, sourceTable, recordId, rowHash, payload, capturedAt] = params;
      const exists = this.state.beforeRows.some((row) =>
        row.run_id === runId && row.source_table === sourceTable && row.record_id === recordId);
      if (!exists) this.state.beforeRows.push({
        run_id: runId, source_table: sourceTable, record_id: recordId,
        row_sha256: rowHash, row_payload: JSON.parse(String(payload)), captured_at: String(capturedAt),
      });
      return { rows: exists ? [] : [{ record_id: recordId }], rowCount: exists ? 0 : 1 };
    }
    if (tagged("before-read")) {
      const rows = this.state.beforeRows.filter((row) => row.run_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (tagged("stage-insert")) {
      const [runId, sourceTable, recordId, sourceReference, sourceHash, rowHash,
        payload, createdAt] = params;
      const exists = this.state.stagedRows.some((row) =>
        row.run_id === runId && row.source_ref === sourceReference);
      if (!exists) this.state.stagedRows.push({
        run_id: runId, source_table: sourceTable, record_id: recordId,
        source_ref: sourceReference, source_hash: sourceHash, row_sha256: rowHash,
        row_payload: JSON.parse(String(payload)), created_at: String(createdAt),
      });
      return { rows: exists ? [] : [{ source_ref: sourceReference }], rowCount: exists ? 0 : 1 };
    }
    if (tagged("mapping-insert")) {
      const [runId, sourceReference, sourceHash, scopeFingerprint, disposition,
        canonicalTarget, reasonCode, mappingHash, createdAt] = params;
      const exists = this.state.mappings.some((row) =>
        row.run_id === runId && row.source_ref === sourceReference);
      if (!exists) this.state.mappings.push({
        run_id: runId, source_ref: sourceReference, source_hash: sourceHash,
        scope_fingerprint: scopeFingerprint, disposition, canonical_target_ref: canonicalTarget,
        reason_code: reasonCode, mapping_sha256: mappingHash, created_at: String(createdAt),
      });
      return { rows: exists ? [] : [{ source_ref: sourceReference }], rowCount: exists ? 0 : 1 };
    }
    if (tagged("stage-read")) {
      const rows = this.state.stagedRows.filter((row) => row.run_id === params[0]);
      const result = structuredClone(rows);
      if (this.corruptStageHash && result[0]) result[0].row_sha256 = "f".repeat(64);
      return { rows: result, rowCount: result.length };
    }
    if (tagged("mapping-read")) {
      const rows = this.state.mappings.filter((row) => row.run_id === params[0]);
      return { rows: structuredClone(rows), rowCount: rows.length };
    }
    if (tagged("run-verified")) return { rows: [{ run_id: params[0] }], rowCount: 1 };
    if (tagged("table-lock")) {
      if (this.driftOnTableLock) {
        this.state.memories.push(databaseRow(nativeRecord(3)));
        this.driftOnTableLock = false;
      }
      return { rows: [], rowCount: null };
    }
    if (tagged("delete-memories")) {
      this.state.memories = [];
      this.replaced = true;
      return { rows: [], rowCount: 0 };
    }
    if (tagged("delete-knowledge")) {
      this.state.knowledge = [];
      this.replaced = true;
      return { rows: [], rowCount: 0 };
    }
    if (tagged("insert-memories") || tagged("insert-knowledge")) {
      if (this.failLiveInsert) throw new Error("injected live insert failure");
      const row = {
        id: params[0], text: params[1], content_hash: params[2], vector: params[3],
        importance: params[4], category: params[5], data_type: params[6],
        metadata: JSON.parse(String(params[7])), created_at: params[8], project_name: params[9],
        app_name: params[10], user_id: params[11], agent_id: params[12], workspace_id: params[13],
        tenant_id: params[14], canonical_project_id: params[15], product_id: params[16],
        producer_id: params[17], namespace: params[18], visibility: params[19],
        lifecycle_status: params[20], embedding_space_id: params[21],
        embedding_space_state: params[22], legacy_quarantine_reason: params[23], scope_key: params[24],
      };
      const table = tagged("insert-memories") ? "memories" : "knowledge";
      this.state[table].push(row);
      return { rows: [{ id: params[0] }], rowCount: 1 };
    }
    if (tagged("receipt-insert")) {
      const [activationId, runId, operation, requestHash, sourceManifest,
        governedManifest, verification, beforeSnapshot, afterSnapshot,
        confirmationHash, result, createdAt] = params;
      const decodedResult = JSON.parse(String(result)) as Record<string, unknown>;
      if (this.corruptReceipt) decodedResult.requestHash = "f".repeat(64);
      const row: FakeReceiptRow = {
        activation_id: String(activationId), run_id: String(runId),
        operation: operation as "activate" | "rollback", request_hash: String(requestHash),
        source_manifest_sha256: String(sourceManifest), governed_manifest_sha256: String(governedManifest),
        verification_sha256: String(verification), before_snapshot_sha256: String(beforeSnapshot),
        after_snapshot_sha256: String(afterSnapshot), confirmation_hash: String(confirmationHash),
        result: decodedResult, created_at: String(createdAt),
      };
      this.state.receipts.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }
    if (tagged("run-activated") || tagged("run-rolled-back")) {
      return { rows: [{ run_id: params[0] }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class FakePool implements PostgresMarkdownWorksetImportPool {
  connectCount = 0;
  constructor(readonly client: FakePoolClient) {}
  async connect(): Promise<PostgresMarkdownWorksetImportPoolClient> {
    this.connectCount += 1;
    return this.client;
  }
}

function harness() {
  const data = fixture();
  const client = new FakePoolClient(data.raw);
  const pool = new FakePool(client);
  const port = new PostgresMarkdownWorksetImportActivationPort(pool, {
    sourceManifestHash: SOURCE_MANIFEST_HASH,
    sourceSnapshotHash: data.plan.sourceSnapshotHash,
    clock: () => FIXED_NOW,
  });
  const importer = new MarkdownWorksetImporter(port, () => FIXED_ISO);
  const activationInput = {
    plan: data.plan,
    maintenanceMode: true,
    quiescenceConfirmed: true,
    manifestHash: data.plan.manifestHash,
    verifyHash: data.plan.verifyHash,
    expectedCurrentSnapshotHash: data.currentSnapshotHash,
    idempotencyKey: "postgres-activate-001",
    confirmationToken: markdownWorksetActivationConfirmationToken({
      plan: data.plan,
      expectedCurrentSnapshotHash: data.currentSnapshotHash,
    }),
  };
  return { ...data, client, pool, port, importer, activationInput };
}

async function activate(h: ReturnType<typeof harness>): Promise<MarkdownWorksetImportActivationReceipt> {
  return h.importer.activate(h.activationInput);
}

describe("PostgreSQL Markdown workset activation adapter", () => {
  test("非法 provenance 或缺少 run-lock 上下文时在连接/SQL 前拒绝", async () => {
    const h = harness();
    expect(() => new PostgresMarkdownWorksetImportActivationPort(h.pool, {
      sourceManifestHash: "invalid",
      sourceSnapshotHash: h.plan.sourceSnapshotHash,
    })).toThrowError(PostgresMarkdownWorksetImportError);
    await expect(h.port.transaction(async () => undefined))
      .rejects.toMatchObject({ code: "POSTGRES_MARKDOWN_IMPORT_CONTEXT_REQUIRED" });
    expect(h.pool.connectCount).toBe(0);
    expect(h.client.calls).toEqual([]);
  });

  test("dedicated client + SERIALIZABLE + advisory lock，before/stage/mapping 验证后才原子替换", async () => {
    const h = harness();

    const receipt = await activate(h);

    expect(receipt.kind).toBe("activate");
    expect(h.pool.connectCount).toBe(1);
    expect(h.client.releaseCount).toBe(1);
    expect(h.client.state.beforeRows).toHaveLength(2);
    expect(h.client.state.stagedRows).toHaveLength(1);
    expect(h.client.state.mappings).toHaveLength(2);
    expect(h.client.state.memories).toHaveLength(1);
    expect(h.client.state.knowledge).toHaveLength(0);
    expect(h.client.state.receipts).toHaveLength(1);

    const sql = h.client.calls.map((call) => call.sql);
    const position = (marker: string) => sql.findIndex((item) => item.includes(marker));
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(position("pg_advisory_xact_lock")).toBeGreaterThan(0);
    expect(position("run-insert")).toBeLessThan(position("before-insert"));
    expect(position("before-insert")).toBeLessThan(position("stage-insert"));
    expect(position("stage-read")).toBeLessThan(position("table-lock"));
    expect(position("table-lock")).toBeLessThan(position("delete-memories"));
    expect(position("delete-knowledge")).toBeLessThan(position("insert-memories"));
    expect(position("insert-memories")).toBeLessThan(position("receipt-insert"));
    expect(sql.at(-1)).toBe("COMMIT");

    const insert = h.client.calls.find((call) => call.sql.includes("insert-memories"));
    expect(insert?.sql).toContain("vector");
    expect(insert?.sql).toContain("legacy_quarantine_reason");
    expect(insert?.params[3]).toBe("[0.1,0.25,-0.5]");
  });

  test("相同 receipt 精确重放不再读取或替换主表", async () => {
    const h = harness();
    const first = await activate(h);
    const callCount = h.client.calls.length;

    await expect(activate(h)).resolves.toEqual(first);

    const replaySql = h.client.calls.slice(callCount).map((call) => call.sql);
    expect(replaySql).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(replaySql.some((sql) => sql.includes("receipt-read"))).toBe(true);
    expect(replaySql.some((sql) => sql.includes("table-lock"))).toBe(false);
    expect(replaySql.at(-1)).toBe("COMMIT");
  });

  test("rollback 使用已验证 before-image 恢复两张主表并写 exact receipt", async () => {
    const h = harness();
    const activationReceipt = await activate(h);
    const rollbackInput = {
      activationReceipt,
      maintenanceMode: true,
      quiescenceConfirmed: true,
      expectedCurrentSnapshotHash: activationReceipt.afterSnapshot.snapshotHash,
      idempotencyKey: "postgres-rollback-001",
      confirmationToken: markdownWorksetRollbackConfirmationToken({
        activationReceipt,
        expectedCurrentSnapshotHash: activationReceipt.afterSnapshot.snapshotHash,
      }),
    };

    const rollbackReceipt = await h.importer.rollback(rollbackInput);

    expect(rollbackReceipt.kind).toBe("rollback");
    expect(h.client.state.memories).toHaveLength(1);
    expect(h.client.state.knowledge).toHaveLength(1);
    expect(h.client.state.receipts.map((row) => row.operation)).toEqual(["activate", "rollback"]);
    expect(h.client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("table-lock 后 snapshot CAS 漂移时在 DELETE 前 rollback", async () => {
    const h = harness();
    h.client.driftOnTableLock = true;

    await expect(activate(h)).rejects.toBeInstanceOf(PostgresMarkdownWorksetImportError);

    const sql = h.client.calls.map((call) => call.sql);
    expect(sql.some((item) => item.includes("delete-memories"))).toBe(false);
    expect(sql.at(-1)).toBe("ROLLBACK");
    expect(h.client.state.memories).toHaveLength(1);
    expect(h.client.state.knowledge).toHaveLength(1);
    expect(h.client.state.receipts).toHaveLength(0);
  });

  test.each([
    "corruptStageHash",
    "corruptReadback",
    "failLiveInsert",
    "corruptReceipt",
  ] as const)("%s 故障导致整笔事务 rollback，无 receipt 或主表半成品", async (fault) => {
    const h = harness();
    h.client[fault] = true;

    await expect(activate(h)).rejects.toBeDefined();

    expect(h.client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(h.client.state.memories).toHaveLength(1);
    expect(h.client.state.knowledge).toHaveLength(1);
    expect(h.client.state.receipts).toHaveLength(0);
  });

  test("SQL 仅使用静态 allowlist 表，且无 TRUNCATE/DROP/RENAME/动态标识符", async () => {
    const h = harness();
    await activate(h);

    const sql = h.client.calls.map((call) => call.sql).join("\n");
    expect(sql).not.toMatch(/\b(?:TRUNCATE|DROP|RENAME)\b/i);
    expect(sql).not.toMatch(/\bsession_id\b/i);
    expect(sql).not.toContain("${");
    const mutationTables = [...sql.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM|LOCK TABLE)\s+([a-z_]+)/gi)]
      .map((match) => match[1]);
    expect(new Set(mutationTables)).toEqual(new Set([
      "memories",
      "knowledge",
      "mengshu_markdown_migration_runs",
      "mengshu_markdown_migration_staged_rows",
      "mengshu_markdown_migration_mappings",
      "mengshu_markdown_migration_before_rows",
      "mengshu_markdown_migration_activation_receipts",
    ]));
  });
});
