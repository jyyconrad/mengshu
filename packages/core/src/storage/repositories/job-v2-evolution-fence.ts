import { assertDurableJobV2, type DurableJobV2 } from "./job-v2.js";
import type { PostgresEvolutionClient, PostgresEvolutionPool } from "../../evolution/postgres-common.js";
import { boundEvolutionPool } from "./evolution-query-pool.js";

export class EvolutionJobFenceError extends Error {
  readonly retryable = true;
  constructor(readonly code: "EVOLUTION_JOB_LEASE_LOST" | "EVOLUTION_JOB_CANCELLED") { super(code); }
}

/** Fence each short provider transaction, never the model call or entire batch. */
export function fenceEvolutionPool(pool: PostgresEvolutionPool, input: DurableJobV2, signal?: AbortSignal): PostgresEvolutionPool {
  assertDurableJobV2(input);
  const job = structuredClone(input);
  if (job.type !== "evolve_memory_batch" || job.status !== "running" || !job.leaseOwner || !job.leaseToken) {
    throw new EvolutionJobFenceError("EVOLUTION_JOB_LEASE_LOST");
  }
  const cancelled = () => { if (signal?.aborted) throw new EvolutionJobFenceError("EVOLUTION_JOB_CANCELLED"); };
  const boundedPool = boundEvolutionPool(pool, signal);
  const check = async (client: PostgresEvolutionClient) => {
    cancelled();
    const scope = job.scope;
    const result = await client.query(`/* evolution:job-fence */ SELECT id FROM mengshu_jobs_v2
WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8 AND status = 'running'
  AND lease_owner = $9 AND lease_token = $10 AND lease_generation = $11
  AND lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint FOR UPDATE`,
    [job.id, scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId, scope.namespace,
      scope.visibility, job.leaseOwner, job.leaseToken, job.leaseGeneration]);
    if (result.rows.length !== 1 || result.rows[0]?.id !== job.id) throw new EvolutionJobFenceError("EVOLUTION_JOB_LEASE_LOST");
  };
  const connect = async (): Promise<PostgresEvolutionClient> => {
    cancelled();
    const client = await boundedPool.connect();
    let active = false;
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        if (sql === "ROLLBACK") { active = false; return client.query<Row>(sql, params); }
        try {
          cancelled();
          if (sql === "BEGIN") {
            if (active) throw new EvolutionJobFenceError("EVOLUTION_JOB_LEASE_LOST");
            const result = await client.query<Row>(sql, params);
            active = true;
            await check(client);
            return result;
          }
          if (!active) throw new EvolutionJobFenceError("EVOLUTION_JOB_LEASE_LOST");
          if (sql === "COMMIT") await check(client);
          const result = await client.query<Row>(sql, params);
          if (sql === "COMMIT") active = false;
          return result;
        } catch (error) {
          if (active) { active = false; await client.query("ROLLBACK"); }
          throw error;
        }
      },
      release: () => client.release(),
    };
  };
  return Object.freeze({
    connect,
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      const client = await connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<Row>(sql, params);
        await client.query("COMMIT");
        return result;
      } finally { client.release(); }
    },
  });
}
