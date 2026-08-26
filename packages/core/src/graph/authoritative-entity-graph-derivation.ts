/**
 * F0 authoritative Entity Graph derivation.
 *
 * The module accepts only a persisted evidence fact and produces immutable graph,
 * evidence-ledger and canonical topic routing projections. It never reads topic
 * labels from memory text or free-form metadata.
 */

import { createHash } from "node:crypto";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  planTreeFanOut,
  type TreeFanOutPlan,
  type TreeFanOutRoutingInput,
} from "../tree/tree-fan-out.js";
import { computeHotness, TOPIC_CREATION_THRESHOLD } from "../tree/topic.js";
import type { TreeLeaf } from "../tree/types.js";
import { ENTITY_TYPES, RELATION_PREDICATES } from "./schema.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

export type AuthoritativeGraphKind = "entity";

export interface AuthoritativeEntityEvidenceFact {
  readonly authority: "persisted_evidence";
  readonly evidenceId: string;
  readonly scope: MemoryScope;
  readonly text: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly createdAt: number;
}

export interface AuthoritativeEntityGraphInput {
  readonly graphKind: AuthoritativeGraphKind;
  readonly memoryId: string;
  readonly evidence: AuthoritativeEntityEvidenceFact;
  readonly extraction: {
    readonly entities: readonly GraphEntityRecord[];
    readonly relations: readonly GraphRelationRecord[];
  };
}

export interface EntityGraphEvidenceLink {
  readonly id: string;
  readonly scope: CanonicalAuthorityScope;
  readonly targetKind: "entity" | "relation";
  readonly targetId: string;
  readonly evidenceId: string;
  readonly memoryId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly createdAt: number;
}

export interface EntityAliasProjection {
  readonly id: string;
  readonly scope: CanonicalAuthorityScope;
  readonly entityId: string;
  readonly alias: string;
  readonly normalizedAlias: string;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly createdAt: number;
}

export interface AuthoritativeEntityGraphDerivation {
  readonly scope: CanonicalAuthorityScope;
  readonly scopeFingerprint: string;
  readonly memoryId: string;
  readonly evidenceId: string;
  readonly evidenceSourceId: string;
  readonly evidenceSourceKind: string;
  readonly evidenceCreatedAt: number;
  readonly entities: readonly Readonly<GraphEntityRecord>[];
  readonly relations: readonly Readonly<GraphRelationRecord>[];
  readonly entityEvidenceLinks: readonly EntityGraphEvidenceLink[];
  readonly relationEvidenceLinks: readonly EntityGraphEvidenceLink[];
  readonly aliasProjections: readonly EntityAliasProjection[];
}

export interface EntityGraphAppliedReceipt {
  readonly status: "applied" | "replayed";
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly evidenceId: string;
}

export interface CanonicalEntityTopicMemoryFact {
  readonly memoryId: string;
  readonly scope: MemoryScope;
  readonly text: string;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly eventAt: number;
  readonly createdAt: number;
  readonly routing: TreeFanOutRoutingInput;
}

export interface CanonicalEntityTopicFanOutInput {
  readonly memory: CanonicalEntityTopicMemoryFact;
  readonly graphReceipt: EntityGraphAppliedReceipt;
  readonly canonicalFactsAuthority: "graph_repository";
  readonly canonicalEntities: readonly GraphEntityRecord[];
  readonly entityEvidenceLinks: readonly EntityGraphEvidenceLink[];
  readonly now: number;
  readonly topicAliases?: Readonly<Record<string, string>>;
}

export interface CanonicalEntityTopicFanOutProjection {
  readonly topicEntityIds: readonly string[];
  readonly topicLabels: readonly string[];
  readonly plan: TreeFanOutPlan;
  /** Runtime graph callback enqueues only these targets; source/global are planned elsewhere. */
  readonly topicTargets: TreeFanOutPlan["targets"];
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SAFE_TEXT = /[^\s]/u;
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const PREDICATE_SET = new Set<string>(RELATION_PREDICATES);
const ENTITY_STATUS_SET = new Set(["active", "archived", "merged"]);
const RELATION_STATUS_SET = new Set(["active", "weak", "contradicted", "archived"]);

function invalid(label: string): never {
  throw new Error(`Authoritative Entity Graph ${label} is invalid`);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && SAFE_TEXT.test(value) && value.trim() === value;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function finite(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  try {
    return authorityScopeFingerprint(left) === authorityScopeFingerprint(right);
  } catch {
    return false;
  }
}

function hashId(kind: string, values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify([kind, ...values])).digest("hex");
}

function strictJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("metadata");
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid("metadata");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => strictJson(item, ancestors)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("metadata");
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") {
        invalid("metadata");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        invalid("metadata");
      }
      output[key] = strictJson(descriptor.value, ancestors);
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function uniqueStrings(value: unknown, nonEmptyList = false): readonly string[] {
  if (!Array.isArray(value) || (nonEmptyList && value.length === 0) ||
      value.some((item) => !nonEmpty(item)) || new Set(value).size !== value.length) {
    invalid("string list");
  }
  return Object.freeze([...value]) as readonly string[];
}

function normalizedAliases(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid("alias list");
  const aliases: string[] = [];
  const normalized = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !SAFE_TEXT.test(item)) invalid("alias list");
    const alias = item.trim().replace(/\s+/gu, " ");
    const key = normalizeAlias(alias);
    if (!key || normalized.has(key)) continue;
    normalized.add(key);
    aliases.push(alias);
  }
  return Object.freeze(aliases);
}

function snapshotEntity(
  raw: GraphEntityRecord,
  scope: CanonicalAuthorityScope,
): Readonly<GraphEntityRecord> {
  if (!raw || typeof raw !== "object" || !safeId(raw.id) || !sameScope(raw.scope, scope) ||
      !nonEmpty(raw.canonicalName) || !nonEmpty(raw.displayName) ||
      !ENTITY_TYPE_SET.has(raw.type) || !ENTITY_STATUS_SET.has(raw.status) ||
      !integer(raw.mentionCount) || !integer(raw.mentionCount30d) ||
      !integer(raw.distinctSourceCount) || !finite(raw.hotness) || !integer(raw.queryHits30d) ||
      !integer(raw.createdAt) || !integer(raw.updatedAt) || raw.updatedAt < raw.createdAt ||
      (raw.lastSeenAt !== undefined && !integer(raw.lastSeenAt)) ||
      (raw.graphCentrality !== undefined && !finite(raw.graphCentrality)) ||
      (raw.mergedInto !== undefined && !safeId(raw.mergedInto))) {
    if (!sameScope(raw.scope, scope)) invalid("entity scope");
    invalid("entity");
  }
  const metadata = strictJson(raw.metadata);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalid("entity metadata");
  return Object.freeze({
    ...raw,
    scope,
    aliases: normalizedAliases(raw.aliases) as string[],
    metadata: metadata as Record<string, unknown>,
  });
}

function snapshotRelation(
  raw: GraphRelationRecord,
  scope: CanonicalAuthorityScope,
  entityIds: ReadonlySet<string>,
  evidenceId: string,
): Readonly<GraphRelationRecord> {
  if (!raw || typeof raw !== "object" || !safeId(raw.id) || !sameScope(raw.scope, scope) ||
      !entityIds.has(raw.subjectId) || !entityIds.has(raw.objectId) || raw.subjectId === raw.objectId ||
      !PREDICATE_SET.has(raw.predicate) || !finite(raw.confidence, Number.EPSILON, 1) ||
      !integer(raw.evidenceCount) || !integer(raw.firstSeenAt) || !integer(raw.lastSeenAt) ||
      raw.lastSeenAt < raw.firstSeenAt || !RELATION_STATUS_SET.has(raw.status)) {
    invalid("relation");
  }
  const evidenceIds = uniqueStrings(raw.evidenceChunkIds, true);
  const sourceKinds = uniqueStrings(raw.sourceKinds, true);
  if (evidenceIds.length !== 1 || evidenceIds[0] !== evidenceId || raw.evidenceCount !== 1) {
    invalid("relation evidence");
  }
  const metadata = strictJson(raw.metadata);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) invalid("relation metadata");
  return Object.freeze({
    ...raw,
    scope,
    evidenceChunkIds: evidenceIds as string[],
    sourceKinds: sourceKinds as string[],
    metadata: metadata as Record<string, unknown>,
  });
}

function normalizeAlias(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function evidenceLink(
  scope: CanonicalAuthorityScope,
  input: AuthoritativeEntityGraphInput,
  targetKind: EntityGraphEvidenceLink["targetKind"],
  targetId: string,
): EntityGraphEvidenceLink {
  const evidence = input.evidence;
  return Object.freeze({
    id: hashId("mengshu.entity-graph-evidence/v1", [
      authorityScopeFingerprint(scope), targetKind, targetId, evidence.evidenceId,
      input.memoryId, evidence.sourceId, evidence.sourceKind,
    ]),
    scope,
    targetKind,
    targetId,
    evidenceId: evidence.evidenceId,
    memoryId: input.memoryId,
    sourceId: evidence.sourceId,
    sourceKind: evidence.sourceKind,
    createdAt: evidence.createdAt,
  });
}

function aliasesFor(
  scope: CanonicalAuthorityScope,
  entity: Readonly<GraphEntityRecord>,
  evidence: AuthoritativeEntityEvidenceFact,
): readonly EntityAliasProjection[] {
  const seen = new Set<string>();
  const result: EntityAliasProjection[] = [];
  for (const alias of [entity.displayName, entity.canonicalName, ...entity.aliases]) {
    const normalizedAlias = normalizeAlias(alias);
    if (!normalizedAlias || seen.has(normalizedAlias)) continue;
    seen.add(normalizedAlias);
    result.push(Object.freeze({
      id: hashId("mengshu.entity-alias/v1", [
        authorityScopeFingerprint(scope), entity.id, normalizedAlias,
      ]),
      scope,
      entityId: entity.id,
      alias,
      normalizedAlias,
      evidenceId: evidence.evidenceId,
      sourceId: evidence.sourceId,
      createdAt: evidence.createdAt,
    }));
  }
  return Object.freeze(result);
}

export function deriveAuthoritativeEntityGraph(
  input: AuthoritativeEntityGraphInput,
): AuthoritativeEntityGraphDerivation {
  if (!input || input.graphKind !== "entity") invalid("graph kind");
  if (!safeId(input.memoryId) || !input.evidence ||
      input.evidence.authority !== "persisted_evidence" || !safeId(input.evidence.evidenceId) ||
      !nonEmpty(input.evidence.text) || !safeId(input.evidence.sourceId) ||
      !nonEmpty(input.evidence.sourceKind) || !integer(input.evidence.createdAt)) {
    invalid("evidence");
  }
  let scope: CanonicalAuthorityScope;
  try {
    scope = canonicalAuthorityScope(input.evidence.scope);
  } catch {
    invalid("evidence scope");
  }
  if (!input.extraction || !Array.isArray(input.extraction.entities) ||
      !Array.isArray(input.extraction.relations) || input.extraction.entities.length > 32 ||
      input.extraction.relations.length > 32) {
    invalid("extraction");
  }
  const entities = Object.freeze(input.extraction.entities.map((item) => snapshotEntity(item, scope)));
  const entityIds = new Set(entities.map((item) => item.id));
  if (entityIds.size !== entities.length) invalid("entity identity");
  const relations = Object.freeze(input.extraction.relations.map((item) =>
    snapshotRelation(item, scope, entityIds, input.evidence.evidenceId)));
  if (new Set(relations.map((item) => item.id)).size !== relations.length) invalid("relation identity");

  const entityEvidenceLinks = Object.freeze(entities.map((item) =>
    evidenceLink(scope, input, "entity", item.id)));
  const relationEvidenceLinks = Object.freeze(relations.map((item) =>
    evidenceLink(scope, input, "relation", item.id)));
  const aliasProjections = Object.freeze(entities.flatMap((item) =>
    aliasesFor(scope, item, input.evidence)));
  return Object.freeze({
    scope,
    scopeFingerprint: authorityScopeFingerprint(scope),
    memoryId: input.memoryId,
    evidenceId: input.evidence.evidenceId,
    evidenceSourceId: input.evidence.sourceId,
    evidenceSourceKind: input.evidence.sourceKind,
    evidenceCreatedAt: input.evidence.createdAt,
    entities,
    relations,
    entityEvidenceLinks,
    relationEvidenceLinks,
    aliasProjections,
  });
}

function validateReceipt(input: CanonicalEntityTopicFanOutInput): void {
  const receipt = input.graphReceipt;
  if (!receipt || (receipt.status !== "applied" && receipt.status !== "replayed") ||
      receipt.evidenceId !== input.memory.evidenceId || !Array.isArray(receipt.entityIds) ||
      !Array.isArray(receipt.relationIds) || receipt.entityIds.some((id) => !safeId(id)) ||
      receipt.relationIds.some((id) => !safeId(id)) || new Set(receipt.entityIds).size !== receipt.entityIds.length ||
      new Set(receipt.relationIds).size !== receipt.relationIds.length) {
    invalid("receipt");
  }
}

export function planCanonicalEntityTopicFanOut(
  input: CanonicalEntityTopicFanOutInput,
): CanonicalEntityTopicFanOutProjection {
  if (!input || !input.memory || !integer(input.now)) invalid("topic projection");
  if (input.canonicalFactsAuthority !== "graph_repository") invalid("canonical facts authority");
  validateReceipt(input);
  if (!safeId(input.memory.memoryId) || !safeId(input.memory.evidenceId) ||
      !safeId(input.memory.sourceId) || !nonEmpty(input.memory.text) ||
      !Array.isArray(input.memory.entityIds) || input.memory.entityIds.some((id) => !safeId(id))) {
    invalid("memory fact");
  }
  const scope = canonicalAuthorityScope(input.memory.scope);
  const receiptIds = new Set(input.graphReceipt.entityIds);
  const memoryEntityIds = new Set(input.memory.entityIds);
  const evidenceEntityIds = new Set(input.entityEvidenceLinks
    .filter((link) => link.targetKind === "entity" && link.evidenceId === input.memory.evidenceId &&
      link.memoryId === input.memory.memoryId && sameScope(link.scope, scope))
    .map((link) => link.targetId));
  const canonical = input.canonicalEntities.map((item) => snapshotEntity(item, scope));
  if (new Set(canonical.map((item) => item.id)).size !== canonical.length) invalid("canonical entity identity");

  const topicEntities = canonical
    .filter((item) => item.status === "active")
    .filter((item) => receiptIds.has(item.id) && memoryEntityIds.has(item.id) && evidenceEntityIds.has(item.id))
    .filter((item) => item.lastSeenAt !== undefined && item.graphCentrality !== undefined)
    .filter((item) => computeHotness(item, input.now) >= TOPIC_CREATION_THRESHOLD)
    .sort((left, right) => left.id.localeCompare(right.id));
  const topicLabels = Object.freeze(topicEntities.map((item) => item.canonicalName));
  const leaf: TreeLeaf = Object.freeze({
    id: input.memory.memoryId,
    scope,
    chunkId: input.memory.evidenceId,
    sourceId: input.memory.sourceId,
    entityIds: Object.freeze([...input.memory.entityIds]) as string[],
    importance: input.memory.routing.importance,
    eventAt: input.memory.eventAt,
    createdAt: input.memory.createdAt,
    text: input.memory.text,
  });
  const plan = planTreeFanOut({
    scope,
    leaf,
    routing: {
      ...input.memory.routing,
      topicLabels,
      topicHotnessEligible: topicLabels.length > 0,
    },
    ...(input.topicAliases === undefined ? {} : { topicAliases: input.topicAliases }),
  });
  return Object.freeze({
    topicEntityIds: Object.freeze(topicEntities.map((item) => item.id)),
    topicLabels,
    plan: Object.freeze({
      ...plan,
      targets: Object.freeze(plan.targets.map((target) => Object.freeze({ ...target }))),
      evidenceChunkIds: Object.freeze([...plan.evidenceChunkIds]),
      decision: Object.freeze({ ...plan.decision, treeTypes: Object.freeze([...plan.decision.treeTypes]) }),
    }) as TreeFanOutPlan,
    topicTargets: Object.freeze(plan.targets
      .filter((target) => target.treeType === "topic")
      .map((target) => Object.freeze({ ...target }))) as TreeFanOutPlan["targets"],
  });
}
