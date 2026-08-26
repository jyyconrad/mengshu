import { types as nodeUtilTypes } from "node:util";

import type { MemoryScope } from "../domain/types.js";
import type { SourceKind } from "../scoring/importance-score.js";
import type { AuthoritativeCandidateEvidenceFact } from
  "./candidate-confidence-deriver.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = Object.freeze(new Map<string, SourceKind>([
  ["user", "session_user"],
  ["mcp", "session_user"],
  ["scan", "document"],
  ["tool", "tool_result"],
  ["work_log", "work_log"],
  ["rule_file", "rule_file"],
  ["agent", "agent_output"],
]));

export type CandidateEvidenceReadErrorCode =
  | "INVALID_INPUT"
  | "INVALID_SCOPE"
  | "INCOMPLETE_EVIDENCE"
  | "INVALID_EVIDENCE";

export class CandidateEvidenceReadError extends Error {
  readonly code: CandidateEvidenceReadErrorCode;

  constructor(code: CandidateEvidenceReadErrorCode) {
    super(`Candidate evidence read failed: ${code}`);
    this.name = "CandidateEvidenceReadError";
    this.code = code;
  }
}

export interface CandidateEvidenceReadInput {
  readonly evidenceIds: readonly string[];
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

export interface CandidateEvidenceReadPort {
  readAuthoritativeEvidenceFacts(
    input: CandidateEvidenceReadInput,
  ): Promise<readonly AuthoritativeCandidateEvidenceFact[]>;
}

export interface CandidateEvidenceQueryClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
}

interface CanonicalScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly visibility: NonNullable<MemoryScope["visibility"]>;
  readonly workspaceId: string;
  readonly sessionId: string;
}

interface EvidenceRow extends Record<string, unknown> {
  readonly id: string;
  readonly lifecycle_status: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly canonical_project_id: string;
  readonly product_id: string;
  readonly producer_id: string;
  readonly namespace: string;
  readonly visibility: string;
  readonly workspace_id: string;
  readonly metadata: unknown;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.length === 0)) return undefined;
  return value;
}

function scopeSnapshot(value: unknown): CanonicalScope {
  const scope = plainRecord(value);
  if (!scope) throw new CandidateEvidenceReadError("INVALID_SCOPE");
  const required = [
    "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
    "visibility", "workspaceId", "sessionId",
  ] as const;
  if (required.some((field) => typeof scope[field] !== "string" ||
      (scope[field] as string).trim().length === 0)) {
    throw new CandidateEvidenceReadError("INVALID_SCOPE");
  }
  if (!["private", "workspace", "team", "public"].includes(scope.visibility as string)) {
    throw new CandidateEvidenceReadError("INVALID_SCOPE");
  }
  return Object.freeze({
    tenantId: scope.tenantId as string,
    userId: scope.userId as string,
    appId: scope.appId as string,
    projectId: scope.projectId as string,
    agentId: scope.agentId as string,
    namespace: scope.namespace as string,
    visibility: scope.visibility as CanonicalScope["visibility"],
    workspaceId: scope.workspaceId as string,
    sessionId: scope.sessionId as string,
  });
}

function evidenceIdsSnapshot(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || nodeUtilTypes.isProxy(value)) {
    throw new CandidateEvidenceReadError("INVALID_INPUT");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !UUID.test(id) || seen.has(id)) {
      throw new CandidateEvidenceReadError("INVALID_INPUT");
    }
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Candidate evidence read aborted", "AbortError");
}

function exactScope(row: EvidenceRow, scope: CanonicalScope): boolean {
  return row.tenant_id === scope.tenantId && row.user_id === scope.userId &&
    row.canonical_project_id === scope.projectId && row.product_id === scope.appId &&
    row.producer_id === scope.agentId && row.namespace === scope.namespace &&
    row.visibility === scope.visibility && row.workspace_id === scope.workspaceId;
}

function authoritativeFact(row: EvidenceRow, scope: CanonicalScope): AuthoritativeCandidateEvidenceFact {
  if (!UUID.test(row.id) || row.lifecycle_status !== "archived" || !exactScope(row, scope)) {
    throw new CandidateEvidenceReadError("INVALID_EVIDENCE");
  }
  const metadata = plainRecord(row.metadata);
  const governance = plainRecord(metadata?.governance);
  const candidate = plainRecord(governance?.candidate);
  const provenance = plainRecord(governance?.provenance);
  const evidenceIds = stringArray(governance?.evidenceIds);
  const sourceNodeIds = stringArray(metadata?.sourceNodeIds);
  const sourceId = candidate?.sourceId;
  const provenanceSourceId = provenance?.sourceId;
  const source = provenance?.source;
  const sourceKind = source === "agent-fast-path"
    ? metadata?.eventType === "observation" && metadata?.intent === "remember"
      ? "session_user"
      : "agent_output"
    : typeof source === "string"
      ? SOURCE_KINDS.get(source)
      : undefined;
  if (metadata?.sessionId !== scope.sessionId || metadata?.admissionRoute !== "evidence_only" ||
      metadata?.contextEligible !== false || metadata?.memoryContainer !== "session_candidate" ||
      governance?.commandType !== "importEvidence" || candidate?.phase !== "raw_evidence" ||
      candidate?.evidenceOnly !== true || typeof sourceId !== "string" || sourceId.length === 0 ||
      provenanceSourceId !== sourceId || !evidenceIds || evidenceIds.length !== 1 ||
      evidenceIds[0] !== sourceId || !sourceNodeIds || sourceNodeIds.length !== 1 ||
      sourceNodeIds[0] !== sourceId || !sourceKind) {
    throw new CandidateEvidenceReadError("INVALID_EVIDENCE");
  }
  return Object.freeze({ evidenceId: row.id, sourceKind });
}

export class PostgresCandidateEvidenceReadPort implements CandidateEvidenceReadPort {
  constructor(private readonly client: CandidateEvidenceQueryClient) {}

  async readAuthoritativeEvidenceFacts(
    input: CandidateEvidenceReadInput,
  ): Promise<readonly AuthoritativeCandidateEvidenceFact[]> {
    if (!input?.signal || typeof input.signal.aborted !== "boolean") {
      throw new CandidateEvidenceReadError("INVALID_INPUT");
    }
    if (input.signal.aborted) throw abortError(input.signal);
    const evidenceIds = evidenceIdsSnapshot(input.evidenceIds);
    const scope = scopeSnapshot(input.scope);
    const result = await this.client.query(
      `SELECT id, lifecycle_status, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, metadata
FROM memories
WHERE id = ANY($1::uuid[])
  AND tenant_id = $2 AND user_id = $3 AND canonical_project_id = $4
  AND product_id = $5 AND producer_id = $6 AND namespace = $7
  AND visibility = $8 AND workspace_id = $9
  AND metadata->>'sessionId' = $10`,
      [
        evidenceIds, scope.tenantId, scope.userId, scope.projectId, scope.appId,
        scope.agentId, scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      ],
    );
    if (input.signal.aborted) throw abortError(input.signal);
    const rowCount = result.rowCount ?? result.rows.length;
    if (rowCount !== result.rows.length || rowCount !== evidenceIds.length) {
      throw new CandidateEvidenceReadError("INCOMPLETE_EVIDENCE");
    }
    const byId = new Map<string, AuthoritativeCandidateEvidenceFact>();
    for (const row of result.rows) {
      const fact = authoritativeFact(row as EvidenceRow, scope);
      if (!evidenceIds.includes(fact.evidenceId) || byId.has(fact.evidenceId)) {
        throw new CandidateEvidenceReadError("INVALID_EVIDENCE");
      }
      byId.set(fact.evidenceId, fact);
    }
    const facts = evidenceIds.map((id) => byId.get(id));
    if (facts.some((fact) => fact === undefined)) {
      throw new CandidateEvidenceReadError("INCOMPLETE_EVIDENCE");
    }
    return Object.freeze(facts as AuthoritativeCandidateEvidenceFact[]);
  }
}
