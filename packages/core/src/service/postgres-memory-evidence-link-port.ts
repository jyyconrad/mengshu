import { createHash } from "node:crypto";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";

export interface PostgresMemoryEvidenceLinkQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Caller owns the client lifecycle and surrounding transaction. */
export interface PostgresMemoryEvidenceLinkQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresMemoryEvidenceLinkQueryResult<Row>>;
}

export interface DuplicateEvidenceLinkWriteInput {
  readonly scope: MemoryScope;
  readonly targetMemoryId: string;
  readonly evidenceMemoryId: string;
  readonly createdAt: number;
}

export interface DuplicateEvidenceLinkWriteReceipt {
  readonly linkId: string;
  readonly scopeFingerprint: string;
  readonly targetMemoryId: string;
  readonly evidenceMemoryId: string;
  readonly linkKind: "duplicate_evidence";
  readonly source: "write_kernel_dedup";
}

export interface ProviderOwnedDuplicateEvidenceLinkPort {
  linkDuplicateEvidence(
    input: DuplicateEvidenceLinkWriteInput,
  ): Promise<DuplicateEvidenceLinkWriteReceipt>;
}

export interface PostgresMemoryEvidenceLinkPoolClient
  extends PostgresMemoryEvidenceLinkQueryClient {
  release(): void;
}

export interface PostgresMemoryEvidenceLinkPool {
  connect(): Promise<PostgresMemoryEvidenceLinkPoolClient>;
}

const providerOwnedDuplicateEvidenceLinkPorts = new WeakSet<object>();

export function isProviderOwnedDuplicateEvidenceLinkPort(
  value: unknown,
): value is ProviderOwnedDuplicateEvidenceLinkPort {
  return typeof value === "object" && value !== null &&
    providerOwnedDuplicateEvidenceLinkPorts.has(value);
}

export class PostgresDuplicateEvidenceLinkPort
implements ProviderOwnedDuplicateEvidenceLinkPort {
  constructor(private readonly pool: PostgresMemoryEvidenceLinkPool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new Error("Postgres duplicate evidence link pool is required");
    }
    providerOwnedDuplicateEvidenceLinkPorts.add(this);
  }

  async linkDuplicateEvidence(
    input: DuplicateEvidenceLinkWriteInput,
  ): Promise<DuplicateEvidenceLinkWriteReceipt> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const receipt = await linkDuplicateEvidenceWithClient(client, input);
      await client.query("COMMIT");
      transactionStarted = false;
      return receipt;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Postgres duplicate evidence link and rollback both failed",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const LINK_KIND = "duplicate_evidence" as const;
const LINK_SOURCE = "write_kernel_dedup" as const;
const SAFE_MEMORY_ID = /^[^\s\p{Cc}]{1,256}$/u;

const UPSERT_DUPLICATE_EVIDENCE_LINK_SQL = `INSERT INTO mengshu_memory_evidence_links (
  link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, target_memory_id,
  evidence_memory_id, link_kind, source, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source)
DO UPDATE SET link_id = mengshu_memory_evidence_links.link_id
RETURNING link_id`;

function memoryId(value: string, field: string): string {
  if (!SAFE_MEMORY_ID.test(value)) {
    throw new Error(`duplicate evidence link ${field} is invalid`);
  }
  return value;
}

function deterministicLinkId(
  scopeFingerprint: string,
  targetMemoryId: string,
  evidenceMemoryId: string,
): string {
  return createHash("sha256").update(JSON.stringify([
    "mengshu.memory-evidence-link/v1",
    scopeFingerprint,
    targetMemoryId,
    evidenceMemoryId,
    LINK_KIND,
    LINK_SOURCE,
  ])).digest("hex");
}

export async function linkDuplicateEvidenceWithClient(
  client: PostgresMemoryEvidenceLinkQueryClient,
  input: DuplicateEvidenceLinkWriteInput,
): Promise<DuplicateEvidenceLinkWriteReceipt> {
  if (!client || typeof client.query !== "function") {
    throw new Error("duplicate evidence link query client is required");
  }
  const scope = canonicalAuthorityScope(input.scope);
  const scopeFingerprint = authorityScopeFingerprint(input.scope);
  const targetMemoryId = memoryId(input.targetMemoryId, "targetMemoryId");
  const evidenceMemoryId = memoryId(input.evidenceMemoryId, "evidenceMemoryId");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("duplicate evidence link createdAt is invalid");
  }
  const linkId = deterministicLinkId(scopeFingerprint, targetMemoryId, evidenceMemoryId);
  const result = await client.query(UPSERT_DUPLICATE_EVIDENCE_LINK_SQL, [
    linkId,
    scopeFingerprint,
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
    scope.workspaceId,
    scope.sessionId,
    targetMemoryId,
    evidenceMemoryId,
    LINK_KIND,
    LINK_SOURCE,
    input.createdAt,
  ]);
  if (!result || result.rowCount !== 1 || result.rows.length !== 1 ||
      result.rows[0]?.link_id !== linkId) {
    throw new Error("duplicate evidence link receipt is invalid");
  }
  return Object.freeze({
    linkId,
    scopeFingerprint,
    targetMemoryId,
    evidenceMemoryId,
    linkKind: LINK_KIND,
    source: LINK_SOURCE,
  });
}
