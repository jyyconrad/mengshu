/**
 * PostgreSQL-backed Job Repository implementation.
 *
 * 提供持久化的 job 队列实现，支持：
 * - Job dedupe（幂等性）
 * - Job lease（分布式 worker 支持）
 * - Retry 机制
 * - 持久化保证（进程重启不丢失 job）
 *
 * 这是评审问题 #6 的解决方案：替代 in-memory 实现，为生产环境提供可靠性保证。
 */

import type { Pool } from "pg";
import type {
  EnqueueJobInput,
  JobRecord,
  JobRepository,
  JobStatus,
  LeaseJobInput,
} from "./types.js";

export interface PostgresJobRepositoryOptions {
  pool: Pool;
  tableName?: string;
  maxRetries?: number;
}

/**
 * PostgreSQL Job Repository.
 *
 * 使用 PostgreSQL 的 advisory lock 和 FOR UPDATE SKIP LOCKED 实现高效的 job lease。
 */
export class PostgresJobRepository implements JobRepository {
  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly maxRetries: number;

  constructor(options: PostgresJobRepositoryOptions) {
    this.pool = options.pool;
    this.tableName = options.tableName ?? "mengshu_jobs";
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * 确保 jobs 表存在。
   *
   * 在应用启动时调用，创建必要的表和索引。
   */
  async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}',
        dedupe_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        worker_id TEXT,
        lease_until BIGINT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ${this.tableName}_status_idx ON ${this.tableName}(status);
      CREATE INDEX IF NOT EXISTS ${this.tableName}_dedupe_key_idx ON ${this.tableName}(dedupe_key);
      CREATE INDEX IF NOT EXISTS ${this.tableName}_type_idx ON ${this.tableName}(type);
      CREATE INDEX IF NOT EXISTS ${this.tableName}_lease_until_idx ON ${this.tableName}(lease_until) WHERE status = 'running';
    `);
  }

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const now = Date.now();
    const id = `job-${now}-${Math.random().toString(36).slice(2, 9)}`;

    // 使用 ON CONFLICT DO NOTHING 实现幂等性
    const result = await this.pool.query<JobRecord>(
      `
      INSERT INTO ${this.tableName} (id, type, payload, dedupe_key, status, attempts, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'queued', 0, $5, $5)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING *
      `,
      [id, input.type, JSON.stringify(input.payload), input.dedupeKey, now],
    );

    // 如果已存在，返回现有记录
    if (result.rows.length === 0) {
      const existing = await this.pool.query<JobRecord>(
        `SELECT * FROM ${this.tableName} WHERE dedupe_key = $1`,
        [input.dedupeKey],
      );
      return this.mapRow(existing.rows[0]);
    }

    return this.mapRow(result.rows[0]);
  }

  async lease(input: LeaseJobInput): Promise<JobRecord | undefined> {
    const now = Date.now();
    const leaseUntil = now + input.leaseMs;

    // 使用 FOR UPDATE SKIP LOCKED 实现无锁竞争的 job 获取
    const result = await this.pool.query<JobRecord>(
      `
      UPDATE ${this.tableName}
      SET status = 'running',
          worker_id = $1,
          lease_until = $2,
          attempts = attempts + 1,
          updated_at = $3
      WHERE id = (
        SELECT id FROM ${this.tableName}
        WHERE (status = 'queued' OR status = 'failed' OR (status = 'running' AND lease_until <= $3))
          AND attempts < $4
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
      `,
      [input.workerId, leaseUntil, now, this.maxRetries],
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    return this.mapRow(result.rows[0]);
  }

  async complete(id: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.tableName}
      SET status = 'completed',
          lease_until = NULL,
          updated_at = $1
      WHERE id = $2
      `,
      [Date.now(), id],
    );
  }

  async fail(id: string, error: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.tableName}
      SET status = 'failed',
          error = $1,
          lease_until = NULL,
          updated_at = $2
      WHERE id = $3
      `,
      [error, Date.now(), id],
    );
  }

  async list(status?: JobStatus): Promise<JobRecord[]> {
    const query = status
      ? `SELECT * FROM ${this.tableName} WHERE status = $1 ORDER BY created_at DESC`
      : `SELECT * FROM ${this.tableName} ORDER BY created_at DESC`;

    const result = await this.pool.query<JobRecord>(
      query,
      status ? [status] : [],
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  /**
   * 清理已完成的 job（保留最近 N 天）。
   */
  async cleanup(retentionDays: number = 7): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = await this.pool.query(
      `
      DELETE FROM ${this.tableName}
      WHERE status = 'completed' AND updated_at < $1
      `,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  /**
   * 获取 job 统计信息。
   */
  async stats(): Promise<Record<JobStatus, number>> {
    const result = await this.pool.query<{ status: JobStatus; count: string }>(
      `
      SELECT status, COUNT(*)::TEXT as count
      FROM ${this.tableName}
      GROUP BY status
      `,
    );

    const stats: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };

    for (const row of result.rows) {
      stats[row.status] = parseInt(row.count, 10);
    }

    return stats;
  }

  private mapRow(row: any): JobRecord {
    return {
      id: row.id,
      type: row.type,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      dedupeKey: row.dedupe_key,
      status: row.status,
      attempts: row.attempts,
      workerId: row.worker_id,
      leaseUntil: row.lease_until,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
