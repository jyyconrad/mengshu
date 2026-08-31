export interface PostgresDerivedPurgeQueryResult {
  readonly rowCount?: number | null;
  readonly rows: readonly Record<string, unknown>[];
}

export interface PostgresDerivedPurgeClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresDerivedPurgeQueryResult>;
  release(): void;
}

export interface PostgresDerivedPurgePool {
  connect(): Promise<PostgresDerivedPurgeClient>;
}

export class PostgresTemporalDerivedPurgeError extends Error {
  override readonly name = "PostgresTemporalDerivedPurgeError";

  constructor(readonly code: string) {
    super(code);
  }
}

async function deleteRows(
  client: PostgresDerivedPurgeClient,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  const result = await client.query(sql, params);
  return result.rowCount ?? result.rows.length;
}

/**
 * 擦除可从 temporal version 正文重建的派生内容。调用方先把 lineage 标为
 * purge_pending；本事务任一步失败都会回滚，repository 保持 pending 并等待重试。
 */
export async function purgePostgresTemporalDerivedArtifacts(
  pool: PostgresDerivedPurgePool,
  input: {
    readonly versionIds: readonly string[];
    readonly lineageId: string;
    readonly scopeFingerprint: string;
  },
): Promise<number> {
  if (input.versionIds.length === 0 ||
      new Set(input.versionIds).size !== input.versionIds.length ||
      !/^[0-9a-f]{64}$/.test(input.scopeFingerprint) ||
      !input.lineageId || /[\s\p{Cc}]/u.test(input.lineageId)) {
    throw new Error("TEMPORAL_DERIVED_PURGE_INVALID");
  }
  const client = await pool.connect();
  let purged = 0;
  let stage = "begin";
  try {
    stage = "begin";
    await client.query("BEGIN");
    stage = "advisory_lock";
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `memory-derived-purge:${input.scopeFingerprint}:${input.lineageId}`,
    ]);
    stage = "temp_asset_ids";
    await client.query(`CREATE TEMP TABLE mengshu_purge_asset_ids (
      scope_fingerprint TEXT NOT NULL, asset_id TEXT NOT NULL,
      PRIMARY KEY (scope_fingerprint, asset_id)
    ) ON COMMIT DROP`);
    stage = "temp_skill_ids";
    await client.query(`CREATE TEMP TABLE mengshu_purge_skill_ids (
      scope_fingerprint TEXT NOT NULL, skill_id TEXT NOT NULL,
      PRIMARY KEY (scope_fingerprint, skill_id)
    ) ON COMMIT DROP`);
    stage = "collect_assets";
    await client.query(`/* temporal-derived-purge:collect-assets */
INSERT INTO mengshu_purge_asset_ids
SELECT DISTINCT scope_fingerprint, asset_id FROM mengshu_asset_versions
WHERE scope_fingerprint = $2
  AND descriptor->'contentRef'->'recordIds' ?| $1::text[]`, [
      input.versionIds, input.scopeFingerprint,
    ]);
    stage = "collect_skills";
    await client.query(`/* temporal-derived-purge:collect-skills */
INSERT INTO mengshu_purge_skill_ids
SELECT DISTINCT scope_fingerprint, skill_id FROM mengshu_skill_asset_versions
WHERE scope_fingerprint = $2
  AND artifact->'evidenceMemoryIds' ?| $1::text[]`, [
      input.versionIds, input.scopeFingerprint,
    ]);

    const textParams = [input.versionIds, input.scopeFingerprint] as const;
    stage = "memory_links";
    purged += await deleteRows(client, `/* temporal-derived-purge:memory-links */
DELETE FROM mengshu_memory_evidence_links
WHERE scope_fingerprint = $2
  AND (target_memory_id = ANY($1::text[]) OR evidence_memory_id = ANY($1::text[]))`, textParams);
    for (const [tag, table] of [
      ["entity-evidence", "mengshu_graph_entity_evidence"],
      ["relation-evidence", "mengshu_graph_relation_evidence"],
      ["entity-aliases", "mengshu_graph_entity_aliases"],
      ["entity-resolution", "mengshu_graph_entity_resolution_ledger"],
      ["relation-resolution", "mengshu_graph_relation_resolution_ledger"],
    ] as const) {
      stage = tag.replaceAll("-", "_");
      purged += await deleteRows(client, `/* temporal-derived-purge:${tag} */
DELETE FROM ${table}
WHERE scope_fingerprint = $2 AND evidence_memory_id = ANY($1::text[])`, textParams);
    }
    stage = "work_edges";
    purged += await deleteRows(client, `/* temporal-derived-purge:work-edges */
DELETE FROM mengshu_work_memory_edges edges
WHERE edges.scope_fingerprint = $2 AND (
  edges.source_id IN (SELECT id FROM mengshu_work_memory_nodes
    WHERE scope_fingerprint = $2 AND (record_id = ANY($1::text[])
      OR evidence_memory_ids ?| $1::text[]))
  OR edges.target_id IN (SELECT id FROM mengshu_work_memory_nodes
    WHERE scope_fingerprint = $2 AND (record_id = ANY($1::text[])
      OR evidence_memory_ids ?| $1::text[]))
  OR edges.evidence_chunk_ids ?| $1::text[]
)`, textParams);
    stage = "work_nodes";
    purged += await deleteRows(client, `/* temporal-derived-purge:work-nodes */
DELETE FROM mengshu_work_memory_nodes
WHERE scope_fingerprint = $2 AND (
  record_id = ANY($1::text[]) OR evidence_memory_ids ?| $1::text[]
  OR evidence_chunk_ids ?| $1::text[]
)`, textParams);
    stage = "tree_summaries";
    purged += await deleteRows(client, `/* temporal-derived-purge:tree-summaries */
DELETE FROM mengshu_tree_summary_nodes
WHERE scope_fingerprint = $2 AND (leaf_ids ?| $1::text[] OR evidence_chunk_ids ?| $1::text[])`,
    textParams);
    stage = "tree_buffers";
    purged += await deleteRows(client, `/* temporal-derived-purge:tree-buffers */
DELETE FROM mengshu_tree_buffers
WHERE scope_fingerprint = $2 AND leaf_ids ?| $1::text[]`, textParams);
    stage = "tree_leaves";
    purged += await deleteRows(client, `/* temporal-derived-purge:tree-leaves */
DELETE FROM mengshu_tree_leaves
WHERE scope_fingerprint = $2 AND (id = ANY($1::text[]) OR chunk_id = ANY($1::text[]))`, textParams);

    // Asset 与其 Loadout/文档投影按 FK 反向顺序整组擦除，避免残留摘要正文。
    stage = "loadout_audit";
    purged += await deleteRows(client, `/* temporal-derived-purge:loadout-audit */
DELETE FROM mengshu_loadout_audit WHERE (scope_fingerprint, loadout_id) IN (
  SELECT scope_fingerprint, loadout_id FROM mengshu_loadout_versions versions
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(versions.descriptor->'slotBindings') binding
    JOIN mengshu_purge_asset_ids impacted
      ON impacted.scope_fingerprint = versions.scope_fingerprint
     AND impacted.asset_id = binding->>'assetId')
)`, []);
    for (const [tag, table] of [
      ["loadout-outbox", "mengshu_loadout_outbox"],
      ["loadout-receipts", "mengshu_loadout_receipts"],
      ["loadout-heads", "mengshu_loadout_heads"],
      ["loadout-versions", "mengshu_loadout_versions"],
    ] as const) {
      stage = tag.replaceAll("-", "_");
      purged += await deleteRows(client, `/* temporal-derived-purge:${tag} */
DELETE FROM ${table} WHERE (scope_fingerprint, loadout_id) IN (
  SELECT scope_fingerprint, loadout_id FROM mengshu_loadout_versions versions
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(versions.descriptor->'slotBindings') binding
    JOIN mengshu_purge_asset_ids impacted
      ON impacted.scope_fingerprint = versions.scope_fingerprint
     AND impacted.asset_id = binding->>'assetId')
)`, []);
    }
    for (const [tag, table] of [
      ["document-heads", "mengshu_governed_document_complete_heads"],
      ["document-receipts", "mengshu_governed_document_sync_receipts"],
      ["document-bindings", "mengshu_governed_document_bindings"],
      ["asset-audit", "mengshu_asset_audit"],
      ["asset-outbox", "mengshu_asset_outbox"],
      ["asset-receipts", "mengshu_asset_promotion_receipts"],
      ["asset-heads", "mengshu_asset_heads"],
      ["asset-versions", "mengshu_asset_versions"],
    ] as const) {
      stage = tag.replaceAll("-", "_");
      purged += await deleteRows(client, `/* temporal-derived-purge:${tag} */
DELETE FROM ${table} target USING mengshu_purge_asset_ids impacted
WHERE target.scope_fingerprint = impacted.scope_fingerprint
  AND target.asset_id = impacted.asset_id`, []);
    }

    for (const [tag, table] of [
      ["skill-receipts", "mengshu_skill_promotion_receipts"],
      ["skill-heads", "mengshu_skill_asset_heads"],
      ["skill-resources", "mengshu_skill_asset_resources"],
      ["skill-versions", "mengshu_skill_asset_versions"],
    ] as const) {
      stage = tag.replaceAll("-", "_");
      purged += await deleteRows(client, `/* temporal-derived-purge:${tag} */
DELETE FROM ${table} target USING mengshu_purge_skill_ids impacted
WHERE target.scope_fingerprint = impacted.scope_fingerprint
  AND target.skill_id = impacted.skill_id`, []);
    }

    stage = "migration_snapshots";
    purged += await deleteRows(client, `/* temporal-derived-purge:migration-snapshots */
DELETE FROM mengshu_memory_temporal_migration_rows
WHERE memory_id = ANY($1::uuid[])`, [input.versionIds]);
    stage = "repair_snapshots";
    purged += await deleteRows(client, `/* temporal-derived-purge:repair-snapshots */
DELETE FROM mengshu_temporal_prerequisite_repair_rows
WHERE memory_id = ANY($1::uuid[])`, [input.versionIds]);
    stage = "transition_receipts";
    purged += await deleteRows(client, `/* temporal-derived-purge:transition-receipts */
DELETE FROM mengshu_memory_version_transition_receipts
WHERE scope_fingerprint = $1 AND lineage_id = $2`, [
      input.scopeFingerprint, input.lineageId,
    ]);
    stage = "version_outbox";
    purged += await deleteRows(client, `/* temporal-derived-purge:version-outbox */
DELETE FROM mengshu_memory_version_outbox
WHERE scope_fingerprint = $1 AND lineage_id = $2`, [input.scopeFingerprint, input.lineageId]);
    stage = "commit";
    await client.query("COMMIT");
    return purged;
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
    throw new PostgresTemporalDerivedPurgeError(
      `TEMPORAL_DERIVED_PURGE_${stage.toUpperCase()}_FAILED`,
    );
  } finally {
    client.release();
  }
}
