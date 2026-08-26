import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import {
  MemoryViewAssetError,
  validateAssetIdentifier,
  validateAssetText,
  validateMemoryProjectionContentRef,
} from "./content-ref.js";
import type { MemoryViewAssetRepository } from "./repository.js";
import type {
  ChangeMemoryViewAssetStatusInput,
  CreateMemoryViewAssetVersionInput,
  MemoryViewAssetDescriptor,
  MemoryViewAssetQualitySnapshot,
  MemoryViewAssetReadResult,
  MemoryViewAssetSearchField,
  MemoryViewAssetSearchResult,
  MemoryViewAssetStatus,
  MemoryViewMemoryFact,
  MemoryViewPromotionDecision,
  MemoryViewPromotionReceipt,
  MemoryViewPromotionResult,
  MemoryViewSourceResolver,
  MemoryViewSourceSnapshot,
  SearchMemoryViewAssetsInput,
} from "./types.js";

export { MemoryViewAssetError } from "./content-ref.js";
export type {
  MemoryViewMemoryFact,
  MemoryViewSourceResolver,
  MemoryViewTreeFact,
} from "./types.js";

const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const ASSET_STATUSES = new Set<MemoryViewAssetStatus>([
  "draft", "review", "published", "deprecated", "revoked",
]);
const PROMOTION_DECISIONS = new Set<MemoryViewPromotionDecision>([
  "private_scope", "content_ref_valid", "exact_scope", "active_memory",
  "evidence_complete", "semantic_type_consistent", "conflict_free", "risk_free",
  "faithfulness_passed",
]);

function canonicalPrivateScope(scope: MemoryScope): MemoryScope & { visibility: "private" } {
  const normalized = scope.visibility === undefined
    ? { ...scope, visibility: "private" as const }
    : scope;
  if (normalized.visibility !== "private") {
    throw new MemoryViewAssetError("PRIVATE_SCOPE_REQUIRED");
  }
  try {
    authorityScopeFingerprint(normalized);
  } catch {
    throw new MemoryViewAssetError("INVALID_INPUT", "scope is invalid");
  }
  return Object.freeze({ ...normalized, visibility: "private" });
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  try {
    return authorityScopeFingerprint(canonicalPrivateScope(left)) ===
      authorityScopeFingerprint(canonicalPrivateScope(right));
  } catch {
    return false;
  }
}

function strings(value: readonly string[], label: string, allowEmpty = true): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((item) => typeof item !== "string" || item.trim().length === 0 ||
        item !== item.trim() || /\p{Cc}/u.test(item)) || new Set(value).size !== value.length) {
    throw new MemoryViewAssetError("INVALID_INPUT", `${label} is invalid`);
  }
  return Object.freeze([...value]);
}

function semanticTypes(value: readonly MemorySemanticType[]): readonly MemorySemanticType[] {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((item) => !SEMANTIC_TYPES.has(item)) || new Set(value).size !== value.length) {
    throw new MemoryViewAssetError("INVALID_INPUT", "semanticTypes is invalid");
  }
  return Object.freeze([...value]);
}

function qualitySnapshot(value: MemoryViewAssetQualitySnapshot): MemoryViewAssetQualitySnapshot {
  if (!value || typeof value !== "object" || typeof value.scoringVersion !== "string" ||
      value.scoringVersion.trim().length === 0 || /\p{Cc}/u.test(value.scoringVersion)) {
    throw new MemoryViewAssetError("INVALID_INPUT", "qualitySnapshot is invalid");
  }
  for (const score of [value.minValueScore, value.importance, value.confidence, value.hotness]) {
    if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 1)) {
      throw new MemoryViewAssetError("INVALID_INPUT", "qualitySnapshot score is invalid");
    }
  }
  return Object.freeze({ ...value });
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    throw new MemoryViewAssetError("INVALID_INPUT", "timestamp is invalid");
  }
  return value;
}

/** Treat persisted JSONB as untrusted input before it crosses the repository boundary. */
export function validatePersistedMemoryViewAssetDescriptor(
  value: unknown,
): MemoryViewAssetDescriptor {
  const keys = [
    "id", "kind", "owner", "title", "description", "semanticTypes", "sourceScope",
    "version", "status", "visibility", "contentRef", "provenanceRefs", "evidenceRefs",
    "riskFlags", "qualitySnapshot", "createdAt", "updatedAt",
  ];
  if (!plainRecord(value) || !exactKeys(value, keys) || value.kind !== "memory_view" ||
      value.visibility !== "private" || !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1 || typeof value.status !== "string" ||
      !ASSET_STATUSES.has(value.status as MemoryViewAssetStatus) ||
      !plainRecord(value.owner) || Object.keys(value.owner).length !== 2 ||
      value.owner.subjectType !== "user") {
    throw new MemoryViewAssetError("INVALID_INPUT", "persisted descriptor is invalid");
  }
  const scope = canonicalPrivateScope(value.sourceScope as MemoryScope);
  const ownerId = validateAssetIdentifier(value.owner.subjectId, "owner.subjectId");
  if (ownerId !== scope.userId) throw new MemoryViewAssetError("OWNER_SCOPE_MISMATCH");
  const declaredTypes = semanticTypes(value.semanticTypes as readonly MemorySemanticType[]);
  const contentRef = validateMemoryProjectionContentRef(value.contentRef);
  if (!exactSet(declaredTypes, contentRef.semanticTypes)) {
    throw new MemoryViewAssetError("SEMANTIC_TYPE_MISMATCH");
  }
  const evidenceRefs = strings(value.evidenceRefs as readonly string[], "evidenceRefs", false);
  if (!exactSet(evidenceRefs, contentRef.evidenceIds)) {
    throw new MemoryViewAssetError("EVIDENCE_MISMATCH");
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new MemoryViewAssetError("INVALID_INPUT", "updatedAt precedes createdAt");
  }
  return deepFreeze({
    id: validateAssetIdentifier(value.id, "assetId"),
    kind: "memory_view",
    owner: { subjectType: "user", subjectId: ownerId },
    title: validateAssetText(value.title, "title", 256),
    ...(value.description === undefined
      ? {}
      : { description: validateAssetText(value.description, "description", 2_000) }),
    semanticTypes: declaredTypes,
    sourceScope: scope,
    version: value.version as number,
    status: value.status as MemoryViewAssetStatus,
    visibility: "private",
    contentRef,
    provenanceRefs: strings(value.provenanceRefs as readonly string[], "provenanceRefs"),
    evidenceRefs,
    riskFlags: strings(value.riskFlags as readonly string[], "riskFlags"),
    qualitySnapshot: qualitySnapshot(value.qualitySnapshot as MemoryViewAssetQualitySnapshot),
    createdAt,
    updatedAt,
  });
}

export function validatePersistedMemoryViewPromotionReceipt(
  value: unknown,
): MemoryViewPromotionReceipt {
  const keys = [
    "id", "requestKey", "requestHash", "assetId", "assetVersion", "scopeFingerprint",
    "targetStatus", "decisions", "createdAt",
  ];
  if (!plainRecord(value) || Object.keys(value).length !== keys.length ||
      !exactKeys(value, keys) || typeof value.requestHash !== "string" ||
      !SHA256.test(value.requestHash) || typeof value.scopeFingerprint !== "string" ||
      !SHA256.test(value.scopeFingerprint) || !Number.isSafeInteger(value.assetVersion) ||
      (value.assetVersion as number) < 1 || typeof value.targetStatus !== "string" ||
      !ASSET_STATUSES.has(value.targetStatus as MemoryViewAssetStatus) ||
      !Array.isArray(value.decisions) ||
      value.decisions.some((item) => typeof item !== "string" ||
        !PROMOTION_DECISIONS.has(item as MemoryViewPromotionDecision)) ||
      new Set(value.decisions).size !== value.decisions.length) {
    throw new MemoryViewAssetError("INVALID_INPUT", "persisted receipt is invalid");
  }
  return deepFreeze({
    id: validateAssetIdentifier(value.id, "receiptId"),
    requestKey: validateAssetIdentifier(value.requestKey, "requestKey"),
    requestHash: value.requestHash,
    assetId: validateAssetIdentifier(value.assetId, "assetId"),
    assetVersion: value.assetVersion as number,
    scopeFingerprint: value.scopeFingerprint,
    targetStatus: value.targetStatus as MemoryViewAssetStatus,
    decisions: Object.freeze([...(value.decisions as MemoryViewPromotionDecision[])]),
    createdAt: timestamp(value.createdAt),
  });
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item) => expected.includes(item));
}

function validatePublishedSources(
  scope: MemoryScope,
  declaredTypes: readonly MemorySemanticType[],
  contentRef: ReturnType<typeof validateMemoryProjectionContentRef>,
  snapshot: MemoryViewSourceSnapshot | undefined,
  riskFlags: readonly string[],
): readonly MemoryViewPromotionDecision[] {
  if (!snapshot) throw new MemoryViewAssetError("INVALID_INPUT", "sourceSnapshot is required");
  if (!Array.isArray(snapshot.memories) || !Array.isArray(snapshot.trees)) {
    throw new MemoryViewAssetError("INVALID_INPUT", "sourceSnapshot is invalid");
  }
  if (!exactSet(snapshot.memories.map((item) => item.id), contentRef.recordIds) ||
      !exactSet(snapshot.trees.map((item) => item.id), contentRef.treeNodeIds)) {
    throw new MemoryViewAssetError("SOURCE_REFERENCE_MISMATCH");
  }
  for (const memory of snapshot.memories) {
    if (!sameScope(memory.scope, scope)) throw new MemoryViewAssetError("SOURCE_SCOPE_MISMATCH");
    if (memory.lifecycleStatus !== "active") throw new MemoryViewAssetError("MEMORY_NOT_ACTIVE");
    if (memory.evidenceIds.length === 0) throw new MemoryViewAssetError("EVIDENCE_REQUIRED");
    if (memory.evidenceIds.some((id: string) => !contentRef.evidenceIds.includes(id))) {
      throw new MemoryViewAssetError("EVIDENCE_MISMATCH");
    }
    if (!memory.semanticType || !declaredTypes.includes(memory.semanticType) ||
        !contentRef.semanticTypes.includes(memory.semanticType)) {
      throw new MemoryViewAssetError("SEMANTIC_TYPE_MISMATCH");
    }
    if (memory.unresolvedConflict) throw new MemoryViewAssetError("UNRESOLVED_CONFLICT");
    if (memory.riskFlags.length > 0) throw new MemoryViewAssetError("RISK_NOT_CLEARED");
  }
  for (const tree of snapshot.trees) {
    if (!sameScope(tree.scope, scope)) throw new MemoryViewAssetError("SOURCE_SCOPE_MISMATCH");
    if (tree.stale) throw new MemoryViewAssetError("MEMORY_NOT_ACTIVE");
    if (tree.evidenceIds.length === 0) throw new MemoryViewAssetError("EVIDENCE_REQUIRED");
    if (tree.evidenceIds.some((id: string) => !contentRef.evidenceIds.includes(id))) {
      throw new MemoryViewAssetError("EVIDENCE_MISMATCH");
    }
    if (tree.semanticTypes.length === 0 ||
        tree.semanticTypes.some((type: MemorySemanticType) => !declaredTypes.includes(type))) {
      throw new MemoryViewAssetError("SEMANTIC_TYPE_MISMATCH");
    }
  }
  const provenEvidence = new Set([
    ...snapshot.memories.flatMap((item) => item.evidenceIds),
    ...snapshot.trees.flatMap((item) => item.evidenceIds),
  ]);
  if (contentRef.evidenceIds.some((id) => !provenEvidence.has(id))) {
    throw new MemoryViewAssetError("EVIDENCE_MISMATCH");
  }
  if (riskFlags.length > 0) throw new MemoryViewAssetError("RISK_NOT_CLEARED");
  if (snapshot.faithfulnessPassed !== true) {
    throw new MemoryViewAssetError("FAITHFULNESS_REQUIRED");
  }
  return Object.freeze([
    "private_scope", "content_ref_valid", "exact_scope", "active_memory",
    "evidence_complete", "semantic_type_consistent", "conflict_free", "risk_free",
    "faithfulness_passed",
  ] as const);
}

export class MemoryViewAssetService {
  readonly #repository: MemoryViewAssetRepository;
  readonly #resolver?: MemoryViewSourceResolver;

  constructor(input: {
    readonly repository: MemoryViewAssetRepository;
    readonly sourceResolver?: MemoryViewSourceResolver;
  }) {
    this.#repository = input.repository;
    this.#resolver = input.sourceResolver;
  }

  async list(scopeInput: MemoryScope): Promise<readonly MemoryViewAssetDescriptor[]> {
    const scope = canonicalPrivateScope(scopeInput);
    return deepFreeze([...(await this.#repository.listLatest(scope))]
      .filter((asset) => asset.status !== "revoked")
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  async search(
    scopeInput: MemoryScope,
    input: SearchMemoryViewAssetsInput,
  ): Promise<MemoryViewAssetSearchResult> {
    const scope = canonicalPrivateScope(scopeInput);
    if (!input || typeof input.query !== "string" || input.query.trim().length === 0 ||
        input.query.length > 512 || /\p{Cc}/u.test(input.query) ||
        (input.limit !== undefined &&
          (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) ||
        (input.semanticType !== undefined && !SEMANTIC_TYPES.has(input.semanticType))) {
      throw new MemoryViewAssetError("INVALID_INPUT", "asset search input is invalid");
    }
    const query = input.query.trim().toLocaleLowerCase();
    const filtered: MemoryViewAssetSearchResult["filtered"][number][] = [];
    const matched: MemoryViewAssetSearchResult["assets"][number][] = [];
    const assets = [...await this.list(scope)];
    for (const asset of assets) {
      if (input.semanticType !== undefined && !asset.semanticTypes.includes(input.semanticType)) {
        filtered.push({ assetId: asset.id, reason: "semantic_type_mismatch" });
        continue;
      }
      const fields: MemoryViewAssetSearchField[] = [];
      if (asset.title.toLocaleLowerCase().includes(query)) fields.push("title");
      if (asset.description?.toLocaleLowerCase().includes(query)) fields.push("description");
      if (asset.semanticTypes.some((type) => type.toLocaleLowerCase().includes(query))) {
        fields.push("semanticTypes");
      }
      const sourceRefs = [
        ...asset.contentRef.recordIds,
        ...asset.contentRef.treeNodeIds,
        ...asset.contentRef.evidenceIds,
      ];
      if (sourceRefs.some((ref) => ref.toLocaleLowerCase().includes(query))) {
        fields.push("sourceRefs");
      }
      if (fields.length === 0) {
        filtered.push({ assetId: asset.id, reason: "query_mismatch" });
        continue;
      }
      matched.push({ asset, matchedFields: Object.freeze(fields) });
    }
    return deepFreeze({
      query: input.query.trim(),
      assets: matched.slice(0, input.limit ?? 20),
      filtered,
    });
  }

  /**
   * Resolve a Loadout binding against the current head. Revocation is an
   * authority decision on the asset identity and therefore overrides pins to
   * older published versions.
   */
  async resolveBinding(
    scopeInput: MemoryScope,
    assetIdInput: string,
    pinnedVersion?: number,
  ): Promise<MemoryViewAssetDescriptor | undefined> {
    const scope = canonicalPrivateScope(scopeInput);
    const assetId = validateAssetIdentifier(assetIdInput, "assetId");
    if (pinnedVersion !== undefined &&
        (!Number.isSafeInteger(pinnedVersion) || pinnedVersion < 1)) {
      throw new MemoryViewAssetError("INVALID_INPUT", "pinnedVersion is invalid");
    }
    const latest = await this.#repository.getLatest(scope, assetId);
    if (!latest || latest.status === "revoked" || pinnedVersion === undefined) return latest;
    return this.#repository.getVersion(scope, assetId, pinnedVersion);
  }

  async createVersion(input: CreateMemoryViewAssetVersionInput): Promise<MemoryViewPromotionResult> {
    if (input.kind !== undefined && input.kind !== "memory_view") {
      throw new MemoryViewAssetError("INVALID_INPUT", "only memory_view is supported");
    }
    const scope = canonicalPrivateScope(input.scope);
    const assetId = validateAssetIdentifier(input.assetId, "assetId");
    const idempotencyKey = validateAssetIdentifier(input.idempotencyKey, "idempotencyKey");
    if (!Number.isInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0) {
      throw new MemoryViewAssetError("INVALID_INPUT", "expectedLatestVersion is invalid");
    }
    if (input.ownerUserId !== scope.userId) throw new MemoryViewAssetError("OWNER_SCOPE_MISMATCH");
    const title = validateAssetText(input.title, "title", 256);
    const description = input.description === undefined
      ? undefined
      : validateAssetText(input.description, "description", 2_000);
    const declaredTypes = semanticTypes(input.semanticTypes);
    const contentRef = validateMemoryProjectionContentRef(input.contentRef);
    if (!exactSet(declaredTypes, contentRef.semanticTypes)) {
      throw new MemoryViewAssetError("SEMANTIC_TYPE_MISMATCH");
    }
    const provenanceRefs = strings(input.provenanceRefs ?? [], "provenanceRefs");
    const riskFlags = strings(input.riskFlags, "riskFlags");
    const quality = qualitySnapshot(input.qualitySnapshot);
    const fingerprint = authorityScopeFingerprint(scope);
    const hashInput = {
      ...input,
      scope,
      title,
      description,
      semanticTypes: declaredTypes,
      contentRef,
      provenanceRefs,
      riskFlags,
      qualitySnapshot: quality,
    };
    const hash = requestHash(hashInput);
    const existingReceipt = await this.#repository.getReceipt(scope, idempotencyKey);
    if (existingReceipt) {
      if (existingReceipt.requestHash !== hash) throw new MemoryViewAssetError("IDEMPOTENCY_CONFLICT");
      const replay = await this.#repository.getVersion(scope, existingReceipt.assetId, existingReceipt.assetVersion);
      if (!replay) throw new MemoryViewAssetError("ASSET_NOT_FOUND");
      return deepFreeze({ asset: replay, receipt: existingReceipt, replayed: true });
    }

    let sourceSnapshot: MemoryViewSourceSnapshot | undefined;
    if (input.targetStatus === "published") {
      if (!this.#resolver) {
        throw new MemoryViewAssetError("INVALID_INPUT", "source resolver is required for publish");
      }
      const memories = await this.#resolver.resolveMemories({
        scope,
        recordIds: contentRef.recordIds,
      });
      if (contentRef.treeNodeIds.length > 0 && !this.#resolver.resolveTrees) {
        throw new MemoryViewAssetError("FAITHFULNESS_REQUIRED");
      }
      const trees = contentRef.treeNodeIds.length === 0
        ? []
        : await this.#resolver.resolveTrees!({ scope, treeNodeIds: contentRef.treeNodeIds });
      sourceSnapshot = {
        memories,
        trees,
        // A memory-only projection contains no generated tree summary. Tree-backed
        // promotion requires a resolver that returns already faithfulness-gated trees.
        faithfulnessPassed: contentRef.treeNodeIds.length === 0 ||
          trees.length === contentRef.treeNodeIds.length &&
          trees.every((tree) => tree.faithfulnessPassed === true),
      };
    }
    const decisions = input.targetStatus === "published"
      ? validatePublishedSources(scope, declaredTypes, contentRef, sourceSnapshot, riskFlags)
      : Object.freeze(["private_scope", "content_ref_valid"] as const);
    const now = this.#repository.now?.() ?? Date.now();
    const timestamp = new Date(now).toISOString();
    const version = input.expectedLatestVersion + 1;
    const asset: MemoryViewAssetDescriptor = deepFreeze({
      id: assetId,
      kind: "memory_view",
      owner: { subjectType: "user", subjectId: input.ownerUserId },
      title,
      ...(description === undefined ? {} : { description }),
      semanticTypes: declaredTypes,
      sourceScope: scope,
      version,
      status: input.targetStatus,
      visibility: "private",
      contentValidity: undefined,
      contentRef,
      provenanceRefs,
      evidenceRefs: Object.freeze([...contentRef.evidenceIds]),
      riskFlags,
      qualitySnapshot: quality,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const receipt: MemoryViewPromotionReceipt = deepFreeze({
      id: this.#repository.idFactory?.() ?? `asset-receipt-${assetId}-${version}`,
      requestKey: idempotencyKey,
      requestHash: hash,
      assetId,
      assetVersion: version,
      scopeFingerprint: fingerprint,
      targetStatus: input.targetStatus,
      decisions,
      createdAt: timestamp,
    });
    return deepFreeze(await this.#repository.appendVersion({
      asset,
      receipt,
      expectedLatestVersion: input.expectedLatestVersion,
    }));
  }

  async changeStatus(input: ChangeMemoryViewAssetStatusInput): Promise<MemoryViewPromotionResult> {
    const scope = canonicalPrivateScope(input.scope);
    const assetId = validateAssetIdentifier(input.assetId, "assetId");
    const key = validateAssetIdentifier(input.idempotencyKey, "idempotencyKey");
    const hash = requestHash({ ...input, scope });
    const previousReceipt = await this.#repository.getReceipt(scope, key);
    if (previousReceipt) {
      if (previousReceipt.requestHash !== hash) throw new MemoryViewAssetError("IDEMPOTENCY_CONFLICT");
      const asset = await this.#repository.getVersion(scope, assetId, previousReceipt.assetVersion);
      if (!asset) throw new MemoryViewAssetError("ASSET_NOT_FOUND");
      return deepFreeze({ asset, receipt: previousReceipt, replayed: true });
    }
    const previous = await this.#repository.getLatest(scope, assetId);
    if (!previous) throw new MemoryViewAssetError("ASSET_NOT_FOUND");
    if (previous.version !== input.expectedLatestVersion) throw new MemoryViewAssetError("VERSION_CONFLICT");
    if ((input.targetStatus === "deprecated" && previous.status !== "published") ||
        (input.targetStatus === "revoked" && previous.status === "revoked")) {
      throw new MemoryViewAssetError("INVALID_STATUS_TRANSITION");
    }
    const now = this.#repository.now?.() ?? Date.now();
    const timestamp = new Date(now).toISOString();
    const asset = deepFreeze({
      ...previous,
      version: previous.version + 1,
      status: input.targetStatus,
      updatedAt: timestamp,
    } satisfies MemoryViewAssetDescriptor);
    const receipt = deepFreeze({
      id: this.#repository.idFactory?.() ?? `asset-receipt-${assetId}-${asset.version}`,
      requestKey: key,
      requestHash: hash,
      assetId,
      assetVersion: asset.version,
      scopeFingerprint: authorityScopeFingerprint(scope),
      targetStatus: input.targetStatus,
      decisions: Object.freeze([]),
      createdAt: timestamp,
    } satisfies MemoryViewPromotionReceipt);
    return deepFreeze(await this.#repository.appendVersion({
      asset,
      receipt,
      expectedLatestVersion: previous.version,
    }));
  }

  async read(scopeInput: MemoryScope, assetIdInput: string): Promise<MemoryViewAssetReadResult> {
    const scope = canonicalPrivateScope(scopeInput);
    const assetId = validateAssetIdentifier(assetIdInput, "assetId");
    const asset = await this.#repository.getLatest(scope, assetId);
    if (!asset) throw new MemoryViewAssetError("ASSET_NOT_FOUND");
    const staleReasons: string[] = [];
    if (this.#resolver) {
      const memories = await this.#resolver.resolveMemories({
        scope,
        recordIds: asset.contentRef.recordIds,
      });
      const byId = new Map(memories.map((memory) => [memory.id, memory]));
      for (const recordId of asset.contentRef.recordIds) {
        const memory = byId.get(recordId);
        if (!memory || memory.lifecycleStatus !== "active") {
          staleReasons.push(`memory_not_active:${recordId}`);
        } else if (!sameScope(memory.scope, scope)) {
          staleReasons.push(`memory_scope_changed:${recordId}`);
        }
      }
      if (asset.contentRef.treeNodeIds.length > 0) {
        if (!this.#resolver.resolveTrees) {
          staleReasons.push("tree_resolver_unavailable");
        } else {
          const trees = await this.#resolver.resolveTrees({
            scope,
            treeNodeIds: asset.contentRef.treeNodeIds,
          });
          const byId = new Map(trees.map((tree) => [tree.id, tree]));
          for (const treeNodeId of asset.contentRef.treeNodeIds) {
            const tree = byId.get(treeNodeId);
            if (!tree || tree.stale) {
              staleReasons.push(`tree_not_active:${treeNodeId}`);
            } else if (!sameScope(tree.scope, scope)) {
              staleReasons.push(`tree_scope_changed:${treeNodeId}`);
            } else if (!tree.faithfulnessPassed) {
              staleReasons.push(`tree_faithfulness_failed:${treeNodeId}`);
            } else if (tree.evidenceIds.some((id) => !asset.contentRef.evidenceIds.includes(id))) {
              staleReasons.push(`tree_evidence_changed:${treeNodeId}`);
            } else if (tree.semanticTypes.some((type) => !asset.semanticTypes.includes(type))) {
              staleReasons.push(`tree_semantic_type_changed:${treeNodeId}`);
            }
          }
        }
      }
    }
    const result: MemoryViewAssetReadResult = {
      asset,
      contentValidity: staleReasons.length === 0 ? "current" : "stale",
      staleReasons: Object.freeze(staleReasons),
      explanation: {
        assetId: asset.id,
        version: asset.version,
        status: asset.status,
        scopeFingerprint: authorityScopeFingerprint(scope),
        recordIds: asset.contentRef.recordIds,
        treeNodeIds: asset.contentRef.treeNodeIds,
        evidenceIds: asset.contentRef.evidenceIds,
        semanticTypes: asset.semanticTypes,
        qualitySnapshot: asset.qualitySnapshot,
      },
    };
    return deepFreeze(result);
  }
}
