import {
  createEmbeddingSpace,
  type KnownEmbeddingSpace,
} from "../../domain/embedding-space.js";

export interface EmbeddingSpaceRegistryQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface EmbeddingSpaceRegistryQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<EmbeddingSpaceRegistryQueryResult<Row>>;
}

export const READ_ACTIVE_EMBEDDING_SPACE_SQL = `SELECT
  s.embedding_space_id,
  s.provider,
  s.base_url,
  s.model,
  s.dimensions,
  s.normalization,
  s.state
FROM mengshu_active_embedding_space a
JOIN mengshu_embedding_spaces s ON s.embedding_space_id = a.embedding_space_id
WHERE a.singleton_key = 'active'`;

export const INSERT_EMBEDDING_SPACE_SQL = `INSERT INTO mengshu_embedding_spaces (
  embedding_space_id, provider, base_url, model, dimensions, normalization, state
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (embedding_space_id) DO NOTHING`;

export const READ_EMBEDDING_SPACE_BY_ID_SQL = `SELECT
  embedding_space_id, provider, base_url, model, dimensions, normalization, state
FROM mengshu_embedding_spaces
WHERE embedding_space_id = $1`;

export const INSERT_ACTIVE_EMBEDDING_SPACE_SQL = `INSERT INTO mengshu_active_embedding_space (
  singleton_key, embedding_space_id
) VALUES ('active', $1)
ON CONFLICT (singleton_key) DO NOTHING`;

export const READ_ACTIVE_EMBEDDING_SPACE_FOR_SWITCH_SQL = `${READ_ACTIVE_EMBEDDING_SPACE_SQL}
FOR UPDATE OF a`;

export const MARK_EMBEDDING_SPACE_QUERYABILITY_SQL = `UPDATE mengshu_embedding_spaces
SET queryability_state = $2
WHERE embedding_space_id = $1
RETURNING embedding_space_id`;

export const SWITCH_ACTIVE_EMBEDDING_SPACE_SQL = `UPDATE mengshu_active_embedding_space
SET embedding_space_id = $2, updated_at = NOW()
WHERE singleton_key = 'active' AND embedding_space_id = $1
RETURNING embedding_space_id`;

export interface EmbeddingSpaceSwitchGate {
  readonly maintenance: true;
  readonly quiescenceConfirmed: true;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid persisted embedding descriptor field: ${key}`);
  }
  return value;
}

function decodeDescriptor(row: Record<string, unknown>): KnownEmbeddingSpace {
  const dimensions = row.dimensions;
  if (!Number.isSafeInteger(dimensions) || (dimensions as number) <= 0) {
    throw new Error("invalid persisted embedding descriptor field: dimensions");
  }
  const state = requiredString(row, "state");
  const decoded = createEmbeddingSpace(
    {
      provider: requiredString(row, "provider"),
      baseURL: requiredString(row, "base_url"),
      model: requiredString(row, "model"),
      dim: dimensions as number,
      normalization: requiredString(row, "normalization") as "none" | "l2",
    },
    state as "known-queryable" | "reembedded",
  );
  if (decoded.embeddingSpaceId !== requiredString(row, "embedding_space_id")) {
    throw new Error("persisted embedding descriptor fingerprint/ID mismatch");
  }
  return decoded;
}

function canonicalDescriptor(space: KnownEmbeddingSpace): KnownEmbeddingSpace {
  const canonical = createEmbeddingSpace(space.fingerprint, space.state);
  if (canonical.embeddingSpaceId !== space.embeddingSpaceId) {
    throw new Error("embedding space descriptor fingerprint/ID mismatch");
  }
  return canonical;
}

function sameDescriptor(
  left: KnownEmbeddingSpace,
  right: KnownEmbeddingSpace,
): boolean {
  return (
    left.embeddingSpaceId === right.embeddingSpaceId &&
    left.state === right.state &&
    left.fingerprint.provider === right.fingerprint.provider &&
    left.fingerprint.baseURL === right.fingerprint.baseURL &&
    left.fingerprint.model === right.fingerprint.model &&
    left.fingerprint.dim === right.fingerprint.dim &&
    left.fingerprint.normalization === right.fingerprint.normalization
  );
}

export class PostgresEmbeddingSpaceRegistryAdapter {
  constructor(private readonly client: EmbeddingSpaceRegistryQueryClient) {}

  async readActive(): Promise<KnownEmbeddingSpace | null> {
    const result = await this.client.query(READ_ACTIVE_EMBEDDING_SPACE_SQL);
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new Error("active embedding space registry returned multiple rows");
    }
    return decodeDescriptor(result.rows[0]!);
  }

  async registerActive(space: KnownEmbeddingSpace): Promise<KnownEmbeddingSpace> {
    const canonical = canonicalDescriptor(space);
    await this.client.query("BEGIN");
    try {
      await this.client.query(INSERT_EMBEDDING_SPACE_SQL, [
        canonical.embeddingSpaceId,
        canonical.fingerprint.provider,
        canonical.fingerprint.baseURL,
        canonical.fingerprint.model,
        canonical.fingerprint.dim,
        canonical.fingerprint.normalization,
        canonical.state,
      ]);
      const persisted = await this.client.query(READ_EMBEDDING_SPACE_BY_ID_SQL, [
        canonical.embeddingSpaceId,
      ]);
      if (persisted.rows.length !== 1) {
        throw new Error("registered embedding descriptor could not be verified");
      }
      const verified = decodeDescriptor(persisted.rows[0]!);
      if (!sameDescriptor(verified, canonical)) {
        throw new Error("registered embedding descriptor mismatch");
      }

      await this.client.query(INSERT_ACTIVE_EMBEDDING_SPACE_SQL, [
        canonical.embeddingSpaceId,
      ]);
      const active = await this.readActive();
      if (!active || !sameDescriptor(active, canonical)) {
        throw new Error("active embedding space mismatch; refusing to overwrite existing pointer");
      }
      await this.client.query("COMMIT");
      return active;
    } catch (error) {
      try {
        await this.client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "embedding space registration and rollback both failed",
        );
      }
      throw error;
    }
  }

  /**
   * 唯一允许覆盖 singleton pointer 的运维路径。旧 descriptor 的
   * queryability_state 降为 unknown-unqueryable；descriptor.state 保留原值作
   * 不可改指纹证据。新 target 必须是 known-queryable，重嵌入过程由
   * v12 receipt 审计，不滥用 embedding space state。
   */
  async switchActive(
    expectedCurrentSpaceId: string,
    targetSpace: KnownEmbeddingSpace,
    gate: EmbeddingSpaceSwitchGate,
  ): Promise<KnownEmbeddingSpace> {
    if (gate?.maintenance !== true || gate.quiescenceConfirmed !== true) {
      throw new Error("embedding space switch requires maintenance and quiescence confirmation");
    }
    const target = canonicalDescriptor(targetSpace);
    if (target.state !== "known-queryable") {
      throw new Error("embedding space switch target must be known-queryable");
    }

    await this.client.query("BEGIN");
    try {
      const locked = await this.client.query(READ_ACTIVE_EMBEDDING_SPACE_FOR_SWITCH_SQL);
      if (locked.rows.length !== 1) {
        throw new Error("embedding space switch requires exactly one active pointer");
      }
      const current = decodeDescriptor(locked.rows[0]!);
      if (current.embeddingSpaceId !== expectedCurrentSpaceId) {
        throw new Error("active embedding space changed; expected-current mismatch");
      }
      if (current.embeddingSpaceId === target.embeddingSpaceId) {
        throw new Error("embedding space switch target is already active");
      }

      await this.client.query(INSERT_EMBEDDING_SPACE_SQL, [
        target.embeddingSpaceId,
        target.fingerprint.provider,
        target.fingerprint.baseURL,
        target.fingerprint.model,
        target.fingerprint.dim,
        target.fingerprint.normalization,
        target.state,
      ]);
      const persisted = await this.client.query(READ_EMBEDDING_SPACE_BY_ID_SQL, [
        target.embeddingSpaceId,
      ]);
      if (persisted.rows.length !== 1 || !sameDescriptor(decodeDescriptor(persisted.rows[0]!), target)) {
        throw new Error("embedding space switch target descriptor mismatch");
      }

      const oldState = await this.client.query(MARK_EMBEDDING_SPACE_QUERYABILITY_SQL, [
        current.embeddingSpaceId,
        "unknown-unqueryable",
      ]);
      const targetState = await this.client.query(MARK_EMBEDDING_SPACE_QUERYABILITY_SQL, [
        target.embeddingSpaceId,
        "known-queryable",
      ]);
      if (oldState.rowCount !== 1 || targetState.rowCount !== 1) {
        throw new Error("embedding space switch queryability transition failed");
      }

      const switched = await this.client.query(SWITCH_ACTIVE_EMBEDDING_SPACE_SQL, [
        current.embeddingSpaceId,
        target.embeddingSpaceId,
      ]);
      if (switched.rowCount !== 1 ||
          switched.rows.length !== 1 ||
          switched.rows[0]?.embedding_space_id !== target.embeddingSpaceId) {
        throw new Error("active embedding space changed; switch aborted");
      }
      const active = await this.readActive();
      if (!active || !sameDescriptor(active, target)) {
        throw new Error("embedding space switch verification failed");
      }
      await this.client.query("COMMIT");
      return active;
    } catch (error) {
      try {
        await this.client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "embedding space switch and rollback both failed",
        );
      }
      throw error;
    }
  }
}
