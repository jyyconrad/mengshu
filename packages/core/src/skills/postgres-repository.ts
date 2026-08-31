import type { SkillArtifactRepository } from "./repository.js";
import type {
  SkillArtifactMutationResult,
  SkillArtifactReceipt,
  SkillArtifactVersion,
} from "./types.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresSkillArtifactClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release?(): void;
}

export interface PostgresSkillArtifactPool extends PostgresSkillArtifactClient {
  connect(): Promise<PostgresSkillArtifactClient>;
}

function artifactFrom(value: unknown, isHead: boolean): SkillArtifactVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL_INVALID_ROW");
  const artifact = value as SkillArtifactVersion;
  if (typeof artifact.skillId !== "string" || !Number.isSafeInteger(artifact.version) ||
      typeof artifact.contentHash !== "string" || !Array.isArray(artifact.manifest) ||
      artifact.executionMode !== "suggest_only") throw new Error("SKILL_INVALID_ROW");
  return structuredClone({ ...artifact, isHead });
}

function receiptFrom(value: unknown): SkillArtifactReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL_INVALID_ROW");
  const receipt = value as SkillArtifactReceipt;
  if (typeof receipt.id !== "string" || typeof receipt.scopeFingerprint !== "string" ||
      typeof receipt.idempotencyKey !== "string" || typeof receipt.requestHash !== "string" ||
      typeof receipt.skillId !== "string" || !Number.isSafeInteger(receipt.artifactVersion)) {
    throw new Error("SKILL_INVALID_ROW");
  }
  return structuredClone(receipt);
}

export class PostgresSkillArtifactRepository implements SkillArtifactRepository {
  constructor(readonly pool: PostgresSkillArtifactPool) {}

  async getLatest(scopeFingerprint: string, skillId: string): Promise<SkillArtifactVersion | undefined> {
    const result = await this.pool.query<{ artifact: unknown }>(
      `/* skill-artifact:get-latest */
SELECT versions.artifact
FROM mengshu_skill_asset_heads heads
JOIN mengshu_skill_asset_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.skill_id = heads.skill_id
 AND versions.version = heads.latest_complete_version
WHERE heads.scope_fingerprint = $1 AND heads.skill_id = $2
  AND versions.resource_state = 'complete'`,
      [scopeFingerprint, skillId],
    );
    return result.rows[0] === undefined ? undefined : artifactFrom(result.rows[0].artifact, true);
  }

  async getVersion(
    scopeFingerprint: string,
    skillId: string,
    version: number,
  ): Promise<SkillArtifactVersion | undefined> {
    const result = await this.pool.query<{ artifact: unknown; latest_complete_version: number | null }>(
      `/* skill-artifact:get-version */
SELECT versions.artifact, heads.latest_complete_version
FROM mengshu_skill_asset_versions versions
LEFT JOIN mengshu_skill_asset_heads heads
  ON heads.scope_fingerprint = versions.scope_fingerprint AND heads.skill_id = versions.skill_id
WHERE versions.scope_fingerprint = $1 AND versions.skill_id = $2 AND versions.version = $3
  AND versions.resource_state = 'complete'`,
      [scopeFingerprint, skillId, version],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : artifactFrom(row.artifact, Number(row.latest_complete_version) === version);
  }

  async listLatest(scopeFingerprint: string): Promise<readonly SkillArtifactVersion[]> {
    const result = await this.pool.query<{ artifact: unknown }>(
      `/* skill-artifact:list-latest */
SELECT versions.artifact
FROM mengshu_skill_asset_heads heads
JOIN mengshu_skill_asset_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.skill_id = heads.skill_id
 AND versions.version = heads.latest_complete_version
WHERE heads.scope_fingerprint = $1 AND versions.resource_state = 'complete'
ORDER BY versions.skill_id`,
      [scopeFingerprint],
    );
    return result.rows.map((row) => artifactFrom(row.artifact, true));
  }

  async searchPublished(scopeFingerprint: string, query: string, limit: number) {
    const result = await this.pool.query<{ artifact: unknown; score: number | string }>(
      `/* skill-artifact:search-published-bm25 */
WITH query AS (SELECT plainto_tsquery('simple', $2) AS value)
SELECT versions.artifact,
       ts_rank_cd(to_tsvector('simple', versions.title || ' ' || versions.description), query.value) AS score
FROM mengshu_skill_asset_heads heads
JOIN mengshu_skill_asset_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.skill_id = heads.skill_id
 AND versions.version = heads.latest_complete_version
CROSS JOIN query
WHERE heads.scope_fingerprint = $1 AND versions.resource_state = 'complete'
  AND versions.status = 'published'
  AND to_tsvector('simple', versions.title || ' ' || versions.description) @@ query.value
ORDER BY score DESC, versions.skill_id
LIMIT $3`,
      [scopeFingerprint, query, limit],
    );
    return result.rows.map((row) => ({
      artifact: artifactFrom(row.artifact, true),
      score: Number(row.score),
    }));
  }

  async getReceipt(
    scopeFingerprint: string,
    idempotencyKey: string,
  ): Promise<SkillArtifactReceipt | undefined> {
    const result = await this.pool.query<{ receipt: unknown }>(
      `/* skill-artifact:get-receipt */
SELECT receipt FROM mengshu_skill_promotion_receipts
WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
      [scopeFingerprint, idempotencyKey],
    );
    return result.rows[0] === undefined ? undefined : receiptFrom(result.rows[0].receipt);
  }

  async getReceiptById(
    scopeFingerprint: string,
    receiptId: string,
  ): Promise<SkillArtifactReceipt | undefined> {
    const result = await this.pool.query<{ receipt: unknown }>(
      `/* skill-artifact:get-receipt-id */
SELECT receipt FROM mengshu_skill_promotion_receipts
WHERE scope_fingerprint = $1 AND receipt_id = $2`,
      [scopeFingerprint, receiptId],
    );
    return result.rows[0] === undefined ? undefined : receiptFrom(result.rows[0].receipt);
  }

  async listReceipts(scopeFingerprint: string, skillId: string) {
    const result = await this.pool.query<{ receipt: unknown }>(
      `/* skill-artifact:list-receipts */
SELECT receipt FROM mengshu_skill_promotion_receipts
WHERE scope_fingerprint = $1 AND skill_id = $2
ORDER BY artifact_version, occurred_at, receipt_id`,
      [scopeFingerprint, skillId],
    );
    return result.rows.map((row) => receiptFrom(row.receipt));
  }

  async appendVersion(input: {
    readonly scopeFingerprint: string;
    readonly artifact: SkillArtifactVersion;
    readonly receipt: SkillArtifactReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<SkillArtifactMutationResult> {
    const replay = await this.getReceipt(input.scopeFingerprint, input.receipt.idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestHash !== input.receipt.requestHash) throw new Error("SKILL_IDEMPOTENCY_CONFLICT");
      const artifact = await this.getVersion(input.scopeFingerprint, replay.skillId, replay.artifactVersion);
      if (artifact === undefined) throw new Error("SKILL_ARTIFACT_NOT_FOUND");
      return { artifact, receipt: replay, replayed: true };
    }
    const { artifact, receipt } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `skill-artifact:${input.scopeFingerprint}:${artifact.skillId}`,
      ]);
      const locked = await client.query<{ latest_version: number }>(
        `/* skill-artifact:lock-head */
SELECT latest_version FROM mengshu_skill_asset_heads
WHERE scope_fingerprint = $1 AND skill_id = $2 FOR UPDATE`,
        [input.scopeFingerprint, artifact.skillId],
      );
      const latest = locked.rows[0] === undefined ? 0 : Number(locked.rows[0].latest_version);
      if (latest !== input.expectedLatestVersion || artifact.version !== latest + 1) {
        throw new Error("SKILL_VERSION_STALE");
      }
      const inserted = await client.query(
        `/* skill-artifact:insert-version */
INSERT INTO mengshu_skill_asset_versions (
  scope_fingerprint, skill_id, version, owner_user_id, tenant_id, user_id,
  app_id, project_id, agent_id, namespace, visibility, workspace_id,
  source_candidate_id, title, description, content_hash, status, execution_mode,
  resource_state, expected_outcome_policy_version, artifact, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
  $14, $15, $16, $17, $18, 'prepared', $19, $20::jsonb, $21)
RETURNING version`,
        [input.scopeFingerprint, artifact.skillId, artifact.version, artifact.ownerUserId,
          artifact.scope.tenantId, artifact.scope.userId, artifact.scope.appId,
          artifact.scope.projectId, artifact.scope.agentId, artifact.scope.namespace,
          artifact.scope.visibility, artifact.scope.workspaceId ?? null,
          artifact.sourceCandidateId ?? null, artifact.title, artifact.description,
          artifact.contentHash, artifact.status, artifact.executionMode,
          artifact.expectedOutcomePolicyVersion, JSON.stringify(artifact), Date.parse(artifact.createdAt)],
      );
      if (inserted.rowCount !== 1) throw new Error("SKILL_DATABASE_FAILED");
      for (const resource of artifact.manifest) {
        const resourceResult = await client.query(
          `/* skill-artifact:insert-resource */
INSERT INTO mengshu_skill_asset_resources (
  scope_fingerprint, skill_id, version, path, content_hash, size_bytes,
  mime_type, executable, provenance_ref
) VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8)
RETURNING path`,
          [input.scopeFingerprint, artifact.skillId, artifact.version, resource.path,
            resource.contentHash, resource.sizeBytes, resource.mimeType,
            resource.provenanceRef ?? null],
        );
        if (resourceResult.rowCount !== 1) throw new Error("SKILL_DATABASE_FAILED");
      }
      const completed = await client.query(
        `/* skill-artifact:complete-version */
UPDATE mengshu_skill_asset_versions SET resource_state = 'complete'
WHERE scope_fingerprint = $1 AND skill_id = $2 AND version = $3
  AND resource_state = 'prepared'
RETURNING version`,
        [input.scopeFingerprint, artifact.skillId, artifact.version],
      );
      if (completed.rowCount !== 1) throw new Error("SKILL_DATABASE_FAILED");
      const advanced = await client.query(
        `/* skill-artifact:advance-head */
INSERT INTO mengshu_skill_asset_heads (
  scope_fingerprint, skill_id, latest_version, latest_complete_version, updated_at
) VALUES ($1, $2, $3, $3, $4)
ON CONFLICT (scope_fingerprint, skill_id) DO UPDATE SET
  latest_version = EXCLUDED.latest_version,
  latest_complete_version = EXCLUDED.latest_complete_version,
  updated_at = EXCLUDED.updated_at
WHERE mengshu_skill_asset_heads.latest_version = $5
RETURNING latest_version`,
        [input.scopeFingerprint, artifact.skillId, artifact.version,
          Date.parse(artifact.createdAt), input.expectedLatestVersion],
      );
      if (advanced.rowCount !== 1) throw new Error("SKILL_VERSION_STALE");
      const insertedReceipt = await client.query(
        `/* skill-artifact:insert-receipt */
INSERT INTO mengshu_skill_promotion_receipts (
  receipt_id, scope_fingerprint, idempotency_key, request_hash, skill_id,
  artifact_version, operation, receipt, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING receipt_id`,
        [receipt.id, input.scopeFingerprint, receipt.idempotencyKey, receipt.requestHash,
          receipt.skillId, receipt.artifactVersion, receipt.operation,
          JSON.stringify(receipt), Date.parse(receipt.occurredAt)],
      );
      if (insertedReceipt.rowCount !== 1) throw new Error("SKILL_DATABASE_FAILED");
      await client.query("COMMIT");
      return { artifact: structuredClone(artifact), receipt: structuredClone(receipt), replayed: false };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally {
      client.release?.();
    }
  }

  async recordUnchangedAppend(input: {
    readonly scopeFingerprint: string;
    readonly artifact: SkillArtifactVersion;
    readonly receipt: SkillArtifactReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<SkillArtifactMutationResult> {
    const replay = await this.getReceipt(input.scopeFingerprint, input.receipt.idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestHash !== input.receipt.requestHash) {
        throw new Error("SKILL_IDEMPOTENCY_CONFLICT");
      }
      const artifact = await this.getVersion(input.scopeFingerprint, replay.skillId, replay.artifactVersion);
      if (artifact === undefined) throw new Error("SKILL_ARTIFACT_NOT_FOUND");
      return { artifact, receipt: replay, replayed: true };
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `skill-artifact:${input.scopeFingerprint}:${input.artifact.skillId}`,
      ]);
      const locked = await client.query<{ artifact: unknown; latest_version: number }>(
        `/* skill-artifact:lock-unchanged-head */
SELECT versions.artifact, heads.latest_version
FROM mengshu_skill_asset_heads heads
JOIN mengshu_skill_asset_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.skill_id = heads.skill_id
 AND versions.version = heads.latest_complete_version
WHERE heads.scope_fingerprint = $1 AND heads.skill_id = $2
  AND versions.resource_state = 'complete'
FOR UPDATE OF heads`,
        [input.scopeFingerprint, input.artifact.skillId],
      );
      const row = locked.rows[0];
      const current = row === undefined ? undefined : artifactFrom(row.artifact, true);
      if (current === undefined || Number(row?.latest_version) !== input.expectedLatestVersion ||
          current.version !== input.artifact.version || current.contentHash !== input.artifact.contentHash) {
        throw new Error("SKILL_VERSION_STALE");
      }
      const inserted = await client.query(
        `/* skill-artifact:insert-unchanged-receipt */
INSERT INTO mengshu_skill_promotion_receipts (
  receipt_id, scope_fingerprint, idempotency_key, request_hash, skill_id,
  artifact_version, operation, receipt, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING receipt_id`,
        [input.receipt.id, input.scopeFingerprint, input.receipt.idempotencyKey,
          input.receipt.requestHash, input.receipt.skillId, input.receipt.artifactVersion,
          input.receipt.operation, JSON.stringify(input.receipt), Date.parse(input.receipt.occurredAt)],
      );
      if (inserted.rowCount !== 1) throw new Error("SKILL_DATABASE_FAILED");
      await client.query("COMMIT");
      return {
        artifact: current,
        receipt: structuredClone(input.receipt),
        replayed: false,
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally {
      client.release?.();
    }
  }
}
