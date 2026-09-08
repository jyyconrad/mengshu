import type { MemoryScope } from "../domain/types.js";
import { computeCanonicalContentHash, computeContentHash } from "../scoring/hash-utils.js";
import { boundedJson, requiredId, scopedFingerprint, scopeParams, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import { decodeEvolutionTarget, EVOLUTION_MEMORY_COLUMNS_SQL, EVOLUTION_MEMORY_ROW_BOUNDS_SQL, EVOLUTION_MEMORY_SCOPE_SQL } from "./postgres-inventory.js";
import { EvolutionError } from "./schema.js";
import type { EvolutionRelatedTargetsPort } from "./types.js";

export interface PostgresEvolutionRelatedTargetsOptions {
  /** Provider-owned unfenced reader with database-side query timeouts. */
  client: PostgresEvolutionQueryClient;
  scope: MemoryScope;
}

const LINK_SCOPE_SQL = ["tenant_id", "user_id", "app_id", "project_id", "agent_id", "namespace", "visibility", "workspace_id", "session_id"]
  .map((column, index) => `l.${column} = $${index + 1}`).join(" AND ");
const RELATED_TARGETS_SQL = `/* evolution:related-targets */
WITH source_clues AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($11::jsonb)
    AS clue(evidence_id text, source_id text, snapshot_hash text, path_id text)
), linked AS MATERIALIZED (
  SELECT candidate.target_memory_id
  FROM source_clues clue CROSS JOIN LATERAL (
    SELECT l.target_memory_id
    FROM mengshu_memory_evidence_links l
    WHERE l.scope_fingerprint = $10 AND ${LINK_SCOPE_SQL}
      AND l.source_id = clue.source_id AND l.relation_state = 'effective' AND l.retired_at IS NULL
      AND l.link_kind IN ('grounded_by', 'duplicate_evidence', 'supersession_evidence')
      AND (l.source_record_id = clue.evidence_id OR l.evidence_memory_id = clue.evidence_id
        OR l.source_hash = clue.snapshot_hash OR (clue.path_id IS NOT NULL AND l.source_path_id = clue.path_id))
      AND NOT EXISTS (SELECT 1 FROM mengshu_evolution_source_dispositions disposition
        WHERE disposition.scope_fingerprint = $10 AND disposition.source_id = l.source_id
          AND disposition.logical_file_id IN ('', l.source_logical_file_id, l.source_path_id)
          AND disposition.disposition = 'revoked')
    ORDER BY l.source_revision, l.target_memory_id, l.link_id LIMIT $13
  ) candidate
), exact AS MATERIALIZED (
  SELECT candidate.id FROM unnest($12::text[]) AS clue(content_hash)
  CROSS JOIN LATERAL (
    SELECT id::text AS id FROM memories
    WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND lifecycle_status = 'active'
      AND content_hash = clue.content_hash LIMIT 1
  ) candidate
), related_ids AS MATERIALIZED (
  SELECT target_memory_id AS id FROM linked UNION SELECT id FROM exact
)
SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL},
  EXISTS (SELECT 1 FROM linked WHERE linked.target_memory_id = memories.id::text) AS related_by_link
FROM memories
WHERE id = ANY(ARRAY(SELECT CASE WHEN id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
  THEN id::uuid ELSE NULL END FROM related_ids))
  AND ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${EVOLUTION_MEMORY_ROW_BOUNDS_SQL}
  AND data_type = 'memory' AND legacy_quarantine_reason IS NULL
  AND temporal_invalidated IS NOT TRUE AND temporal_purge_pending IS NOT TRUE
  AND (temporal_activation_state IS NULL OR temporal_activation_state = 'active')
  AND ((lifecycle_status = 'active' AND COALESCE(metadata->>'admissionRoute', 'active') = 'active')
    OR (lifecycle_status = 'archived' AND metadata->>'admissionRoute' = 'lookup_only'))
  AND COALESCE(metadata #>> '{governance,candidate,phase}', '') <> 'raw_evidence'
  AND NOT (metadata ? 'evolution') AND evolution_alias_of IS NULL AND evolution_disputed IS NOT TRUE
  AND COALESCE(metadata->'tombstoned', 'false'::jsonb) = 'false'::jsonb
  AND COALESCE(metadata->>'lifecycleStatus', '') NOT IN ('revoked', 'superseded')
  AND COALESCE(metadata #> '{governance,evolution,disputed}', 'false'::jsonb) = 'false'::jsonb
  AND COALESCE(metadata #> '{governance,evolution,needsReview}', 'false'::jsonb) = 'false'::jsonb
  AND COALESCE(metadata #>> '{governance,evolution,aliasOf}', '') = ''
  AND valid_to IS NULL AND closed_at IS NULL AND (valid_from IS NULL OR valid_from <= CURRENT_TIMESTAMP)
  AND ((lineage_id IS NULL AND revision IS NULL)
    OR (scope_fingerprint = $10 AND revision >= 1 AND valid_from IS NOT NULL AND EXISTS (
      SELECT 1 FROM mengshu_memory_lineage_heads head
      WHERE head.scope_fingerprint = $10 AND head.lineage_id = memories.lineage_id
        AND head.current_version_id = memories.id AND head.current_version_revision = memories.revision)))
ORDER BY created_at, id LIMIT $13`;

interface SourceClue { evidence_id: string; source_id: string; snapshot_hash: string; path_id: string | null }

/** Discovery only. Related source labels and links never mint target-write authority. */
export class PostgresEvolutionRelatedTargets implements EvolutionRelatedTargetsPort {
  readonly #scope: MemoryScope;
  readonly #fingerprint: string;
  readonly #client: PostgresEvolutionQueryClient;

  constructor(options: PostgresEvolutionRelatedTargetsOptions) {
    this.#scope = { ...options.scope };
    this.#fingerprint = scopedFingerprint(this.#scope);
    this.#client = options.client;
  }

  readonly resolve: EvolutionRelatedTargetsPort["resolve"] = async context => {
    context.signal?.throwIfAborted();
    if (scopedFingerprint(context.scope) !== this.#fingerprint ||
        context.evidence.some(evidence => scopedFingerprint(evidence.scope) !== this.#fingerprint)) {
      throw new EvolutionError("scope_mismatch");
    }
    if (!Number.isSafeInteger(context.limit) || context.limit < 1 ||
        !Number.isSafeInteger(context.maxBytes) || context.maxBytes < 1) throw new EvolutionError("related_targets_budget_invalid");
    if (context.evidence.length > 32) throw new EvolutionError("related_targets_evidence_limit");
    const limit = Math.min(context.limit, 8);
    const clues = new Map<string, SourceClue>(), exactHashes = new Set<string>(), canonicalHashes = new Set<string>();
    for (const evidence of context.evidence) {
      if (evidence.revoked || evidence.origin === "evaluation") continue;
      if (typeof evidence.text !== "string" || !evidence.text.length || Buffer.byteLength(evidence.text) > 32768) {
        throw new EvolutionError("related_targets_evidence_limit");
      }
      const hash = computeCanonicalContentHash(evidence.text);
      if (evidence.snapshotHash !== hash) throw new EvolutionError("source_snapshot_changed");
      canonicalHashes.add(hash);
      exactHashes.add(hash);
      exactHashes.add(computeContentHash(evidence.text));
      const clue: SourceClue = { evidence_id: requiredId(evidence.id), source_id: requiredId(evidence.sourceId), snapshot_hash: hash,
        path_id: evidence.locator?.match(/^([a-f0-9]{64}):\d+-\d+:(.{1,256})$/)?.[1] ?? null };
      clues.set(JSON.stringify(clue), clue);
    }
    if (!clues.size) return { targets: [], recordsRead: 0, bytesRead: 0 };
    const sourceClues = boundedJson([...clues.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, clue]) => clue), 65536);
    const result = await this.#client.query(RELATED_TARGETS_SQL,
      [...scopeParams(this.#scope), this.#fingerprint, JSON.stringify(sourceClues), [...exactHashes].sort(), limit]);
    context.signal?.throwIfAborted();
    const recordsRead = result.rows.length;
    if (recordsRead > limit) throw new EvolutionError("related_targets_record_limit");
    // This measures returned rows, not wire/disk I/O. The host owns the database hard timeout.
    const bytesRead = result.rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
    if (bytesRead > context.maxBytes) throw new EvolutionError("related_targets_byte_limit");
    const targets = new Map<string, ReturnType<typeof decodeEvolutionTarget>>();
    for (const row of result.rows) {
      const target = decodeEvolutionTarget(row, this.#scope);
      if (target.tombstoned || (row.related_by_link !== true && !canonicalHashes.has(target.beforeHash))) continue;
      targets.set(target.memoryId, target);
    }
    return { targets: [...targets.values()].sort((a, b) => a.createdAt - b.createdAt || a.memoryId.localeCompare(b.memoryId)), recordsRead, bytesRead };
  };
}
