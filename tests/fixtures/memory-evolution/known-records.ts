import {
  resolveAuthorityScope,
  type AuthorityScope,
} from "../../../packages/core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../../packages/core/src/domain/types.js";
import type { GovernedRetrievalCandidate } from "../../../packages/core/src/retrieval/governed-retrieval-engine.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";

export const AUTHORITY: AuthorityScope = {
  tenantId: "acceptance-tenant",
  userId: "acceptance-owner",
  workspaceId: "acceptance-workspace",
  sessionId: "acceptance-session",
  allow: {
    appIds: ["codex"],
    projectIds: ["acceptance-project"],
    agentIds: ["acceptance-agent"],
    namespaces: ["memory"],
    visibilities: ["private"],
  },
};

export const CLIENT_SCOPE = {
  appId: "codex",
  projectId: "acceptance-project",
  agentId: "acceptance-agent",
  namespace: "memory",
  visibility: "private" as const,
};
export const SCOPE = resolveAuthorityScope(AUTHORITY, CLIENT_SCOPE);
export const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
export const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";
export const SOURCE_ID = "acceptance-owner-message";
export const LINEAGE_ID = "acceptance-release-approval";
export const KNOWN_AT = 1_780_000_000_000;
export const CANONICAL_TEXT = "Record release approval in the project audit log.";
export const EVIDENCE_TEXT = `${CANONICAL_TEXT} Do not bypass approval for emergency releases.`;

function scopeColumns(scope: MemoryScope) {
  return {
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    app_id: scope.appId,
    project_id: scope.projectId,
    agent_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
  };
}

export function memoryRow(kindOnly = false): Record<string, unknown> & { id: string } {
  return {
    id: MEMORY_ID,
    text: CANONICAL_TEXT,
    content_hash: computeCanonicalContentHash(CANONICAL_TEXT),
    importance: 0.81,
    category: kindOnly ? "fact" : "decision",
    data_type: "memory",
    created_at_ms: String(KNOWN_AT),
    updated_at_ms: String(KNOWN_AT),
    ...scopeColumns(SCOPE),
    lifecycle_status: kindOnly ? "archived" : "active",
    legacy_quarantine_reason: null,
    metadata: {
      admissionRoute: kindOnly ? "lookup_only" : "active",
      contextEligible: !kindOnly,
      valueScore: kindOnly ? 0.65 : 0.92,
      confidence: 0.72,
      ...(kindOnly ? {} : { semanticType: "rules" }),
      memoryContainer: kindOnly ? "session_candidate" : "project",
      sourceNodeIds: [EVIDENCE_ID],
      riskFlags: [],
      governance: {
        commandType: "observeAuto",
        evidenceIds: [EVIDENCE_ID],
        candidate: {
          evidence: { eventIds: [EVIDENCE_ID] },
          riskFlags: [],
          targetScope: "project",
        },
        provenance: { source: "user", sourceId: SOURCE_ID, sessionId: SCOPE.sessionId },
        native: {
          kind: kindOnly ? "fact" : "decision",
          ...(kindOnly ? {} : { semanticType: "rules" }),
          category: kindOnly ? "fact" : "decision",
          dataType: "memory",
        },
      },
    },
  };
}

export function evidenceRow(scope: MemoryScope = SCOPE): Record<string, unknown> {
  return {
    evidence_id: EVIDENCE_ID,
    evidence_text: EVIDENCE_TEXT,
    evidence_created_at_ms: String(KNOWN_AT - 100),
    ...scopeColumns(scope),
    data_type: "memory",
    lifecycle_status: "archived",
    legacy_quarantine_reason: null,
    metadata: {
      admissionRoute: "evidence_only",
      contextEligible: false,
      memoryContainer: "session_candidate",
      eventType: "explicit_save",
      sourceNodeIds: [SOURCE_ID],
      governance: {
        commandType: "importEvidence",
        evidenceIds: [SOURCE_ID],
        candidate: {
          phase: "raw_evidence", evidenceOnly: true,
          quote: EVIDENCE_TEXT, sourceId: SOURCE_ID,
        },
        provenance: { source: "user", sourceId: SOURCE_ID, sessionId: scope.sessionId },
        native: { kind: "observation", container: "session_candidate", dataType: "memory" },
      },
    },
    evidence_origin: "record",
    ledger_link_id: null,
    ledger_target_memory_id: null,
    ledger_evidence_memory_id: null,
    ledger_link_kind: null,
    ledger_source: null,
    ledger_tenant_id: null,
    ledger_user_id: null,
    ledger_app_id: null,
    ledger_project_id: null,
    ledger_agent_id: null,
    ledger_namespace: null,
    ledger_visibility: null,
    ledger_workspace_id: null,
    ledger_session_id: null,
  };
}

export function evidenceContentRow(scope: MemoryScope = SCOPE) {
  return {
    id: EVIDENCE_ID,
    text: EVIDENCE_TEXT,
    lifecycle_status: "archived",
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    canonical_project_id: scope.projectId,
    product_id: scope.appId,
    producer_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    metadata: { sessionId: scope.sessionId },
  };
}

export function retrievalCandidate(scope: MemoryScope = SCOPE): GovernedRetrievalCandidate {
  return {
    candidateId: "acceptance-candidate",
    authoritativeRecordId: MEMORY_ID,
    scope,
    source: "bm25",
    nodeType: "memory",
    relevance: 0.95,
    evidenceIds: [EVIDENCE_ID],
    navigation: { kind: "memory", ref: MEMORY_ID },
  };
}
