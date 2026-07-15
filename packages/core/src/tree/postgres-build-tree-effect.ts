import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemoryVisibility } from "../domain/types.js";
import {
  isDurableJobV2SafeIdentifier,
  type DurableJobV2Scope,
} from "../storage/repositories/job-v2.js";
import { bufferId } from "./buffer.js";
import type { MemoryTreeType } from "./types.js";

export const POSTGRES_BUILD_TREE_EFFECT_KEY = "build_tree.persist.v1" as const;
export const POSTGRES_BUILD_TREE_EFFECT_RELATIONS = Object.freeze([
  "mengshu_tree_leaves",
  "mengshu_tree_buffers",
  "mengshu_tree_summary_nodes",
] as const);

const VISIBILITIES = new Set<MemoryVisibility>(["private", "workspace", "team", "public"]);
const TREE_TYPES = new Set<MemoryTreeType>(["source", "topic", "global"]);
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const MAX_TEXT_LENGTH = 100_000;

const REQUEST_REQUIRED = Object.freeze(["effectKey", "effectInput", "semanticRequest"] as const);
const EFFECT_REQUIRED = Object.freeze([
  "id", "scope", "owner", "leaseToken", "leaseGeneration",
] as const);
const CORE_SCOPE_REQUIRED = Object.freeze([
  "tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility",
] as const);
const FULL_SCOPE_OPTIONAL = Object.freeze(["workspaceId", "sessionId"] as const);
const SEMANTIC_REQUIRED = Object.freeze([
  "type", "version", "traceId", "context", "treeType", "treeKey", "level", "policy",
  "leaf", "expectedBufferId",
] as const);
const POLICY_REQUIRED = Object.freeze(["maxLeafCount", "maxTokenCount"] as const);
const LEAF_REQUIRED = Object.freeze([
  "id", "scope", "chunkId", "sourceId", "entityIds", "importance", "eventAt", "createdAt",
  "text", "tokenCount",
] as const);

const INSERT_LEAF_SQL = `INSERT INTO mengshu_tree_leaves (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, id, source_job_id, chunk_id, source_id, entity_ids, importance,
  event_at, created_at, text, token_count
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
  $16, $17, $18, $19, $20
)
ON CONFLICT (scope_fingerprint, id) DO NOTHING`;

const UPDATE_LEAF_SQL = `UPDATE mengshu_tree_leaves SET
  source_job_id = $12, chunk_id = $13, source_id = $14, entity_ids = $15::jsonb,
  importance = $16, event_at = $17, created_at = $18, text = $19, token_count = $20
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10 AND id = $11`;

const INSERT_BUFFER_SQL = `INSERT INTO mengshu_tree_buffers (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, id, tree_type, tree_key, level, leaf_ids, child_node_ids,
  token_count, opened_at, updated_at, seal_after_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
  $16::jsonb, $17, $18, $19, $20
)
ON CONFLICT (scope_fingerprint, tree_type, tree_key, level) DO NOTHING`;

const LOCK_BUFFER_SQL = `SELECT id, leaf_ids, child_node_ids, token_count, opened_at, updated_at
FROM mengshu_tree_buffers
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10
  AND tree_type = $11 AND tree_key = $12 AND level = $13
FOR UPDATE`;

const UPDATE_BUFFER_SQL = `UPDATE mengshu_tree_buffers SET
  leaf_ids = $15::jsonb, child_node_ids = $16::jsonb, token_count = $17,
  opened_at = $18, updated_at = $19, seal_after_at = $20
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10 AND id = $11
  AND tree_type = $12 AND tree_key = $13 AND level = $14`;

const SELECT_LEAVES_SQL = `SELECT id, chunk_id, source_id, entity_ids, importance, event_at, created_at, text, token_count
FROM mengshu_tree_leaves
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10 AND id = ANY($11::text[])`;

const INSERT_SUMMARY_SQL = `INSERT INTO mengshu_tree_summary_nodes (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, id, sealed_by_job_id, tree_type, tree_key, level, title, summary,
  child_node_ids, leaf_ids, evidence_chunk_ids, entity_ids, relation_ids, token_count,
  start_at, end_at, status, created_at, sealed_at, metadata
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
  $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23, $24, $25, $26,
  $27, $28, $29::jsonb
)
ON CONFLICT (scope_fingerprint, id) DO NOTHING`;

const DELETE_BUFFER_SQL = `DELETE FROM mengshu_tree_buffers
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10 AND id = $11
  AND tree_type = $12 AND tree_key = $13 AND level = $14`;

export interface PostgresBuildTreeEffectQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Query capability owned by the caller's already-open fenced PostgreSQL transaction. */
export interface PostgresBuildTreeEffectQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresBuildTreeEffectQueryResult<Row>>;
}

export interface PostgresBuildTreeEffectInput {
  readonly id: string;
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

export interface PostgresBuildTreeEffectContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export interface PostgresBuildTreeEffectLeaf {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly importance: number;
  readonly eventAt: number;
  readonly createdAt: number;
  /** Native handler's generic TreeLeaf type keeps these optional; runtime validation requires both. */
  readonly text?: string;
  readonly tokenCount?: number;
}

export interface PostgresBuildTreeSemanticRequest {
  readonly type: "build_tree";
  readonly version: 1;
  readonly traceId: string;
  readonly context: PostgresBuildTreeEffectContext;
  readonly treeType: MemoryTreeType;
  readonly treeKey: string;
  readonly level: 0;
  readonly policy: {
    readonly maxLeafCount: 20;
    readonly maxTokenCount: 6000;
  };
  readonly leaf: PostgresBuildTreeEffectLeaf;
  readonly expectedBufferId: string;
}

/** Structural-compatible core contract for server/native-build-tree-handler.ts. */
export interface PostgresBuildTreeEffectRequest {
  readonly effectKey: typeof POSTGRES_BUILD_TREE_EFFECT_KEY;
  readonly effectInput: PostgresBuildTreeEffectInput;
  readonly semanticRequest: PostgresBuildTreeSemanticRequest;
}

export interface PostgresBuildTreeEffectResult extends Record<string, unknown> {
  readonly leafId: string;
  readonly sealed: boolean;
  readonly bufferId: string | null;
  readonly nodeId: string | null;
}

interface CanonicalLeaf {
  readonly id: string;
  readonly scope: Readonly<MemoryScope>;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly importance: number;
  readonly eventAt: number;
  readonly createdAt: number;
  readonly text: string;
  readonly tokenCount: number;
}

interface CanonicalRequest {
  readonly effectInput: Readonly<PostgresBuildTreeEffectInput>;
  readonly semanticRequest: Omit<PostgresBuildTreeSemanticRequest, "leaf" | "context" | "policy"> & {
    readonly context: Readonly<PostgresBuildTreeEffectContext>;
    readonly policy: Readonly<PostgresBuildTreeSemanticRequest["policy"]>;
    readonly leaf: CanonicalLeaf;
  };
  readonly authority: CanonicalAuthorityScope;
  readonly scopeFingerprint: string;
}

interface BufferRow {
  readonly id: string;
  readonly leafIds: readonly string[];
  readonly childNodeIds: readonly string[];
  readonly tokenCount: number;
  readonly openedAt: number;
  readonly updatedAt: number;
}

interface LeafRow {
  readonly id: string;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly importance: number;
  readonly eventAt: number;
  readonly createdAt: number;
  readonly text: string;
  readonly tokenCount: number;
}

function invalidInput(): never {
  throw new Error("Postgres build_tree effect input is invalid");
}

function invalidResult(): never {
  throw new Error("Postgres build_tree query result is invalid");
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidInput();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidInput();
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) return invalidInput();
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
      return invalidInput();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function safeId(value: unknown): value is string {
  return isDurableJobV2SafeIdentifier(value);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH &&
    !UNSAFE_TEXT.test(value) && !UNPAIRED_SURROGATE.test(value);
}

function denseSafeIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) return invalidInput();
  const length = value.length;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length") ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    return invalidInput();
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || !safeId(descriptor.value) ||
        seen.has(descriptor.value)) return invalidInput();
    seen.add(descriptor.value);
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function snapshotScope(value: unknown, allowContext: boolean): Readonly<MemoryScope> {
  const record = exactRecord(value, CORE_SCOPE_REQUIRED, allowContext ? FULL_SCOPE_OPTIONAL : []);
  for (const field of CORE_SCOPE_REQUIRED.slice(0, 6)) if (!safeId(record[field])) invalidInput();
  if (typeof record.visibility !== "string" || !VISIBILITIES.has(record.visibility as MemoryVisibility) ||
      (record.workspaceId !== undefined && !safeId(record.workspaceId)) ||
      (record.sessionId !== undefined && !safeId(record.sessionId))) return invalidInput();
  return Object.freeze({
    tenantId: record.tenantId as string,
    userId: record.userId as string,
    appId: record.appId as string,
    projectId: record.projectId as string,
    agentId: record.agentId as string,
    namespace: record.namespace as string,
    visibility: record.visibility as MemoryVisibility,
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId as string }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId as string }),
  });
}

function sameCoreScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

function snapshotRequest(value: unknown): CanonicalRequest {
  const request = exactRecord(value, REQUEST_REQUIRED);
  if (request.effectKey !== POSTGRES_BUILD_TREE_EFFECT_KEY) invalidInput();
  const effect = exactRecord(request.effectInput, EFFECT_REQUIRED);
  const effectScope = snapshotScope(effect.scope, false);
  if (!safeId(effect.id) || typeof effect.owner !== "string" || !OWNER.test(effect.owner) ||
      typeof effect.leaseToken !== "string" || !LEASE_TOKEN.test(effect.leaseToken) ||
      !Number.isSafeInteger(effect.leaseGeneration) || Number(effect.leaseGeneration) < 1) invalidInput();

  const semantic = exactRecord(request.semanticRequest, SEMANTIC_REQUIRED);
  const context = exactRecord(semantic.context, [], FULL_SCOPE_OPTIONAL);
  if ((context.workspaceId !== undefined && !safeId(context.workspaceId)) ||
      (context.sessionId !== undefined && !safeId(context.sessionId))) invalidInput();
  const policy = exactRecord(semantic.policy, POLICY_REQUIRED);
  const leaf = exactRecord(semantic.leaf, LEAF_REQUIRED);
  const leafScope = snapshotScope(leaf.scope, true);
  const entityIds = denseSafeIds(leaf.entityIds);
  if (semantic.type !== "build_tree" || semantic.version !== 1 || !safeId(semantic.traceId) ||
      typeof semantic.treeType !== "string" || !TREE_TYPES.has(semantic.treeType as MemoryTreeType) ||
      !safeId(semantic.treeKey) || semantic.level !== 0 ||
      policy.maxLeafCount !== 20 || policy.maxTokenCount !== 6000 ||
      !safeId(leaf.id) || leaf.id !== semantic.traceId || !safeId(leaf.chunkId) ||
      leaf.chunkId !== semantic.traceId || !safeId(leaf.sourceId) || !safeText(leaf.text) ||
      typeof leaf.importance !== "number" || !Number.isFinite(leaf.importance) ||
      leaf.importance < 0 || leaf.importance > 1 ||
      !Number.isSafeInteger(leaf.eventAt) || Number(leaf.eventAt) < 0 ||
      !Number.isSafeInteger(leaf.createdAt) || leaf.createdAt !== leaf.eventAt ||
      !Number.isSafeInteger(leaf.tokenCount) || Number(leaf.tokenCount) < 1 ||
      leaf.tokenCount !== Math.max(1, Math.ceil((leaf.text as string).length / 4)) ||
      !sameCoreScope(effectScope, leafScope) ||
      (context.workspaceId ?? "") !== (leafScope.workspaceId ?? "") ||
      (context.sessionId ?? "") !== (leafScope.sessionId ?? "")) invalidInput();

  const canonicalLeaf: CanonicalLeaf = Object.freeze({
    id: leaf.id as string,
    scope: leafScope,
    chunkId: leaf.chunkId as string,
    sourceId: leaf.sourceId as string,
    entityIds,
    importance: leaf.importance as number,
    eventAt: leaf.eventAt as number,
    createdAt: leaf.createdAt as number,
    text: leaf.text as string,
    tokenCount: leaf.tokenCount as number,
  });
  const canonicalContext = Object.freeze({
    ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId as string }),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId as string }),
  });
  const expectedId = bufferId(leafScope, semantic.treeType as MemoryTreeType, semantic.treeKey as string, 0);
  if (semantic.expectedBufferId !== expectedId) invalidInput();
  const authority = canonicalAuthorityScope(leafScope);
  return Object.freeze({
    effectInput: Object.freeze({
      id: effect.id as string,
      scope: effectScope as DurableJobV2Scope,
      owner: effect.owner as string,
      leaseToken: effect.leaseToken as string,
      leaseGeneration: effect.leaseGeneration as number,
    }),
    semanticRequest: Object.freeze({
      type: "build_tree" as const,
      version: 1 as const,
      traceId: semantic.traceId as string,
      context: canonicalContext,
      treeType: semantic.treeType as MemoryTreeType,
      treeKey: semantic.treeKey as string,
      level: 0 as const,
      policy: Object.freeze({ maxLeafCount: 20 as const, maxTokenCount: 6000 as const }),
      leaf: canonicalLeaf,
      expectedBufferId: expectedId,
    }),
    authority,
    scopeFingerprint: authorityScopeFingerprint(leafScope),
  });
}

function readQuery(client: unknown): PostgresBuildTreeEffectQueryClient["query"] {
  if (!client || typeof client !== "object" || nodeUtilTypes.isProxy(client)) invalidInput();
  const descriptor = Object.getOwnPropertyDescriptor(client, "query");
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    invalidInput();
  }
  return descriptor.value as PostgresBuildTreeEffectQueryClient["query"];
}

function bigint(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return invalidResult();
}

function rowRecord(value: unknown, required: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidResult();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length || required.some((key) => !keys.includes(key)) ||
      keys.some((key) => typeof key !== "string" || !required.includes(key))) return invalidResult();
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalidResult();
    result[key] = descriptor.value;
  }
  return result;
}

function resultRows<Row extends Record<string, unknown>>(
  value: unknown,
  expectedRowCount?: number,
): readonly Row[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidResult();
  }
  const descriptorRows = Object.getOwnPropertyDescriptor(value, "rows");
  const descriptorCount = Object.getOwnPropertyDescriptor(value, "rowCount");
  if (!descriptorRows || !("value" in descriptorRows) || !Array.isArray(descriptorRows.value) ||
      nodeUtilTypes.isProxy(descriptorRows.value) ||
      !descriptorCount || !("value" in descriptorCount) ||
      !Number.isSafeInteger(descriptorCount.value) || descriptorCount.value < 0 ||
      descriptorCount.value !== descriptorRows.value.length ||
      (expectedRowCount !== undefined && descriptorCount.value !== expectedRowCount)) {
    return invalidResult();
  }
  return descriptorRows.value as readonly Row[];
}

function dmlResult(value: unknown, allowed: readonly number[]): number {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalidResult();
  }
  const descriptorRows = Object.getOwnPropertyDescriptor(value, "rows");
  const descriptorCount = Object.getOwnPropertyDescriptor(value, "rowCount");
  if (!descriptorRows || !("value" in descriptorRows) || !Array.isArray(descriptorRows.value) ||
      nodeUtilTypes.isProxy(descriptorRows.value) || descriptorRows.value.length !== 0 ||
      !descriptorCount || !("value" in descriptorCount) ||
      !Number.isSafeInteger(descriptorCount.value) || !allowed.includes(descriptorCount.value)) {
    return invalidResult();
  }
  const rowCount = descriptorCount.value as number;
  return rowCount;
}

function safeRowIds(value: unknown): readonly string[] {
  try {
    return denseSafeIds(value);
  } catch {
    return invalidResult();
  }
}

function decodeBuffer(value: unknown, expectedId: string): BufferRow {
  const row = rowRecord(value, [
    "id", "leaf_ids", "child_node_ids", "token_count", "opened_at", "updated_at",
  ]);
  if (row.id !== expectedId) return invalidResult();
  const leafIds = safeRowIds(row.leaf_ids);
  const childNodeIds = safeRowIds(row.child_node_ids);
  const tokenCount = bigint(row.token_count);
  const openedAt = bigint(row.opened_at);
  const updatedAt = bigint(row.updated_at);
  if (updatedAt < openedAt) return invalidResult();
  return Object.freeze({ id: expectedId, leafIds, childNodeIds, tokenCount, openedAt, updatedAt });
}

function decodeLeaf(value: unknown): LeafRow {
  const row = rowRecord(value, [
    "id", "chunk_id", "source_id", "entity_ids", "importance", "event_at", "created_at",
    "text", "token_count",
  ]);
  if (!safeId(row.id) || !safeId(row.chunk_id) || !safeId(row.source_id) ||
      typeof row.importance !== "number" || !Number.isFinite(row.importance) ||
      row.importance < 0 || row.importance > 1 || !safeText(row.text)) return invalidResult();
  const entityIds = safeRowIds(row.entity_ids);
  const eventAt = bigint(row.event_at);
  const createdAt = bigint(row.created_at);
  const tokenCount = bigint(row.token_count);
  if (tokenCount < 1) return invalidResult();
  return Object.freeze({
    id: row.id,
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    entityIds,
    importance: row.importance,
    eventAt,
    createdAt,
    text: row.text,
    tokenCount,
  });
}

function scopeParams(request: CanonicalRequest): readonly unknown[] {
  const scope = request.authority;
  return Object.freeze([
    request.scopeFingerprint,
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
    scope.workspaceId,
    scope.sessionId,
  ]);
}

function summaryId(request: CanonicalRequest, leafIds: readonly string[]): string {
  return `sum_${createHash("sha256").update(JSON.stringify([
    "mengshu.tree-summary/v1",
    request.scopeFingerprint,
    request.semanticRequest.treeType,
    request.semanticRequest.treeKey,
    1,
    ...leafIds.slice().sort(),
  ])).digest("hex").slice(0, 24)}`;
}

function orderedLeaves(leaves: readonly LeafRow[]): readonly LeafRow[] {
  return leaves.slice().sort((left, right) =>
    right.importance - left.importance || right.eventAt - left.eventAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Applies only the tree domain mutation. Fence, fingerprint and receipt are owned by the caller.
 * The supplied client must belong to that same already-open PostgreSQL transaction.
 */
export async function executePostgresBuildTreeDomainEffect(
  client: PostgresBuildTreeEffectQueryClient,
  rawRequest: PostgresBuildTreeEffectRequest,
): Promise<PostgresBuildTreeEffectResult> {
  const request = snapshotRequest(rawRequest);
  const query = readQuery(client);
  const semantic = request.semanticRequest;
  const leaf = semantic.leaf;
  const scope = scopeParams(request);
  const leafParams = Object.freeze([
    ...scope,
    leaf.id,
    request.effectInput.id,
    leaf.chunkId,
    leaf.sourceId,
    JSON.stringify(leaf.entityIds),
    leaf.importance,
    leaf.eventAt,
    leaf.createdAt,
    leaf.text,
    leaf.tokenCount,
  ]);
  dmlResult(await Reflect.apply(query, client, [INSERT_LEAF_SQL, leafParams]), [0, 1]);
  dmlResult(await Reflect.apply(query, client, [UPDATE_LEAF_SQL, leafParams]), [1]);

  const bufferParams = Object.freeze([
    ...scope,
    semantic.expectedBufferId,
    semantic.treeType,
    semantic.treeKey,
    semantic.level,
    JSON.stringify([]),
    JSON.stringify([]),
    0,
    leaf.createdAt,
    leaf.createdAt,
    null,
  ]);
  dmlResult(await Reflect.apply(query, client, [INSERT_BUFFER_SQL, bufferParams]), [0, 1]);
  const lockParams = Object.freeze([
    ...scope, semantic.treeType, semantic.treeKey, semantic.level,
  ]);
  const lockedRows = resultRows<Record<string, unknown>>(
    await Reflect.apply(query, client, [LOCK_BUFFER_SQL, lockParams]),
    1,
  );
  const existing = decodeBuffer(lockedRows[0], semantic.expectedBufferId);
  const alreadyBuffered = existing.leafIds.includes(leaf.id);
  const leafIds = Object.freeze(alreadyBuffered
    ? [...existing.leafIds]
    : [...existing.leafIds, leaf.id]);
  const tokenCount = alreadyBuffered ? existing.tokenCount : existing.tokenCount + leaf.tokenCount;
  if (!Number.isSafeInteger(tokenCount)) invalidResult();
  const updatedAt = Math.max(existing.updatedAt, leaf.createdAt);
  const updateParams = Object.freeze([
    ...scope,
    existing.id,
    semantic.treeType,
    semantic.treeKey,
    semantic.level,
    JSON.stringify(leafIds),
    JSON.stringify(existing.childNodeIds),
    tokenCount,
    existing.openedAt,
    updatedAt,
    null,
  ]);
  dmlResult(await Reflect.apply(query, client, [UPDATE_BUFFER_SQL, updateParams]), [1]);

  const shouldSeal = leafIds.length >= semantic.policy.maxLeafCount ||
    tokenCount >= semantic.policy.maxTokenCount;
  if (!shouldSeal) {
    return Object.freeze({
      leafId: leaf.id,
      sealed: false,
      bufferId: existing.id,
      nodeId: null,
    });
  }

  const leafRows = resultRows<Record<string, unknown>>(
    await Reflect.apply(query, client, [SELECT_LEAVES_SQL, Object.freeze([...scope, leafIds])]),
    leafIds.length,
  );
  const leaves = leafRows.map(decodeLeaf);
  const byId = new Map(leaves.map((item) => [item.id, item]));
  if (byId.size !== leafIds.length || leafIds.some((id) => !byId.has(id))) invalidResult();
  const sorted = orderedLeaves(leaves);
  const summary = sorted.slice(0, 5).map((item) => item.text.trim()).join("\n\n") ||
    `${leaves.length} events sealed.`;
  const evidenceChunkIds = Object.freeze([...new Set(leaves.map((item) => item.chunkId))].sort());
  const entityIds = Object.freeze([...new Set(leaves.flatMap((item) => item.entityIds))].sort());
  const eventTimes = leaves.map((item) => item.eventAt);
  const sealedAt = Math.max(...leaves.map((item) => item.createdAt));
  const nodeId = summaryId(request, leafIds);
  const summaryParams = Object.freeze([
    ...scope,
    nodeId,
    request.effectInput.id,
    semantic.treeType,
    semantic.treeKey,
    1,
    `${semantic.treeType}:${semantic.treeKey}`,
    summary,
    JSON.stringify(existing.childNodeIds),
    JSON.stringify(leafIds),
    JSON.stringify(evidenceChunkIds),
    JSON.stringify(entityIds),
    JSON.stringify([]),
    tokenCount,
    Math.min(...eventTimes),
    Math.max(...eventTimes),
    "sealed",
    sealedAt,
    sealedAt,
    JSON.stringify({ summaryMode: "extractive" }),
  ]);
  dmlResult(await Reflect.apply(query, client, [INSERT_SUMMARY_SQL, summaryParams]), [0, 1]);
  const deleteParams = Object.freeze([
    ...scope, existing.id, semantic.treeType, semantic.treeKey, semantic.level,
  ]);
  dmlResult(await Reflect.apply(query, client, [DELETE_BUFFER_SQL, deleteParams]), [1]);
  return Object.freeze({
    leafId: leaf.id,
    sealed: true,
    bufferId: null,
    nodeId,
  });
}
