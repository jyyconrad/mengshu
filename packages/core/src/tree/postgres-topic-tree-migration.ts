import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { normalizeTopicLabel } from "./tree-fan-out.js";

export type TopicTreeAliasStatus = "active" | "superseded" | "archived";

export interface PostgresTopicTreeMigrationQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** The caller owns the PostgreSQL client and transaction lifecycle. */
export interface PostgresTopicTreeMigrationQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresTopicTreeMigrationQueryResult<Row>>;
}

export interface PostgresTopicTreeAlias {
  readonly legacyTreeKey: string;
  readonly canonicalTopicLabel: string;
  readonly status: TopicTreeAliasStatus;
  readonly mergedFrom: readonly string[];
  readonly sealedNodeId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly supersededAt?: number;
  readonly archivedAt?: number;
}

export interface PersistPostgresTopicTreeAliasesInput {
  readonly scope: MemoryScope;
  readonly entities: readonly {
    readonly entityId: string;
    readonly canonicalName: string;
  }[];
  readonly now: number;
}

export interface ResolvePostgresTopicTreeReadKeysInput {
  readonly scope: MemoryScope;
  readonly requestedTreeKey: string;
}

export interface ResolvedPostgresTopicTreeReadKeys {
  readonly canonicalTopicLabel: string;
  readonly readTreeKeys: readonly string[];
  readonly aliases: readonly PostgresTopicTreeAlias[];
}

export interface MergeLegacyPostgresTopicBuffersInput {
  readonly scope: MemoryScope;
  readonly requestedTreeKey: string;
  readonly canonicalBufferId: string;
  readonly level: 0;
  readonly now: number;
}

export interface MergeLegacyPostgresTopicBuffersResult {
  readonly canonicalTopicLabel: string;
  readonly canonicalBufferId: string;
  readonly leafIds: readonly string[];
  readonly childNodeIds: readonly string[];
  readonly tokenCount: number;
  readonly mergedFrom: readonly string[];
  readonly converged: boolean;
}

export interface MarkPostgresTopicTreesSupersededInput {
  readonly scope: MemoryScope;
  readonly canonicalTopicLabel: string;
  readonly mergedFrom: readonly string[];
  readonly sealedNodeId: string;
  readonly now: number;
}

export interface ArchiveSupersededPostgresTopicTreesInput {
  readonly scope: MemoryScope;
  readonly supersededBefore: number;
  readonly now: number;
}

const SAFE_KEY = /^[^\s\p{Cc}]{1,256}$/u;
const STATUSES = new Set<TopicTreeAliasStatus>(["active", "superseded", "archived"]);
const ALIAS_KEYS = Object.freeze([
  "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id", "agent_id",
  "namespace", "visibility", "workspace_id", "session_id", "legacy_tree_key",
  "canonical_topic_label", "status", "merged_from", "created_at", "updated_at",
  "sealed_node_id", "superseded_at", "archived_at",
] as const);
const BUFFER_KEYS = Object.freeze([
  "id", "tree_key", "leaf_ids", "child_node_ids", "token_count", "opened_at", "updated_at",
] as const);
const LEAF_TOKEN_KEYS = Object.freeze(["id", "token_count"] as const);

const SCOPE_WHERE = `scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10`;
const ALIAS_COLUMNS = `scope_fingerprint, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, workspace_id, session_id, legacy_tree_key,
  canonical_topic_label, status, merged_from, created_at, updated_at,
  sealed_node_id, superseded_at, archived_at`;

const INSERT_ALIAS_SQL = `INSERT INTO mengshu_topic_tree_aliases (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, legacy_tree_key, canonical_topic_label, status, merged_from,
  created_at, updated_at, superseded_at, archived_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13::jsonb,
  $14, $14, NULL, NULL
)
ON CONFLICT (scope_fingerprint, legacy_tree_key) DO UPDATE SET
  merged_from = EXCLUDED.merged_from,
  updated_at = GREATEST(mengshu_topic_tree_aliases.updated_at, EXCLUDED.updated_at)
WHERE mengshu_topic_tree_aliases.canonical_topic_label = EXCLUDED.canonical_topic_label
  AND mengshu_topic_tree_aliases.status = 'active'`;
const SELECT_EXISTING_ALIASES_SQL = `SELECT ${ALIAS_COLUMNS}
FROM mengshu_topic_tree_aliases
WHERE ${SCOPE_WHERE}
  AND (canonical_topic_label = ANY($11::text[]) OR legacy_tree_key = ANY($12::text[]))
ORDER BY canonical_topic_label, legacy_tree_key
FOR UPDATE`;
const UPDATE_MERGED_FROM_SQL = `UPDATE mengshu_topic_tree_aliases
SET merged_from = $12::jsonb, updated_at = GREATEST(updated_at, $13)
WHERE ${SCOPE_WHERE} AND canonical_topic_label = $11 AND status = 'active'`;
const SELECT_CANONICAL_ALIASES_SQL = `SELECT ${ALIAS_COLUMNS}
FROM mengshu_topic_tree_aliases
WHERE ${SCOPE_WHERE} AND canonical_topic_label = ANY($11::text[])
ORDER BY canonical_topic_label, legacy_tree_key`;
const RESOLVE_ALIASES_SQL = `WITH requested AS (
  SELECT canonical_topic_label
  FROM mengshu_topic_tree_aliases
  WHERE ${SCOPE_WHERE}
    AND (legacy_tree_key = $11 OR canonical_topic_label = $12)
  ORDER BY CASE WHEN legacy_tree_key = $11 THEN 0 ELSE 1 END
  LIMIT 1
)
SELECT ${ALIAS_COLUMNS}
FROM mengshu_topic_tree_aliases
WHERE ${SCOPE_WHERE}
  AND canonical_topic_label = (SELECT canonical_topic_label FROM requested)
ORDER BY legacy_tree_key`;
const INSERT_CANONICAL_BUFFER_SQL = `INSERT INTO mengshu_tree_buffers (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, id, tree_type, tree_key, level, leaf_ids, child_node_ids,
  token_count, opened_at, updated_at, seal_after_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'topic', $12, $13,
  '[]'::jsonb, '[]'::jsonb, 0, $14, $14, NULL
)
ON CONFLICT (scope_fingerprint, tree_type, tree_key, level) DO NOTHING`;
const LOCK_TOPIC_BUFFERS_SQL = `SELECT id, tree_key, leaf_ids, child_node_ids, token_count,
  opened_at, updated_at
FROM mengshu_tree_buffers
WHERE ${SCOPE_WHERE} AND tree_type = 'topic' AND tree_key = ANY($11::text[]) AND level = $12
ORDER BY tree_key
FOR UPDATE`;
const SELECT_LEAF_TOKENS_SQL = `SELECT id, token_count
FROM mengshu_tree_leaves
WHERE ${SCOPE_WHERE} AND id = ANY($11::text[])
ORDER BY id`;
const UPDATE_CANONICAL_BUFFER_SQL = `UPDATE mengshu_tree_buffers SET
  leaf_ids = $14::jsonb, child_node_ids = $15::jsonb, token_count = $16,
  opened_at = $17, updated_at = $18
WHERE ${SCOPE_WHERE} AND id = $11 AND tree_type = 'topic'
  AND tree_key = $12 AND level = $13`;
const MARK_SUPERSEDED_SQL = `UPDATE mengshu_topic_tree_aliases SET
  status = 'superseded', merged_from = $12::jsonb, sealed_node_id = $13,
  superseded_at = COALESCE(superseded_at, $14), updated_at = GREATEST(updated_at, $14)
WHERE ${SCOPE_WHERE} AND canonical_topic_label = $11
  AND legacy_tree_key = ANY($15::text[]) AND status IN ('active', 'superseded')
RETURNING ${ALIAS_COLUMNS}`;
const ARCHIVE_SUPERSEDED_SQL = `UPDATE mengshu_topic_tree_aliases SET
  status = 'archived', archived_at = COALESCE(archived_at, $12),
  updated_at = GREATEST(updated_at, $12)
WHERE ${SCOPE_WHERE} AND status = 'superseded' AND superseded_at <= $11
  AND NOT EXISTS (
    SELECT 1 FROM mengshu_tree_buffers AS old_buffer
    WHERE old_buffer.scope_fingerprint = mengshu_topic_tree_aliases.scope_fingerprint
      AND old_buffer.tenant_id = mengshu_topic_tree_aliases.tenant_id
      AND old_buffer.user_id = mengshu_topic_tree_aliases.user_id
      AND old_buffer.app_id = mengshu_topic_tree_aliases.app_id
      AND old_buffer.project_id = mengshu_topic_tree_aliases.project_id
      AND old_buffer.agent_id = mengshu_topic_tree_aliases.agent_id
      AND old_buffer.namespace = mengshu_topic_tree_aliases.namespace
      AND old_buffer.visibility = mengshu_topic_tree_aliases.visibility
      AND old_buffer.workspace_id = mengshu_topic_tree_aliases.workspace_id
      AND old_buffer.session_id = mengshu_topic_tree_aliases.session_id
      AND old_buffer.tree_type = 'topic'
      AND old_buffer.tree_key = mengshu_topic_tree_aliases.legacy_tree_key
      AND old_buffer.updated_at > mengshu_topic_tree_aliases.superseded_at
  )
  AND NOT EXISTS (
    SELECT 1 FROM mengshu_tree_summary_nodes AS old_summary
    WHERE old_summary.scope_fingerprint = mengshu_topic_tree_aliases.scope_fingerprint
      AND old_summary.tenant_id = mengshu_topic_tree_aliases.tenant_id
      AND old_summary.user_id = mengshu_topic_tree_aliases.user_id
      AND old_summary.app_id = mengshu_topic_tree_aliases.app_id
      AND old_summary.project_id = mengshu_topic_tree_aliases.project_id
      AND old_summary.agent_id = mengshu_topic_tree_aliases.agent_id
      AND old_summary.namespace = mengshu_topic_tree_aliases.namespace
      AND old_summary.visibility = mengshu_topic_tree_aliases.visibility
      AND old_summary.workspace_id = mengshu_topic_tree_aliases.workspace_id
      AND old_summary.session_id = mengshu_topic_tree_aliases.session_id
      AND old_summary.tree_type = 'topic'
      AND old_summary.tree_key = mengshu_topic_tree_aliases.legacy_tree_key
      AND old_summary.created_at > mengshu_topic_tree_aliases.superseded_at
  )
RETURNING ${ALIAS_COLUMNS}`;
const ARCHIVE_LEGACY_SUMMARIES_SQL = `UPDATE mengshu_tree_summary_nodes SET
  status = 'archived'
WHERE ${SCOPE_WHERE} AND tree_type = 'topic' AND tree_key = ANY($11::text[])
  AND status <> 'archived'`;

function invalidInput(message = "Postgres topic tree migration input is invalid"): never {
  throw new Error(message);
}

function invalidRow(): never {
  throw new Error("Postgres topic tree migration row is invalid");
}

function safeKey(value: unknown): string {
  if (typeof value !== "string" || !SAFE_KEY.test(value)) invalidInput();
  return value;
}

function timestamp(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalidRow();
  return parsed;
}

function inputTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidInput();
  return Number(value);
}

function exactRow(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidRow();
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => !ownKeys.includes(key))) return invalidRow();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalidRow();
    result[key] = descriptor.value;
  }
  return result;
}

function denseKeys(value: unknown, row = false): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) return row ? invalidRow() : invalidInput();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return row ? invalidRow() : invalidInput();
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        typeof descriptor.value !== "string" || !SAFE_KEY.test(descriptor.value) ||
        seen.has(descriptor.value)) return row ? invalidRow() : invalidInput();
    seen.add(descriptor.value);
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function scopeSnapshot(scope: MemoryScope): {
  readonly authority: CanonicalAuthorityScope;
  readonly params: readonly unknown[];
} {
  let authority: CanonicalAuthorityScope;
  try {
    authority = canonicalAuthorityScope(scope);
  } catch {
    return invalidInput();
  }
  return Object.freeze({
    authority,
    params: Object.freeze([
      authorityScopeFingerprint(scope), authority.tenantId, authority.userId, authority.appId,
      authority.projectId, authority.agentId, authority.namespace, authority.visibility,
      authority.workspaceId, authority.sessionId,
    ]),
  });
}

function assertRowScope(row: Readonly<Record<string, unknown>>, binding: ReturnType<typeof scopeSnapshot>): void {
  const expected = binding.params;
  const actual = [
    row.scope_fingerprint, row.tenant_id, row.user_id, row.app_id, row.project_id,
    row.agent_id, row.namespace, row.visibility, row.workspace_id, row.session_id,
  ];
  if (actual.some((value, index) => value !== expected[index])) invalidRow();
}

function decodeAlias(value: unknown, binding: ReturnType<typeof scopeSnapshot>): PostgresTopicTreeAlias {
  const row = exactRow(value, ALIAS_KEYS);
  assertRowScope(row, binding);
  const legacyTreeKey = safeKey(row.legacy_tree_key);
  const canonicalTopicLabel = safeKey(row.canonical_topic_label);
  if (normalizeTopicLabel(canonicalTopicLabel) !== canonicalTopicLabel ||
      typeof row.status !== "string" || !STATUSES.has(row.status as TopicTreeAliasStatus)) {
    return invalidRow();
  }
  const mergedFrom = denseKeys(row.merged_from, true);
  if (!mergedFrom.includes(legacyTreeKey)) invalidRow();
  const createdAt = timestamp(row.created_at);
  const updatedAt = timestamp(row.updated_at);
  const sealedNodeId = row.sealed_node_id === null ? undefined : safeKey(row.sealed_node_id);
  const supersededAt = row.superseded_at === null ? undefined : timestamp(row.superseded_at);
  const archivedAt = row.archived_at === null ? undefined : timestamp(row.archived_at);
  if (updatedAt < createdAt || (supersededAt !== undefined && supersededAt < createdAt) ||
      (archivedAt !== undefined && (supersededAt === undefined || archivedAt < supersededAt)) ||
      (row.status === "active" && (sealedNodeId !== undefined || supersededAt !== undefined || archivedAt !== undefined)) ||
      (row.status === "superseded" && (sealedNodeId === undefined || supersededAt === undefined || archivedAt !== undefined)) ||
      (row.status === "archived" && (sealedNodeId === undefined || archivedAt === undefined))) return invalidRow();
  return Object.freeze({
    legacyTreeKey,
    canonicalTopicLabel,
    status: row.status as TopicTreeAliasStatus,
    mergedFrom,
    createdAt,
    updatedAt,
    ...(sealedNodeId === undefined ? {} : { sealedNodeId }),
    ...(supersededAt === undefined ? {} : { supersededAt }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  });
}

function decodeBuffer(value: unknown): {
  readonly id: string;
  readonly treeKey: string;
  readonly leafIds: readonly string[];
  readonly childNodeIds: readonly string[];
  readonly tokenCount: number;
  readonly openedAt: number;
  readonly updatedAt: number;
} {
  const row = exactRow(value, BUFFER_KEYS);
  const openedAt = timestamp(row.opened_at);
  const updatedAt = timestamp(row.updated_at);
  const tokenCount = timestamp(row.token_count);
  if (updatedAt < openedAt) invalidRow();
  return Object.freeze({
    id: safeKey(row.id),
    treeKey: safeKey(row.tree_key),
    leafIds: denseKeys(row.leaf_ids, true),
    childNodeIds: denseKeys(row.child_node_ids, true),
    tokenCount,
    openedAt,
    updatedAt,
  });
}

function decodeLeafToken(value: unknown): { readonly id: string; readonly tokenCount: number } {
  const row = exactRow(value, LEAF_TOKEN_KEYS);
  const tokenCount = timestamp(row.token_count);
  if (tokenCount < 1) invalidRow();
  return Object.freeze({ id: safeKey(row.id), tokenCount });
}

function resultRows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidRow();
  }
  const rows = Object.getOwnPropertyDescriptor(value, "rows")?.value;
  const rowCount = Object.getOwnPropertyDescriptor(value, "rowCount")?.value;
  if (!Array.isArray(rows) || nodeUtilTypes.isProxy(rows) || !Number.isSafeInteger(rowCount) ||
      rowCount !== rows.length) return invalidRow();
  return rows;
}

function dml(value: unknown, allowed: readonly number[]): number {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidRow();
  }
  const rows = Object.getOwnPropertyDescriptor(value, "rows")?.value;
  const rowCount = Object.getOwnPropertyDescriptor(value, "rowCount")?.value;
  if (!Array.isArray(rows) || nodeUtilTypes.isProxy(rows) || rows.length !== 0 ||
      !Number.isSafeInteger(rowCount) || !allowed.includes(rowCount)) invalidRow();
  return rowCount;
}

function dmlAny(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidRow();
  }
  const rows = Object.getOwnPropertyDescriptor(value, "rows")?.value;
  const rowCount = Object.getOwnPropertyDescriptor(value, "rowCount")?.value;
  if (!Array.isArray(rows) || nodeUtilTypes.isProxy(rows) || rows.length !== 0 ||
      !Number.isSafeInteger(rowCount) || Number(rowCount) < 0) invalidRow();
  return Number(rowCount);
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

/** M1: persist entity.id -> normalized topic-label aliases in the complete authority scope. */
export async function persistPostgresTopicTreeAliases(
  client: PostgresTopicTreeMigrationQueryClient,
  input: PersistPostgresTopicTreeAliasesInput,
): Promise<readonly PostgresTopicTreeAlias[]> {
  const binding = scopeSnapshot(input.scope);
  const now = inputTimestamp(input.now);
  if (!Array.isArray(input.entities) || input.entities.length === 0) invalidInput();
  const entities = input.entities.map((entity) => {
    const entityId = safeKey(entity.entityId);
    const canonicalTopicLabel = typeof entity.canonicalName === "string"
      ? normalizeTopicLabel(entity.canonicalName)
      : "";
    if (!canonicalTopicLabel) invalidInput();
    return Object.freeze({ entityId, canonicalTopicLabel });
  });
  if (new Set(entities.map((entity) => entity.entityId)).size !== entities.length) invalidInput();
  const labels = [...unique(entities.map((entity) => entity.canonicalTopicLabel))].sort();
  const existingRows = resultRows(await client.query(SELECT_EXISTING_ALIASES_SQL, [
    ...binding.params, labels, entities.map((entity) => entity.entityId).sort(),
  ]));
  const existingAliases = existingRows.map((row) => decodeAlias(row, binding));
  for (const entity of entities) {
    const existing = existingAliases.find((alias) => alias.legacyTreeKey === entity.entityId);
    if (existing && existing.canonicalTopicLabel !== entity.canonicalTopicLabel) invalidRow();
  }
  const groups = new Map<string, readonly string[]>();
  for (const label of labels) {
    groups.set(label, unique([
      ...existingAliases
        .filter((alias) => alias.canonicalTopicLabel === label)
        .flatMap((alias) => alias.mergedFrom),
      ...entities
        .filter((entity) => entity.canonicalTopicLabel === label)
        .map((entity) => entity.entityId),
    ]).slice().sort());
  }
  if (existingAliases.some((alias) => {
    if (alias.status === "active") return false;
    const expected = groups.get(alias.canonicalTopicLabel);
    return expected === undefined || expected.length !== alias.mergedFrom.length ||
      expected.some((key, index) => key !== alias.mergedFrom[index]);
  })) invalidRow();
  for (const entity of entities) {
    const mergedFrom = groups.get(entity.canonicalTopicLabel)!;
    dml(await client.query(INSERT_ALIAS_SQL, [
      ...binding.params, entity.entityId, entity.canonicalTopicLabel,
      JSON.stringify(mergedFrom), now,
    ]), [0, 1]);
  }
  for (const [label, mergedFrom] of groups) {
    dml(await client.query(UPDATE_MERGED_FROM_SQL, [
      ...binding.params, label, JSON.stringify(mergedFrom), now,
    ]), Array.from({ length: mergedFrom.length + 1 }, (_, index) => index));
  }
  const rows = resultRows(await client.query(SELECT_CANONICAL_ALIASES_SQL, [
    ...binding.params, [...groups.keys()].sort(),
  ]));
  const aliases = rows.map((row) => decodeAlias(row, binding));
  const expectedKeys = [...unique([...groups.values()].flat())].sort();
  const actualKeys = aliases.map((alias) => alias.legacyTreeKey).sort();
  if (aliases.length !== expectedKeys.length || new Set(actualKeys).size !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      aliases.some((alias) => {
        const expectedMergedFrom = groups.get(alias.canonicalTopicLabel);
        return expectedMergedFrom === undefined || alias.mergedFrom.length !== expectedMergedFrom.length ||
          alias.mergedFrom.some((key, index) => key !== expectedMergedFrom[index]);
      })) {
    invalidRow();
  }
  return Object.freeze(aliases);
}

/** M2: resolve either an old entity.id key or canonical label, preserving gray dual-read. */
export async function resolvePostgresTopicTreeReadKeys(
  client: PostgresTopicTreeMigrationQueryClient,
  input: ResolvePostgresTopicTreeReadKeysInput,
): Promise<ResolvedPostgresTopicTreeReadKeys> {
  const binding = scopeSnapshot(input.scope);
  const requested = input.requestedTreeKey;
  if (typeof requested !== "string" || requested.length < 1 || requested.length > 1_000 ||
      /[\p{Cc}]/u.test(requested)) invalidInput();
  const normalized = normalizeTopicLabel(requested);
  if (!normalized) invalidInput();
  const rows = resultRows(await client.query(RESOLVE_ALIASES_SQL, [
    ...binding.params, requested, normalized,
  ]));
  const aliases = rows.map((row) => decodeAlias(row, binding));
  if (aliases.length === 0) {
    return Object.freeze({
      canonicalTopicLabel: normalized,
      readTreeKeys: Object.freeze([normalized]),
      aliases: Object.freeze([]),
    });
  }
  const labels = unique(aliases.map((alias) => alias.canonicalTopicLabel));
  if (labels.length !== 1) invalidRow();
  const canonicalTopicLabel = labels[0]!;
  const legacyKeys = aliases
    .filter((alias) => alias.status !== "archived")
    .map((alias) => alias.legacyTreeKey)
    .sort();
  return Object.freeze({
    canonicalTopicLabel,
    readTreeKeys: unique([canonicalTopicLabel, ...legacyKeys]),
    aliases: Object.freeze(aliases),
  });
}

/**
 * M3/M4: copy old buffer membership into the canonical buffer under the caller's
 * existing transaction. Old buffers remain untouched for rollback.
 */
export async function mergeLegacyPostgresTopicBuffers(
  client: PostgresTopicTreeMigrationQueryClient,
  input: MergeLegacyPostgresTopicBuffersInput,
): Promise<MergeLegacyPostgresTopicBuffersResult> {
  const binding = scopeSnapshot(input.scope);
  const canonicalBufferId = safeKey(input.canonicalBufferId);
  const now = inputTimestamp(input.now);
  if (input.level !== 0) invalidInput();
  const resolved = await resolvePostgresTopicTreeReadKeys(client, {
    scope: input.scope,
    requestedTreeKey: input.requestedTreeKey,
  });
  dml(await client.query(INSERT_CANONICAL_BUFFER_SQL, [
    ...binding.params, canonicalBufferId, resolved.canonicalTopicLabel, input.level, now,
  ]), [0, 1]);
  const activeLegacyKeys = resolved.aliases
    .filter((alias) => alias.status === "active")
    .map((alias) => alias.legacyTreeKey)
    .sort();
  const readKeys = unique([resolved.canonicalTopicLabel, ...activeLegacyKeys]);
  const rows = resultRows(await client.query(LOCK_TOPIC_BUFFERS_SQL, [
    ...binding.params, readKeys, input.level,
  ]));
  const buffers = rows.map(decodeBuffer);
  if (new Set(buffers.map((buffer) => buffer.treeKey)).size !== buffers.length ||
      buffers.some((buffer) => !readKeys.includes(buffer.treeKey))) invalidRow();
  const canonical = buffers.find((buffer) => buffer.treeKey === resolved.canonicalTopicLabel);
  if (!canonical || canonical.id !== canonicalBufferId) invalidRow();
  const leafIds = unique(buffers.flatMap((buffer) => buffer.leafIds));
  const childNodeIds = unique(buffers.flatMap((buffer) => buffer.childNodeIds));
  const tokenRows = leafIds.length === 0
    ? []
    : resultRows(await client.query(SELECT_LEAF_TOKENS_SQL, [...binding.params, leafIds]));
  const leafTokens = tokenRows.map(decodeLeafToken);
  if (leafTokens.length !== leafIds.length || new Set(leafTokens.map((row) => row.id)).size !== leafIds.length ||
      leafTokens.some((row) => !leafIds.includes(row.id))) invalidRow();
  const tokenCount = leafTokens.reduce((sum, row) => sum + row.tokenCount, 0);
  if (!Number.isSafeInteger(tokenCount)) invalidRow();
  const openedAt = Math.min(...buffers.map((buffer) => buffer.openedAt));
  const updatedAt = Math.max(now, ...buffers.map((buffer) => buffer.updatedAt));
  const converged = buffers.some((buffer) => buffer.treeKey !== resolved.canonicalTopicLabel &&
    (buffer.leafIds.some((id) => !canonical.leafIds.includes(id)) ||
      buffer.childNodeIds.some((id) => !canonical.childNodeIds.includes(id)))) ||
    canonical.tokenCount !== tokenCount;
  dml(await client.query(UPDATE_CANONICAL_BUFFER_SQL, [
    ...binding.params, canonicalBufferId, resolved.canonicalTopicLabel, input.level,
    JSON.stringify(leafIds), JSON.stringify(childNodeIds), tokenCount, openedAt, updatedAt,
  ]), [1]);
  return Object.freeze({
    canonicalTopicLabel: resolved.canonicalTopicLabel,
    canonicalBufferId,
    leafIds,
    childNodeIds,
    tokenCount,
    mergedFrom: Object.freeze(activeLegacyKeys),
    converged,
  });
}

/** M3: seal completion supersedes aliases without deleting old trees. */
export async function markPostgresTopicTreesSuperseded(
  client: PostgresTopicTreeMigrationQueryClient,
  input: MarkPostgresTopicTreesSupersededInput,
): Promise<readonly PostgresTopicTreeAlias[]> {
  const binding = scopeSnapshot(input.scope);
  const canonicalTopicLabel = normalizeTopicLabel(safeKey(input.canonicalTopicLabel));
  if (!canonicalTopicLabel || canonicalTopicLabel !== input.canonicalTopicLabel) invalidInput();
  const mergedFrom = denseKeys(input.mergedFrom).slice().sort();
  const sealedNodeId = safeKey(input.sealedNodeId);
  const now = inputTimestamp(input.now);
  const rows = resultRows(await client.query(MARK_SUPERSEDED_SQL, [
    ...binding.params, canonicalTopicLabel, JSON.stringify(mergedFrom), sealedNodeId, now, mergedFrom,
  ]));
  const aliases = rows.map((row) => decodeAlias(row, binding));
  const returnedKeys = aliases.map((alias) => alias.legacyTreeKey).sort();
  if (aliases.length !== mergedFrom.length || returnedKeys.some((key, index) => key !== mergedFrom[index]) ||
      aliases.some((alias) => alias.status !== "superseded" ||
        alias.canonicalTopicLabel !== canonicalTopicLabel || alias.sealedNodeId !== sealedNodeId ||
        alias.mergedFrom.length !== mergedFrom.length ||
        alias.mergedFrom.slice().sort().some((key, index) => key !== mergedFrom[index]))) invalidRow();
  return Object.freeze(aliases);
}

/** M5: archive eligible superseded aliases; physical tree rows remain recoverable. */
export async function archiveSupersededPostgresTopicTrees(
  client: PostgresTopicTreeMigrationQueryClient,
  input: ArchiveSupersededPostgresTopicTreesInput,
): Promise<readonly PostgresTopicTreeAlias[]> {
  const binding = scopeSnapshot(input.scope);
  const supersededBefore = inputTimestamp(input.supersededBefore);
  const now = inputTimestamp(input.now);
  if (now < supersededBefore) invalidInput();
  const rows = resultRows(await client.query(ARCHIVE_SUPERSEDED_SQL, [
    ...binding.params, supersededBefore, now,
  ]));
  const aliases = rows.map((row) => decodeAlias(row, binding));
  const legacyTreeKeys = aliases.map((alias) => alias.legacyTreeKey).sort();
  if (legacyTreeKeys.length > 0) {
    dmlAny(await client.query(ARCHIVE_LEGACY_SUMMARIES_SQL, [
      ...binding.params, legacyTreeKeys,
    ]));
  }
  return Object.freeze(aliases);
}
