import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { AuthorityScope, ClientAuthorityScopeRequest } from "../../domain/authority-scope.js";
import type { MemoryScope } from "../../domain/types.js";
import type { HistoryPgClient, HistoryPgPool } from "./postgres-read.js";
import { historyPgScope, PostgresHistoryReadPort } from "./postgres-read.js";
import { historyHash, isHash, rejectHistory } from "./schema.js";
import { validateHistoryPlan, validateHistoryReceipt } from "./execution.js";
import { historyNativeEvidenceId } from "./native-materials.js";
import type { HistoryAuthorization, HistoryOperationReceipt, HistoryPlan, HistoryPlanUnit } from "./types.js";

export interface HistoryApprovedOperation {
  /** Loaded from an owner-approved immutable receipt, not an HTTP/MCP request body. */
  readonly planHash: string;
  readonly action: "apply" | "archive" | "rollback";
  readonly authorization: HistoryAuthorization;
  readonly expiresAt: number;
  readonly databaseFingerprint: string;
  readonly scopes: readonly MemoryScope[];
  readonly nativeMaterialHash: string;
}
export interface HistoryPostgresStoreOptions {
  readonly pool: HistoryPgPool;
  readonly read: PostgresHistoryReadPort;
  readonly approvedOperations: readonly HistoryApprovedOperation[];
  readonly nativeMaterialHash: string;
  readonly now?: () => number;
}
export const historyReceiptKey = (runId: string, unitId: string) => `history:p16:${historyHash({ runId, unitId })}`;

/** Owner, workspace and session coordinates belong only to serverAuthority. */
export function historyClientScope(scope: MemoryScope): ClientAuthorityScopeRequest {
  return { appId: scope.appId, projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace, visibility: scope.visibility ?? "private" };
}

export class HistoryPostgresLockedStore {
  private open = true;
  private readonly now: () => number;
  constructor(readonly client: HistoryPgClient, private readonly options: HistoryPostgresStoreOptions) { this.now = options.now ?? Date.now; }
  close() { this.open = false; }
  assertOpen() { if (!this.open) rejectHistory("HISTORY_OPERATOR_LOCK_CLOSED"); }
  /** Borrow this locked connection; native repositories still own BEGIN/COMMIT for each unit. */
  borrowedPool(): HistoryPgPool { return { connect: async () => { this.assertOpen(); return { query: this.client.query.bind(this.client), release() {} }; } }; }

  async databaseFingerprint(): Promise<string> {
    this.assertOpen();
    const result = await this.client.query(`/* history:database-identity */ SELECT current_database() AS name,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      COALESCE(inet_server_addr()::text,'unix') AS address, COALESCE(inet_server_port(),0) AS port`);
    if (result.rows.length !== 1) rejectHistory("HISTORY_DATABASE_IDENTITY_UNAVAILABLE");
    return historyHash(result.rows[0]);
  }
  async assertGates(plan: HistoryPlan, action: HistoryApprovedOperation["action"], authorization: HistoryAuthorization): Promise<void> {
    this.assertOpen(); validateHistoryPlan(plan);
    const approved = this.options.approvedOperations.find(operation => operation.planHash === plan.hash && operation.action === action && historyHash(operation.authorization) === historyHash(authorization));
    if (!approved || authorization.token !== `P16_${action.toUpperCase()}:${plan.input.runId}:${plan.hash}` ||
        [authorization.backupReceiptHash, authorization.restoreReceiptHash, authorization.rehearsalReceiptHash].some(hash => !isHash(hash)) ||
        approved.nativeMaterialHash !== this.options.nativeMaterialHash || !Number.isSafeInteger(approved.expiresAt) || approved.expiresAt <= this.now() || !isHash(approved.databaseFingerprint) || approved.databaseFingerprint !== await this.databaseFingerprint()) rejectHistory("HISTORY_APPROVED_OPERATION_REQUIRED");
    const scopes = new Set(approved.scopes.map(authorityScopeFingerprint));
    if (plan.units.some(unit => !scopes.has(unit.scopeFingerprint))) rejectHistory("HISTORY_OPERATOR_SCOPE_DENIED");
    const busy = await this.client.query(`/* history:quiescence */ SELECT count(*)::text AS count FROM mengshu_jobs_v2 WHERE status IN ('running','leased')`);
    if (busy.rows.length !== 1 || Number(busy.rows[0].count) !== 0) rejectHistory("HISTORY_QUIESCENCE_REQUIRED");
  }
  authority(plan: HistoryPlan, scope: MemoryScope): AuthorityScope {
    const fingerprint = authorityScopeFingerprint(scope);
    if (!this.options.approvedOperations.some(operation => operation.planHash === plan.hash && operation.expiresAt > this.now() && operation.scopes.some(allowed => authorityScopeFingerprint(allowed) === fingerprint))) rejectHistory("HISTORY_OPERATOR_SCOPE_DENIED");
    return { tenantId: scope.tenantId, userId: scope.userId, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      allow: { appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId], namespaces: [scope.namespace], visibilities: [scope.visibility ?? "private"] } };
  }

  async readReceipt(plan: HistoryPlan, unit: HistoryPlanUnit): Promise<HistoryOperationReceipt | undefined> {
    this.assertOpen();
    const result = await this.client.query(`/* history:receipt-read */ SELECT request_hash,receipt FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND idempotency_key=$2`, [unit.scopeFingerprint, historyReceiptKey(plan.input.runId, unit.id)]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.request_hash !== plan.hash) rejectHistory("HISTORY_RECEIPT_CONFLICT");
    const receipt = row.receipt as HistoryOperationReceipt;
    validateHistoryReceipt(plan, unit, receipt, receipt.status);
    return receipt;
  }
  async saveReceipt(plan: HistoryPlan, unit: HistoryPlanUnit, receipt: HistoryOperationReceipt): Promise<void> {
    this.assertOpen(); validateHistoryReceipt(plan, unit, receipt, receipt.status);
    if (Buffer.byteLength(JSON.stringify(receipt)) > 30000) rejectHistory("HISTORY_RECEIPT_BUDGET");
    const result = await this.client.query(`/* history:receipt-write */ INSERT INTO mengshu_evolution_operation_receipts
      (scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT (scope_fingerprint,idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [unit.scopeFingerprint, historyReceiptKey(plan.input.runId, unit.id), plan.hash, `history_${unit.phase}`, JSON.stringify(receipt), this.now()]);
    if (result.rows.length !== 1) rejectHistory("HISTORY_RECEIPT_CONFLICT");
  }
  async registerRun(plan: HistoryPlan): Promise<void> {
    this.assertOpen();
    const rows = await this.client.query(`/* history:register-run */ INSERT INTO mengshu_markdown_migration_runs
      (run_id,source_manifest_sha256,source_snapshot_sha256,governed_manifest_sha256,governed_snapshot_sha256,verification_sha256,policy_version,status,source_count,mapped_count,staged_live_count,prepared_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'prepared',$8,0,0,$9,$9)
      ON CONFLICT (run_id) DO UPDATE SET run_id=EXCLUDED.run_id
      WHERE mengshu_markdown_migration_runs.governed_snapshot_sha256=EXCLUDED.governed_snapshot_sha256
      AND mengshu_markdown_migration_runs.source_manifest_sha256=EXCLUDED.source_manifest_sha256 RETURNING run_id`,
    [plan.input.runId, plan.input.sourceManifestHash, plan.witnessHash, plan.input.governanceManifestHash, plan.hash, plan.auditHash, plan.input.policyVersion, plan.input.expected.sources, this.now()]);
    if (rows.rows.length !== 1) rejectHistory("HISTORY_RUN_CONFLICT");
  }

  async lockSources(plan: HistoryPlan, unit: HistoryPlanUnit): Promise<void> {
    this.assertOpen();
    for (const source of unit.sources) {
      const [table, ...parts] = source.sourceRef.split(":"), id = parts.join(":");
      if (!["memories", "knowledge"].includes(table) || !id) rejectHistory("HISTORY_SOURCE_INVALID");
      const row = (await this.client.query(`/* history:source-lock */ SELECT xmin::text AS revision,
        encode(sha256(convert_to(to_jsonb(m.*)::text,'UTF8')),'hex') AS row_hash,
        COALESCE(metadata->>'pinned','false') AS pinned, lifecycle_status,
        tenant_id,user_id,product_id,canonical_project_id,producer_id,namespace,visibility,workspace_id,metadata->>'sessionId' AS session_id
        FROM ${table} m WHERE id::text=$1 FOR UPDATE`, [id])).rows[0];
      if (!row || row.revision !== source.currentRevision || row.row_hash !== source.currentRowHash || authorityScopeFingerprint(historyPgScope(row)) !== source.scopeFingerprint || row.pinned === "true" || ["revoked", "superseded"].includes(String(row.lifecycle_status))) rejectHistory("HISTORY_SOURCE_CAS_FAILED");
      const original = (await this.client.query(`/* history:source-parent-mapping */ SELECT source_hash,mapping_sha256 FROM mengshu_markdown_migration_mappings WHERE run_id=$1 AND source_ref=$2`, [plan.input.parentRunId, source.sourceRef])).rows[0];
      if (!original || original.source_hash !== source.sourceHash || original.mapping_sha256 !== source.mappingHash) rejectHistory("HISTORY_PARENT_MAPPING_DRIFT");
    }
  }
  async snapshotBefore(plan: HistoryPlan, table: "memories" | "knowledge", id: string): Promise<string> {
    this.assertOpen();
    if (!["memories", "knowledge"].includes(table)) rejectHistory("HISTORY_SOURCE_INVALID");
    const result = await this.client.query(`/* history:before-image */ INSERT INTO mengshu_markdown_migration_before_rows
      (run_id,source_table,record_id,row_sha256,row_payload,captured_at)
      SELECT $1,$2,$3,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),payload,$4 FROM (
        SELECT COALESCE((SELECT to_jsonb(m.*) FROM ${table} m WHERE id::text=$3),'{"absent":true}'::jsonb) AS payload
      ) original ON CONFLICT (run_id,source_table,record_id) DO NOTHING RETURNING row_sha256`, [plan.input.runId, table, id, this.now()]);
    const current = result.rows[0] ?? (await this.client.query(`/* history:before-image-read */ SELECT row_sha256 FROM mengshu_markdown_migration_before_rows WHERE run_id=$1 AND source_table=$2 AND record_id=$3`, [plan.input.runId, table, id])).rows[0];
    if (!current || !isHash(current.row_sha256)) rejectHistory("HISTORY_BEFORE_IMAGE_FAILED");
    return current.row_sha256;
  }
  async conservation(plan: HistoryPlan): Promise<{ mappingsComplete: boolean; outsideCohortUnchanged: boolean; unrelatedQueueUnchanged: boolean }> {
    const reader = new PostgresHistoryReadPort(this.client, this.options.read.bundle, plan.input, plan.units.filter(unit => unit.phase === "evidence").map(unit => historyNativeEvidenceId(plan, unit)));
    const parent = await reader.readParent(plan.input);
    return { mappingsComplete: parent.receiptHash === plan.input.parentReceiptHash && parent.sources === plan.input.expected.sources && parent.mappings === plan.input.expected.sources,
      outsideCohortUnchanged: parent.outsideCohortRows === plan.outsideCohortRows && parent.outsideCohortHash === plan.outsideCohortHash, unrelatedQueueUnchanged: parent.unrelatedQueueHash === plan.unrelatedQueueHash };
  }
}

export async function withHistoryPostgresLock<T>(options: HistoryPostgresStoreOptions, input: { runId: string; parentRunId: string; planHash: string }, work: (store: HistoryPostgresLockedStore) => Promise<T>): Promise<T> {
  const client = await options.pool.connect(); let locked = false;
  const store = new HistoryPostgresLockedStore(client, options);
  const key = `history-p16:${input.parentRunId}`;
  try {
    const result = await client.query(`/* history:operator-lock */ SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`, [key]);
    if (result.rows[0]?.acquired !== true) rejectHistory("HISTORY_OPERATOR_BUSY");
    locked = true;
    await client.query("SELECT set_config('default_transaction_isolation','serializable',false)");
    return await work(store);
  } finally {
    store.close();
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
    finally { try { await client.query("RESET default_transaction_isolation"); } finally { client.release(); } }
  }
}
