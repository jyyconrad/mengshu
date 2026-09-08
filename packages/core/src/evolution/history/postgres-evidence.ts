import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { validateHistoryBinding } from "./audit.js";
import { historyContentSha256 } from "./native-materials.js";
import { historyHash, rejectHistory } from "./schema.js";
import type { HistoryPlan, HistoryPlanUnit } from "./types.js";
import { HistoryPostgresLockedStore } from "./postgres-store.js";
import type { MemoryRecord } from "../../domain/types.js";
import type { HistoryPgClient } from "./postgres-read.js";
import type { HistorySourceWitness } from "./types.js";

/** The native schema requires a vector even for non-searchable raw evidence. */
export async function insertHistoryRawEvidence(client: HistoryPgClient, memory: MemoryRecord, source: HistorySourceWitness, metadata: Readonly<Record<string, unknown>>, now: number): Promise<void> {
  const table = source.sourceRef.startsWith("memories:") ? "memories" : source.sourceRef.startsWith("knowledge:") ? "knowledge" : undefined;
  if (!table || !source.currentRevision || memory.kind !== "observation" || memory.container !== "session_candidate" || memory.lifecycleStatus !== "archived" || metadata.admissionRoute !== "evidence_only" || metadata.contextEligible !== false || authorityScopeFingerprint(memory.scope) !== source.scopeFingerprint) rejectHistory("HISTORY_RAW_RECORD_INVALID");
  const scope = memory.scope;
  // Copy an opaque storage carrier inside SQL, not an embedding of the excerpt. Never mark it queryable.
  const storedMetadata = { ...metadata, embeddingSpaceId: null, embeddingSpaceState: "unknown-unqueryable" };
  const inserted = await client.query(`/* history:native-raw-insert */ INSERT INTO memories(id,text,content_hash,vector,importance,category,data_type,metadata,created_at,tenant_id,user_id,canonical_project_id,product_id,producer_id,namespace,visibility,workspace_id,lifecycle_status,scope_key,embedding_space_id,embedding_space_state)
    SELECT $1,$2,$3,original.vector,$4,$5,'memory',$6::jsonb,to_timestamp($7::double precision/1000),$8,$9,$10,$11,$12,$13,$14,$15,'archived',$16,NULL,'unknown-unqueryable'
    FROM ${table} original WHERE original.id::text=$17 AND original.xmin::text=$18 AND original.vector IS NOT NULL
      AND original.tenant_id=$8 AND original.user_id=$9 AND original.canonical_project_id=$10 AND original.product_id=$11 AND original.producer_id=$12 AND original.namespace=$13 AND original.visibility=$14
      AND COALESCE(original.workspace_id,'')=COALESCE($15::text,'') AND COALESCE(original.metadata->>'sessionId','')=$19
    RETURNING id::text AS id`, [memory.id, memory.text, memory.contentHash, memory.importance, memory.category, JSON.stringify(storedMetadata), now, scope.tenantId, scope.userId, scope.projectId, scope.appId, scope.agentId, scope.namespace, scope.visibility ?? "private", scope.workspaceId ?? null, source.scopeFingerprint, source.sourceRef.slice(table.length + 1), source.currentRevision, scope.sessionId ?? ""]);
  if (inserted.rows.length !== 1 || inserted.rows[0]?.id !== memory.id) rejectHistory("HISTORY_RAW_INSERT_FAILED");
}

/** Read only reviewed ranges. No source transcript/full text is returned by this query. */
export async function readHistoryAnchoredEvidence(store: HistoryPostgresLockedStore, plan: HistoryPlan, unit: HistoryPlanUnit): Promise<string> {
  if (!unit.target || !unit.bindings.length || unit.bindings.length > 128 || authorityScopeFingerprint(unit.target.scope) !== unit.scopeFingerprint) rejectHistory("HISTORY_EVIDENCE_UNIT_INVALID");
  let bytes = 0; const excerpts = new Map<string, string>();
  for (const binding of unit.bindings) {
    validateHistoryBinding(binding);
    if (!binding.anchor || binding.scopeFingerprint !== unit.scopeFingerprint) rejectHistory("HISTORY_ANCHOR_REQUIRED");
    const anchor = binding.anchor, length = anchor.utf8ByteEnd - anchor.utf8ByteStart;
    if (length > 16384 || (bytes += length) > 65536) rejectHistory("HISTORY_EVIDENCE_BYTE_BUDGET");
    const source = unit.sources.find(source => source.sourceRef === binding.sourceRef);
    if (!source || source.sourceHash !== binding.sourceHash) rejectHistory("HISTORY_EVIDENCE_SOURCE_MISMATCH");
    const table = source.sourceRef.startsWith("memories:") ? "memories" : "knowledge", id = source.sourceRef.slice(table.length + 1);
    const result = await store.client.query(`/* history:anchored-evidence */ SELECT
      substring(convert_to(text,'UTF8') FROM $2::integer + 1 FOR $3::integer) AS excerpt,
      octet_length(convert_to(text,'UTF8')) AS total_bytes
      FROM ${table} WHERE id::text=$1 AND xmin::text=$4`, [id, anchor.utf8ByteStart, length, source.currentRevision]);
    const row = result.rows[0];
    if (!row || !Buffer.isBuffer(row.excerpt) || row.excerpt.length !== length || Number(row.total_bytes) < anchor.utf8ByteEnd || historyContentSha256(row.excerpt) !== anchor.excerptHash) rejectHistory("HISTORY_EVIDENCE_ANCHOR_DRIFT");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(row.excerpt); } catch { return rejectHistory("HISTORY_EVIDENCE_UTF8_INVALID"); }
    excerpts.set(historyHash([binding.sourceRef, anchor]), text);
  }
  return [...excerpts.values()].join("\n\n");
}
