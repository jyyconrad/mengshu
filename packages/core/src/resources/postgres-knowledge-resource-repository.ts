import { canonicalAuthorityScope } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  KnowledgeResourceRecord,
  KnowledgeResourceRepository,
  KnowledgeResourceSourceRef,
} from "./knowledge-resource-types.js";

export interface PostgresKnowledgeResourceQueryClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_QUERY_CHARS = 256;
const MAX_RESULT_ITEMS = 50;
const MAX_CONTENT_CHARS = 4_000;

const RESOURCE_COLUMNS = `id::text AS id, content_hash, category, created_at,
  LEFT(CASE WHEN jsonb_typeof(metadata->'title') = 'string'
    THEN metadata->>'title' ELSE '' END, 200) AS title,
  LEFT(CASE WHEN jsonb_typeof(metadata->'documentId') = 'string'
    THEN metadata->>'documentId' ELSE '' END, 512) AS document_id,
  LEFT(CASE WHEN jsonb_typeof(metadata#>'{provenance,sourceId}') = 'string'
    THEN metadata#>>'{provenance,sourceId}' ELSE '' END, 512) AS provenance_source_id,
  LEFT(CASE WHEN jsonb_typeof(metadata->'filePath') = 'string'
    THEN metadata->>'filePath' ELSE '' END, 512) AS file_path,
  tenant_id, user_id, canonical_project_id, product_id, producer_id,
  namespace, visibility, workspace_id, lifecycle_status,
  metadata->>'riskBlocked' AS risk_blocked,
  metadata->>'unresolvedConflict' AS conflict_unresolved`;

const EXACT_SCOPE_SQL = `tenant_id = $1 AND user_id = $2
  AND canonical_project_id = $3
  AND product_id = $4 AND producer_id = $5
  AND namespace = $6 AND visibility = $7
  AND COALESCE(workspace_id, '') = $8`;

const GOVERNED_RESOURCE_SQL = `legacy_quarantine_reason IS NULL
  AND (lifecycle_status IS NULL OR lifecycle_status IN ('active', 'archived'))
  AND COALESCE(metadata->>'riskBlocked', 'false') = 'false'
  AND COALESCE(metadata->>'unresolvedConflict', 'false') = 'false'`;

function invalid(code: string): never {
  throw new Error(code);
}

function scopeParams(scope: MemoryScope): readonly string[] {
  let canonical;
  try {
    canonical = canonicalAuthorityScope({
      ...scope,
      visibility: scope.visibility ?? "private",
    });
  } catch {
    invalid("KNOWLEDGE_RESOURCE_SCOPE_INVALID");
  }
  return [
    canonical.tenantId,
    canonical.userId,
    canonical.projectId,
    canonical.appId,
    canonical.agentId,
    canonical.namespace,
    canonical.visibility,
    canonical.workspaceId,
  ];
}

function boundedInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    invalid("KNOWLEDGE_RESOURCE_INPUT_INVALID");
  }
  return Number(value);
}

function validText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max || /[\p{Cc}]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function createdAt(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
  return date.toISOString();
}

function sourceRef(row: Record<string, unknown>): KnowledgeResourceSourceRef | undefined {
  const candidates = [
    ["document", row.document_id],
    ["source", row.provenance_source_id],
    ["file", row.file_path],
  ] as const;
  for (const [kind, value] of candidates) {
    const ref = validText(value, 512);
    if (ref) return Object.freeze({ kind, ref });
  }
  return undefined;
}

function safeBooleanMirror(value: unknown): boolean {
  return value === null || value === undefined || value === false || value === "false";
}

function parseContentLength(value: unknown): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
  }
  return parsed;
}

function parseRow(
  row: Record<string, unknown>,
  scope: readonly string[],
  options: {
    readonly contentLimit?: number;
    readonly expectedRef?: string;
    readonly expectedRevision?: string;
  } = {},
): KnowledgeResourceRecord {
  const ref = row.id;
  const revision = row.content_hash;
  const exact = row.tenant_id === scope[0] && row.user_id === scope[1] &&
    row.canonical_project_id === scope[2] && row.product_id === scope[3] &&
    row.producer_id === scope[4] && row.namespace === scope[5] &&
    row.visibility === scope[6] && (row.workspace_id ?? "") === scope[7];
  const lifecycle = row.lifecycle_status;
  if (!exact || typeof ref !== "string" || !UUID.test(ref) ||
      typeof revision !== "string" || !SAFE_REVISION.test(revision) ||
      (options.expectedRef !== undefined && ref !== options.expectedRef) ||
      (options.expectedRevision !== undefined && revision !== options.expectedRevision) ||
      (lifecycle !== null && lifecycle !== undefined &&
        lifecycle !== "active" && lifecycle !== "archived") ||
      !safeBooleanMirror(row.risk_blocked) || !safeBooleanMirror(row.conflict_unresolved)) {
    invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
  }
  const category = validText(row.category, 128) ?? "knowledge";
  const title = validText(row.title, 200) ?? `${category} ${ref.slice(0, 8)}`;
  const source = sourceRef(row);
  const base = {
    ref,
    revision,
    title,
    category,
    createdAt: createdAt(row.created_at),
    ...(source ? { sourceRef: source } : {}),
    evidence: Object.freeze({ kind: "knowledge_record" as const, ref, revision }),
  };
  if (options.contentLimit === undefined) return Object.freeze(base);
  if (typeof row.content !== "string") invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
  const contentLength = parseContentLength(row.content_length);
  return Object.freeze({
    ...base,
    content: row.content,
    truncated: contentLength > options.contentLimit,
  });
}

function rowsMatchCount(
  result: { readonly rows: readonly Record<string, unknown>[]; readonly rowCount?: number | null },
  limit: number,
): void {
  if (result.rows.length > limit ||
      (result.rowCount !== undefined && result.rowCount !== null &&
        result.rowCount !== result.rows.length)) {
    invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
  }
}

function escapedLikeLiteral(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export class PostgresKnowledgeResourceRepository implements KnowledgeResourceRepository {
  constructor(private readonly client: PostgresKnowledgeResourceQueryClient) {}

  async list(
    scope: MemoryScope,
    input: { readonly limit: number },
  ): Promise<readonly KnowledgeResourceRecord[]> {
    const params = scopeParams(scope);
    const limit = boundedInteger(input.limit, MAX_RESULT_ITEMS);
    const result = await this.client.query(
      `/* knowledge-resource:list */
SELECT ${RESOURCE_COLUMNS}
FROM knowledge
WHERE ${EXACT_SCOPE_SQL}
  AND ${GOVERNED_RESOURCE_SQL}
ORDER BY created_at DESC, id ASC
LIMIT $9`,
      [...params, limit],
    );
    rowsMatchCount(result, limit);
    const seen = new Set<string>();
    return Object.freeze(result.rows.map((row) => {
      const parsed = parseRow(row, params);
      if (seen.has(parsed.ref)) invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
      seen.add(parsed.ref);
      return parsed;
    }));
  }

  async search(
    scope: MemoryScope,
    input: { readonly query: string; readonly limit: number; readonly maxContentChars: number },
  ): Promise<readonly KnowledgeResourceRecord[]> {
    const params = scopeParams(scope);
    if (typeof input.query !== "string" || input.query.length < 1 ||
        input.query.length > MAX_QUERY_CHARS || input.query !== input.query.trim() ||
        /[\p{Cc}]/u.test(input.query)) {
      invalid("KNOWLEDGE_RESOURCE_INPUT_INVALID");
    }
    const limit = boundedInteger(input.limit, MAX_RESULT_ITEMS);
    const maxContentChars = boundedInteger(input.maxContentChars, MAX_CONTENT_CHARS);
    const result = await this.client.query(
      `/* knowledge-resource:search */
SELECT ${RESOURCE_COLUMNS}, LEFT(text, $10) AS content,
  char_length(text)::text AS content_length
FROM knowledge
WHERE ${EXACT_SCOPE_SQL}
  AND text ILIKE $9 ESCAPE '\\'
  AND ${GOVERNED_RESOURCE_SQL}
ORDER BY created_at DESC, id ASC
LIMIT $11`,
      [...params, escapedLikeLiteral(input.query), maxContentChars, limit],
    );
    rowsMatchCount(result, limit);
    const seen = new Set<string>();
    return Object.freeze(result.rows.map((row) => {
      const parsed = parseRow(row, params, { contentLimit: maxContentChars });
      if (seen.has(parsed.ref)) invalid("KNOWLEDGE_RESOURCE_ROW_INVALID");
      seen.add(parsed.ref);
      return parsed;
    }));
  }

  async read(
    scope: MemoryScope,
    input: { readonly ref: string; readonly revision: string; readonly maxContentChars: number },
  ): Promise<KnowledgeResourceRecord | undefined> {
    const params = scopeParams(scope);
    if (typeof input.ref !== "string" || !UUID.test(input.ref) ||
        typeof input.revision !== "string" || !SAFE_REVISION.test(input.revision)) {
      invalid("KNOWLEDGE_RESOURCE_INPUT_INVALID");
    }
    const maxContentChars = boundedInteger(input.maxContentChars, MAX_CONTENT_CHARS);
    const result = await this.client.query(
      `/* knowledge-resource:read */
SELECT ${RESOURCE_COLUMNS}, LEFT(text, $11) AS content,
  char_length(text)::text AS content_length
FROM knowledge
WHERE ${EXACT_SCOPE_SQL}
  AND id = $9::uuid AND content_hash = $10
  AND ${GOVERNED_RESOURCE_SQL}
LIMIT 1`,
      [...params, input.ref, input.revision, maxContentChars],
    );
    rowsMatchCount(result, 1);
    if (result.rows.length === 0) return undefined;
    return parseRow(result.rows[0]!, params, {
      contentLimit: maxContentChars,
      expectedRef: input.ref,
      expectedRevision: input.revision,
    });
  }
}
