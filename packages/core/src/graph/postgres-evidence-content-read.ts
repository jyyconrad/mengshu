import type { MemoryScope } from "../domain/types.js";
import { escapeMemoryForPrompt } from "../retrieval/prompt-safety.js";
import type {
  EvidenceContentItem,
  EvidenceContentReadPort,
  EvidenceContentRef,
} from "./memory-navigation-service.js";

export interface PostgresEvidenceContentQueryClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount?: number | null }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = new Set(["memory", "chunk", "document", "message", "resource"]);
const MAX_PREVIEW_CHARS = 4_000;
const SESSION_SQL = `COALESCE(
  metadata->>'sessionId',
  metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

function canonicalScope(scope: MemoryScope) {
  const visibility = scope.visibility ?? "private";
  const values = [
    scope.tenantId, scope.userId, scope.projectId, scope.appId, scope.agentId,
    scope.namespace, visibility, scope.workspaceId ?? "", scope.sessionId ?? "",
  ];
  if (values.slice(0, 7).some((value) => typeof value !== "string" || value.length === 0 ||
      value !== value.trim() || /\p{Cc}/u.test(value)) ||
      (scope.workspaceId !== undefined && (scope.workspaceId.length === 0 ||
        scope.workspaceId !== scope.workspaceId.trim() || /\p{Cc}/u.test(scope.workspaceId))) ||
      (scope.sessionId !== undefined && (scope.sessionId.length === 0 ||
        scope.sessionId !== scope.sessionId.trim() || /\p{Cc}/u.test(scope.sessionId)))) {
    throw new Error("MEMORY_EVIDENCE_CONTENT_SCOPE_INVALID");
  }
  return values as [string, string, string, string, string, string, string, string, string];
}

export class PostgresEvidenceContentReadPort implements EvidenceContentReadPort {
  constructor(private readonly client: PostgresEvidenceContentQueryClient) {}

  async read(
    scope: MemoryScope,
    refsInput: readonly EvidenceContentRef[],
  ): Promise<readonly EvidenceContentItem[]> {
    if (!Array.isArray(refsInput) || refsInput.length < 1 || refsInput.length > 50 ||
        refsInput.some((item) => !UUID.test(item.ref) || !SOURCES.has(item.source)) ||
        new Set(refsInput.map((item) => item.ref)).size !== refsInput.length) {
      throw new Error("MEMORY_EVIDENCE_CONTENT_INPUT_INVALID");
    }
    const [tenantId, userId, projectId, appId, agentId, namespace, visibility,
      workspaceId, sessionId] = canonicalScope(scope);
    const ids = refsInput.map((item) => item.ref);
    const result = await this.client.query(
      `SELECT id, text, lifecycle_status, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, metadata
FROM memories
WHERE id = ANY($1::uuid[])
  AND tenant_id = $2 AND user_id = $3 AND canonical_project_id = $4
  AND product_id = $5 AND producer_id = $6 AND namespace = $7
  AND visibility = $8 AND COALESCE(workspace_id, '') = $9
  AND ${SESSION_SQL} = $10
  AND (
    metadata->>'sessionId' IS NULL
    OR metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR metadata->>'sessionId' = metadata #>> '{governance,provenance,sessionId}'
  )`,
      [ids, tenantId, userId, projectId, appId, agentId, namespace, visibility, workspaceId, sessionId],
    );
    if (result.rowCount !== result.rows.length || result.rows.length !== refsInput.length) {
      throw new Error("MEMORY_EVIDENCE_CONTENT_INCOMPLETE");
    }
    const rows = new Map<string, string>();
    for (const row of result.rows) {
      const metadata = row.metadata;
      const metadataRecord = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : undefined;
      const governance = metadataRecord?.governance;
      const provenance = governance && typeof governance === "object" && !Array.isArray(governance)
        ? (governance as Record<string, unknown>).provenance
        : undefined;
      const nestedSession = provenance && typeof provenance === "object" && !Array.isArray(provenance)
        ? (provenance as Record<string, unknown>).sessionId
        : undefined;
      const topSession = metadataRecord?.sessionId;
      const resolvedSession = topSession ?? nestedSession ?? "";
      const sessionMirrorsAgree = topSession === undefined || nestedSession === undefined ||
        topSession === nestedSession;
      const exact = row.tenant_id === tenantId && row.user_id === userId &&
        row.canonical_project_id === projectId && row.product_id === appId &&
        row.producer_id === agentId && row.namespace === namespace &&
        row.visibility === visibility && (row.workspace_id ?? "") === workspaceId &&
        row.lifecycle_status === "archived" && metadataRecord !== undefined &&
        sessionMirrorsAgree && resolvedSession === sessionId;
      if (!exact || typeof row.id !== "string" || !ids.includes(row.id) || rows.has(row.id) ||
          typeof row.text !== "string") {
        throw new Error("MEMORY_EVIDENCE_CONTENT_INVALID");
      }
      rows.set(row.id, escapeMemoryForPrompt(row.text.slice(0, MAX_PREVIEW_CHARS)));
    }
    return refsInput.map((item) => {
      const preview = rows.get(item.ref);
      if (preview === undefined) throw new Error("MEMORY_EVIDENCE_CONTENT_INCOMPLETE");
      return Object.freeze({ ...item, preview });
    });
  }
}
