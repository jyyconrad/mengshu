import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type {
  MarkdownPreprocessGroup,
  MarkdownPreprocessNode,
  MarkdownWorksetPreprocessInventory,
} from "./markdown-workset-preprocessor.js";

export const KNOWLEDGE_RESOURCE_PLAN_SCHEMA =
  "mengshu.knowledge-resource-curation-plan/v1" as const;
const KNOWLEDGE_RESOURCE_UNIT_SCHEMA = "mengshu.knowledge-resource-curation-unit/v1" as const;
const KNOWLEDGE_RESOURCE_BATCH_SCHEMA = "mengshu.knowledge-resource-curation-batch/v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const GROUP_KINDS = new Set<MarkdownPreprocessGroup["kind"]>([
  "exact_content", "logical_source", "source_revision", "snapshot_revision",
  "resource_locator",
]);
const COHORTS = [
  "quarantine", "snapshot_document", "strong_locator", "low_signal_resource",
  "namespace_hint_only",
] as const;

export type KnowledgeResourceCohort = typeof COHORTS[number];
export type KnowledgeResourceDispositionCandidate = "quarantine" | "lookup_only";
export type KnowledgeResourceBatchMode = "review" | "deterministic";

export interface KnowledgeResourceFrozenHashes {
  sourceManifestSha256: string;
  sourceSnapshotSha256: string;
  preprocessedManifestSha256: string;
  inventoryFileSha256: string;
  inventorySemanticSha256: string;
}

export interface KnowledgeResourceManifestFileInput {
  relativePath: string;
  sourceRef: string;
  sourceHash: string;
  markdownSha256: string;
  nodeSha256: string;
}

export interface KnowledgeResourcePreprocessedManifestInput {
  schema: string;
  migrationRunId: string;
  policyVersion: string;
  createdAt: string;
  sourceCount: number;
  sourceManifestSha256: string;
  sourceSnapshotSha256: string;
  inventoryFileSha256: string;
  inventorySha256: string;
  files: readonly KnowledgeResourceManifestFileInput[];
  summary: Record<string, unknown>;
}

export interface KnowledgeResourceNodeInput {
  sourceRef: string;
  sourceHash: string;
  sourceTable: "memories" | "knowledge";
  scopeFingerprint?: string;
  normalizedContentHash: string;
  semanticTypeCandidates: readonly {
    semanticType: string;
    confidence: number;
    reason: string;
  }[];
  logicalSourceCandidates: readonly {
    identity: string;
    field: string;
    confidence: number;
  }[];
  revisionCandidates: readonly {
    id: string;
    field: string;
    confidence: number;
    order?: number;
  }[];
  ordinalCandidates: readonly {
    ordinal: number;
    field: string;
    confidence: number;
  }[];
  resourceCandidates: readonly {
    kind: string;
    locator: string;
    field: string;
    confidence: number;
  }[];
  topicCandidates: readonly object[];
  routeCandidates: object;
  qualityFlags: readonly string[];
}

export interface KnowledgeResourceInventoryInput {
  schema: string;
  sourceSnapshotSha256: string;
  policyVersion: string;
  sourceCount: number;
  nodes: readonly KnowledgeResourceNodeInput[];
  groups: readonly { kind: string; key: string; members: readonly string[] }[];
  relationships: readonly { kind: string; from: string; to: string; groupKey: string }[];
  summary: Record<string, unknown>;
  inventorySha256: string;
}

export interface KnowledgeResourceSourceFactInput {
  sourceRef: string;
  bytes: number;
  contentLength: number;
}

export interface PlanKnowledgeResourceCurationInput {
  runId: string;
  policyVersion: string;
  createdAt: string;
  expectedKnowledgeSourceCount: number;
  frozenHashes: KnowledgeResourceFrozenHashes;
  observedHashes: KnowledgeResourceFrozenHashes;
  preprocessedManifest: KnowledgeResourcePreprocessedManifestInput;
  inventory: KnowledgeResourceInventoryInput;
  sourceFacts: readonly KnowledgeResourceSourceFactInput[];
}

export interface KnowledgeResourceSourceBinding {
  readonly sourceRef: string;
  readonly sourceHash: string;
}

export interface KnowledgeResourceCurationUnit {
  readonly schema: typeof KNOWLEDGE_RESOURCE_UNIT_SCHEMA;
  readonly unitId: string;
  readonly cohort: KnowledgeResourceCohort;
  readonly scopeFingerprint: string;
  readonly sources: readonly KnowledgeResourceSourceBinding[];
  readonly bytes: number;
  readonly dispositionCandidate: KnowledgeResourceDispositionCandidate;
  readonly reviewRequired: boolean;
  readonly logicalSourceIdentities: readonly string[];
  readonly resourceLocators: readonly string[];
  readonly ordinalCount: number;
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: true;
}

export interface KnowledgeResourceCurationBatch {
  readonly schema: typeof KNOWLEDGE_RESOURCE_BATCH_SCHEMA;
  readonly sequence: number;
  readonly batchId: string;
  readonly cohort: KnowledgeResourceCohort;
  readonly mode: KnowledgeResourceBatchMode;
  readonly scopeFingerprint: string;
  readonly unitIds: readonly string[];
  readonly sourceCount: number;
  readonly bytes: number;
  readonly candidateOnly: true;
}

export interface KnowledgeResourceCohortSummary {
  readonly units: number;
  readonly sources: number;
  readonly batches: number;
}

export interface KnowledgeResourceCurationPlan {
  readonly schema: typeof KNOWLEDGE_RESOURCE_PLAN_SCHEMA;
  readonly runId: string;
  readonly policyVersion: string;
  readonly sourceManifestSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly preprocessedManifestSha256: string;
  readonly inventoryFileSha256: string;
  readonly inventorySemanticSha256: string;
  readonly createdAt: string;
  readonly units: readonly KnowledgeResourceCurationUnit[];
  readonly batches: readonly KnowledgeResourceCurationBatch[];
  readonly summary: Readonly<{
    sourceCount: number;
    unitCount: number;
    batchCount: number;
    quarantineSourceCount: number;
    eligibleSourceCount: number;
    eligibleStrongRevisionCount: number;
    sourceCoverage: 1;
    byCohort: Readonly<Record<KnowledgeResourceCohort, KnowledgeResourceCohortSummary>>;
  }>;
  readonly guards: Readonly<{
    candidateOnly: true;
    canonicalTargetsSelected: false;
    formalAssetsWritten: false;
    treeArtifactsWritten: false;
    postgresTouched: false;
    supersedeAllowed: false;
    crossScopeGroupingAllowed: false;
  }>;
  readonly semanticPlanSha256: string;
}

function fail(message: string): never {
  throw new Error(`KNOWLEDGE_RESOURCE_CURATION_INVALID: ${message}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("proxy or cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("invalid object or cycle");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("invalid value");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0")
    .update(JSON.stringify(stableValue(value))).digest("hex");
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} hash`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value !== value.normalize("NFC") ||
      !SAFE_TEXT.test(value)) fail(`${label} text`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} timestamp`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} integer`);
  }
  return value;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(`${label} exact keys`);
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    const parent = this.parent.get(value);
    if (!parent) fail("component references unknown source");
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort((a, b) => a.localeCompare(b));
    this.parent.set(second!, first!);
  }
}

function isNamespaceOnly(node: KnowledgeResourceNodeInput): boolean {
  return node.semanticTypeCandidates.some((candidate) =>
    candidate.semanticType === "resource" && candidate.reason === "legacy.dataType:document") &&
    !strongLocator(node);
}

function strongLocator(node: KnowledgeResourceNodeInput): boolean {
  return node.resourceCandidates.some((candidate) => candidate.confidence >= 0.9);
}

function componentCohort(
  nodes: readonly KnowledgeResourceNodeInput[],
  facts: ReadonlyMap<string, KnowledgeResourceSourceFactInput>,
  groupKinds: ReadonlySet<string>,
): KnowledgeResourceCohort {
  if (nodes.some((node) => node.qualityFlags.includes("legacy_quarantine") ||
      facts.get(node.sourceRef)?.contentLength === 0)) return "quarantine";
  if (groupKinds.has("snapshot_revision") || nodes.some((node) =>
    node.ordinalCandidates.length > 0 && node.logicalSourceCandidates.some((item) =>
      item.confidence >= 0.9))) return "snapshot_document";
  if (groupKinds.has("resource_locator") || nodes.some(strongLocator)) return "strong_locator";
  if (nodes.every(isNamespaceOnly)) return "namespace_hint_only";
  return "low_signal_resource";
}

function batchMode(cohort: KnowledgeResourceCohort): KnowledgeResourceBatchMode {
  return cohort === "snapshot_document" || cohort === "strong_locator"
    ? "review" : "deterministic";
}

function unitReasonCodes(cohort: KnowledgeResourceCohort): readonly string[] {
  const values: Record<KnowledgeResourceCohort, readonly string[]> = {
    quarantine: ["knowledge_quarantine_evidence"],
    snapshot_document: ["snapshot_component_review_required", "revision_target_unfrozen"],
    strong_locator: ["strong_resource_locator_review_required", "canonical_target_unfrozen"],
    low_signal_resource: ["knowledge_resource_without_strong_locator", "lookup_only_candidate"],
    namespace_hint_only: ["legacy_document_namespace_hint_only", "lookup_only_candidate"],
  };
  return values[cohort];
}

function planSemanticBody(plan: Omit<KnowledgeResourceCurationPlan, "semanticPlanSha256">): unknown {
  const { createdAt: ignored, ...semantic } = plan;
  return semantic;
}

function validateHashes(value: unknown, label: string): KnowledgeResourceFrozenHashes {
  const item = exactKeys(value, [
    "sourceManifestSha256", "sourceSnapshotSha256", "preprocessedManifestSha256",
    "inventoryFileSha256", "inventorySemanticSha256",
  ], label);
  return {
    sourceManifestSha256: hash(item.sourceManifestSha256, label),
    sourceSnapshotSha256: hash(item.sourceSnapshotSha256, label),
    preprocessedManifestSha256: hash(item.preprocessedManifestSha256, label),
    inventoryFileSha256: hash(item.inventoryFileSha256, label),
    inventorySemanticSha256: hash(item.inventorySemanticSha256, label),
  };
}

function prepareInput(input: PlanKnowledgeResourceCurationInput): {
  runId: string;
  policyVersion: string;
  createdAt: string;
  expected: number;
  hashes: KnowledgeResourceFrozenHashes;
  manifest: KnowledgeResourcePreprocessedManifestInput;
  inventory: KnowledgeResourceInventoryInput;
  facts: readonly KnowledgeResourceSourceFactInput[];
} {
  stableValue(input);
  const root = exactKeys(input, [
    "runId", "policyVersion", "createdAt", "expectedKnowledgeSourceCount", "frozenHashes",
    "observedHashes", "preprocessedManifest", "inventory", "sourceFacts",
  ], "planner input");
  const hashes = validateHashes(root.frozenHashes, "frozen hashes");
  const observed = validateHashes(root.observedHashes, "observed hashes");
  if (JSON.stringify(hashes) !== JSON.stringify(observed)) fail("frozen/observed hash drift");
  const expected = nonNegativeInteger(root.expectedKnowledgeSourceCount, "expected source count");
  if (!plainRecord(root.preprocessedManifest) || !plainRecord(root.inventory) ||
      !Array.isArray(root.sourceFacts)) fail("input contract");
  const manifest = root.preprocessedManifest as unknown as KnowledgeResourcePreprocessedManifestInput;
  const inventory = root.inventory as unknown as KnowledgeResourceInventoryInput;
  if (manifest.schema !== "mengshu.markdown-workset-preprocess-manifest/v1" ||
      inventory.schema !== "mengshu.markdown-workset-preprocess/v1" ||
      !Array.isArray(manifest.files) || !Array.isArray(inventory.nodes) ||
      !Array.isArray(inventory.groups) || !Array.isArray(inventory.relationships)) {
    fail("input contract");
  }
  const manifestRefs = manifest.files.map((file) => file.sourceRef);
  if (new Set(manifestRefs).size !== manifestRefs.length) fail("manifest duplicate source");
  if (
      manifest.sourceCount !== manifest.files.length || inventory.sourceCount !== inventory.nodes.length ||
      manifest.sourceManifestSha256 !== hashes.sourceManifestSha256 ||
      manifest.sourceSnapshotSha256 !== hashes.sourceSnapshotSha256 ||
      manifest.inventoryFileSha256 !== hashes.inventoryFileSha256 ||
      manifest.inventorySha256 !== hashes.inventorySemanticSha256 ||
      inventory.sourceSnapshotSha256 !== hashes.sourceSnapshotSha256 ||
      inventory.inventorySha256 !== hashes.inventorySemanticSha256) fail("input hash binding drift");
  return {
    runId: text(root.runId, "runId"),
    policyVersion: text(root.policyVersion, "policyVersion"),
    createdAt: iso(root.createdAt, "createdAt"),
    expected,
    hashes,
    manifest,
    inventory,
    facts: root.sourceFacts as unknown as readonly KnowledgeResourceSourceFactInput[],
  };
}

export function planKnowledgeResourceCuration(
  input: PlanKnowledgeResourceCurationInput,
): KnowledgeResourceCurationPlan {
  const prepared = prepareInput(input);
  const knowledgeNodes = prepared.inventory.nodes.filter((node) => node.sourceTable === "knowledge");
  const knowledgeFiles = prepared.manifest.files.filter((file) => file.sourceRef.startsWith("knowledge:"));
  if (knowledgeNodes.length !== prepared.expected || knowledgeFiles.length !== prepared.expected ||
      prepared.facts.length !== prepared.expected) fail("knowledge source coverage");

  const nodeByRef = new Map<string, KnowledgeResourceNodeInput>();
  for (const node of knowledgeNodes) {
    if (!plainRecord(node) || typeof node.sourceRef !== "string" ||
        !node.sourceRef.startsWith("knowledge:") || node.sourceTable !== "knowledge" ||
        !SHA256.test(node.sourceHash) || !SHA256.test(node.scopeFingerprint ?? "") ||
        !Array.isArray(node.semanticTypeCandidates) || !Array.isArray(node.logicalSourceCandidates) ||
        !Array.isArray(node.revisionCandidates) || !Array.isArray(node.ordinalCandidates) ||
        !Array.isArray(node.resourceCandidates) || !Array.isArray(node.qualityFlags) ||
        nodeByRef.has(node.sourceRef)) fail("knowledge node coverage or duplicate");
    nodeByRef.set(node.sourceRef, node);
  }

  const fileByRef = new Map<string, KnowledgeResourceManifestFileInput>();
  for (const file of knowledgeFiles) {
    if (!plainRecord(file) || typeof file.sourceRef !== "string" ||
        fileByRef.has(file.sourceRef) || !SHA256.test(file.sourceHash) ||
        !SHA256.test(file.markdownSha256) || !SHA256.test(file.nodeSha256)) {
      fail("knowledge manifest duplicate or invalid");
    }
    fileByRef.set(file.sourceRef, file);
  }
  const factByRef = new Map<string, KnowledgeResourceSourceFactInput>();
  for (const fact of prepared.facts) {
    if (!plainRecord(fact) || typeof fact.sourceRef !== "string" || factByRef.has(fact.sourceRef)) {
      fail("knowledge fact duplicate or invalid");
    }
    const normalized = {
      sourceRef: fact.sourceRef,
      bytes: nonNegativeInteger(fact.bytes, "source bytes"),
      contentLength: nonNegativeInteger(fact.contentLength, "source content length"),
    };
    factByRef.set(fact.sourceRef, normalized);
  }
  for (const [sourceRef, node] of nodeByRef) {
    const file = fileByRef.get(sourceRef);
    if (!file || file.sourceHash !== node.sourceHash || !factByRef.has(sourceRef)) {
      fail("knowledge three-way source coverage or hash drift");
    }
  }
  if ([...fileByRef.keys()].some((sourceRef) => !nodeByRef.has(sourceRef)) ||
      [...factByRef.keys()].some((sourceRef) => !nodeByRef.has(sourceRef))) {
    fail("knowledge three-way source coverage");
  }

  const sets = new DisjointSet();
  for (const sourceRef of nodeByRef.keys()) sets.add(sourceRef);
  const quarantineCandidates = new Set([...nodeByRef.values()].filter((node) =>
    node.qualityFlags.includes("legacy_quarantine") ||
    factByRef.get(node.sourceRef)?.contentLength === 0).map((node) => node.sourceRef));
  const relevantGroups: Array<{ kind: string; members: string[] }> = [];
  for (const raw of prepared.inventory.groups) {
    if (!plainRecord(raw) || typeof raw.kind !== "string" || !GROUP_KINDS.has(
      raw.kind as MarkdownPreprocessGroup["kind"],
    ) || !Array.isArray(raw.members) || raw.members.length < 2 ||
        raw.members.some((member) => typeof member !== "string")) fail("group enum or shape");
    const members = raw.members as string[];
    const knowledgeMembers = members.filter((member) => nodeByRef.has(member));
    if (knowledgeMembers.length === 0) continue;
    if (knowledgeMembers.length !== members.length) fail("group crosses source table");
    const scopes = new Set(knowledgeMembers.map((member) => nodeByRef.get(member)!.scopeFingerprint));
    if (scopes.size !== 1) fail("group crosses scope");
    const eligibleMembers = knowledgeMembers.filter((member) =>
      !quarantineCandidates.has(member));
    if (eligibleMembers.length >= 2) {
      for (const member of eligibleMembers.slice(1)) sets.union(eligibleMembers[0]!, member);
      relevantGroups.push({ kind: raw.kind, members: [...eligibleMembers] });
    }
    if (raw.kind === "exact_content") {
      const quarantineMembers = knowledgeMembers.filter((member) =>
        quarantineCandidates.has(member));
      if (quarantineMembers.length >= 2) {
        for (const member of quarantineMembers.slice(1)) {
          sets.union(quarantineMembers[0]!, member);
        }
        relevantGroups.push({ kind: raw.kind, members: [...quarantineMembers] });
      }
    }
  }

  const componentMembers = new Map<string, string[]>();
  for (const sourceRef of [...nodeByRef.keys()].sort((a, b) => a.localeCompare(b))) {
    const root = sets.find(sourceRef);
    const members = componentMembers.get(root) ?? [];
    members.push(sourceRef);
    componentMembers.set(root, members);
  }
  const groupKindsByRoot = new Map<string, Set<string>>();
  for (const group of relevantGroups) {
    const root = sets.find(group.members[0]!);
    const kinds = groupKindsByRoot.get(root) ?? new Set<string>();
    kinds.add(group.kind);
    groupKindsByRoot.set(root, kinds);
  }

  const units: KnowledgeResourceCurationUnit[] = [];
  for (const [root, refs] of componentMembers) {
    const nodes = refs.map((sourceRef) => nodeByRef.get(sourceRef)!);
    const scopes = new Set(nodes.map((node) => node.scopeFingerprint));
    if (scopes.size !== 1) fail("component crosses scope");
    const cohort = componentCohort(nodes, factByRef, groupKindsByRoot.get(root) ?? new Set());
    if ((cohort === "low_signal_resource" || cohort === "namespace_hint_only") && refs.length !== 1) {
      fail("low-signal component must remain singleton");
    }
    const sources = nodes.map((node) => ({ sourceRef: node.sourceRef, sourceHash: node.sourceHash }))
      .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
    const bytes = refs.reduce((sum, sourceRef) => sum + factByRef.get(sourceRef)!.bytes, 0);
    const logicalSourceIdentities = [...new Set(nodes.flatMap((node) =>
      node.logicalSourceCandidates.filter((item) => item.confidence >= 0.9)
        .map((item) => item.identity)))].sort((a, b) => a.localeCompare(b));
    const resourceLocators = [...new Set(nodes.flatMap((node) =>
      node.resourceCandidates.filter((item) => item.confidence >= 0.9)
        .map((item) => `${item.kind}:${item.locator}`)))].sort((a, b) => a.localeCompare(b));
    const unitId = canonicalHash("mengshu.knowledge-resource-unit/v1", {
      cohort, scopeFingerprint: nodes[0]!.scopeFingerprint, sources,
    });
    units.push(deepFreeze({
      schema: KNOWLEDGE_RESOURCE_UNIT_SCHEMA,
      unitId,
      cohort,
      scopeFingerprint: nodes[0]!.scopeFingerprint!,
      sources,
      bytes,
      dispositionCandidate: cohort === "quarantine" ? "quarantine" : "lookup_only",
      reviewRequired: batchMode(cohort) === "review",
      logicalSourceIdentities,
      resourceLocators,
      ordinalCount: nodes.filter((node) => node.ordinalCandidates.length > 0).length,
      reasonCodes: [...unitReasonCodes(cohort)],
      candidateOnly: true as const,
    }) as KnowledgeResourceCurationUnit);
  }
  units.sort((left, right) => left.scopeFingerprint.localeCompare(right.scopeFingerprint) ||
    COHORTS.indexOf(left.cohort) - COHORTS.indexOf(right.cohort) ||
    left.unitId.localeCompare(right.unitId));
  if (units.flatMap((unit) => unit.sources).length !== prepared.expected ||
      new Set(units.flatMap((unit) => unit.sources.map((source) => source.sourceRef))).size !==
        prepared.expected) fail("final source coverage");

  const batchesWithoutIds: Array<Omit<KnowledgeResourceCurationBatch, "sequence" | "batchId">> = [];
  const partitions = new Map<string, KnowledgeResourceCurationUnit[]>();
  for (const unit of units) {
    const key = `${unit.scopeFingerprint}\0${unit.cohort}`;
    const values = partitions.get(key) ?? [];
    values.push(unit);
    partitions.set(key, values);
  }
  for (const key of [...partitions.keys()].sort((a, b) => a.localeCompare(b))) {
    const partition = partitions.get(key)!;
    const cohort = partition[0]!.cohort;
    const mode = batchMode(cohort);
    const maxUnits = mode === "review" ? 20 : Number.MAX_SAFE_INTEGER;
    const maxSources = mode === "deterministic" ? 500 : Number.MAX_SAFE_INTEGER;
    const maxBytes = mode === "review" ? 400_000 : 4_000_000;
    let current: KnowledgeResourceCurationUnit[] = [];
    let currentSources = 0;
    let currentBytes = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      batchesWithoutIds.push({
        schema: KNOWLEDGE_RESOURCE_BATCH_SCHEMA,
        cohort,
        mode,
        scopeFingerprint: current[0]!.scopeFingerprint,
        unitIds: current.map((unit) => unit.unitId),
        sourceCount: currentSources,
        bytes: currentBytes,
        candidateOnly: true,
      });
      current = [];
      currentSources = 0;
      currentBytes = 0;
    };
    for (const unit of partition) {
      if (unit.bytes > maxBytes || unit.sources.length > maxSources) fail("oversize component");
      if (current.length >= maxUnits || currentSources + unit.sources.length > maxSources ||
          currentBytes + unit.bytes > maxBytes) flush();
      current.push(unit);
      currentSources += unit.sources.length;
      currentBytes += unit.bytes;
    }
    flush();
  }

  const unitById = new Map(units.map((unit) => [unit.unitId, unit] as const));
  const batches: KnowledgeResourceCurationBatch[] = batchesWithoutIds.map((batch, index) => {
    const sourceBindings = batch.unitIds.flatMap((unitId) => unitById.get(unitId)!.sources);
    return deepFreeze({
      ...batch,
      sequence: index + 1,
      batchId: canonicalHash("mengshu.knowledge-resource-batch/v1", {
        policyVersion: prepared.policyVersion,
        hashes: prepared.hashes,
        scopeFingerprint: batch.scopeFingerprint,
        cohort: batch.cohort,
        mode: batch.mode,
        sources: [...sourceBindings].sort((left, right) =>
          left.sourceRef.localeCompare(right.sourceRef)),
      }),
    }) as KnowledgeResourceCurationBatch;
  });

  const byCohort = Object.fromEntries(COHORTS.map((cohort) => {
    const cohortUnits = units.filter((unit) => unit.cohort === cohort);
    return [cohort, {
      units: cohortUnits.length,
      sources: cohortUnits.reduce((sum, unit) => sum + unit.sources.length, 0),
      batches: batches.filter((batch) => batch.cohort === cohort).length,
    }];
  })) as Record<KnowledgeResourceCohort, KnowledgeResourceCohortSummary>;
  const quarantineSourceCount = byCohort.quarantine.sources;
  const quarantineSources = new Set(units.filter((unit) => unit.cohort === "quarantine")
    .flatMap((unit) => unit.sources.map((source) => source.sourceRef)));
  const eligibleStrongRevisionCount = knowledgeNodes.filter((node) =>
    !quarantineSources.has(node.sourceRef) &&
    node.revisionCandidates.some((candidate) => candidate.confidence >= 0.9)).length;
  if (eligibleStrongRevisionCount > 0) fail("eligible strong revision requires a separate policy");
  const guards = {
    candidateOnly: true as const,
    canonicalTargetsSelected: false as const,
    formalAssetsWritten: false as const,
    treeArtifactsWritten: false as const,
    postgresTouched: false as const,
    supersedeAllowed: false as const,
    crossScopeGroupingAllowed: false as const,
  };
  const body: Omit<KnowledgeResourceCurationPlan, "semanticPlanSha256"> = deepFreeze({
    schema: KNOWLEDGE_RESOURCE_PLAN_SCHEMA,
    runId: prepared.runId,
    policyVersion: prepared.policyVersion,
    sourceManifestSha256: prepared.hashes.sourceManifestSha256,
    sourceSnapshotSha256: prepared.hashes.sourceSnapshotSha256,
    preprocessedManifestSha256: prepared.hashes.preprocessedManifestSha256,
    inventoryFileSha256: prepared.hashes.inventoryFileSha256,
    inventorySemanticSha256: prepared.hashes.inventorySemanticSha256,
    createdAt: prepared.createdAt,
    units,
    batches,
    summary: {
      sourceCount: prepared.expected,
      unitCount: units.length,
      batchCount: batches.length,
      quarantineSourceCount,
      eligibleSourceCount: prepared.expected - quarantineSourceCount,
      eligibleStrongRevisionCount,
      sourceCoverage: 1 as const,
      byCohort,
    },
    guards,
  }) as Omit<KnowledgeResourceCurationPlan, "semanticPlanSha256">;
  return deepFreeze({
    ...body,
    semanticPlanSha256: canonicalHash(
      "mengshu.knowledge-resource-curation-plan/semantic/v1",
      planSemanticBody(body),
    ),
  }) as KnowledgeResourceCurationPlan;
}

function validateParsedPlan(value: unknown): KnowledgeResourceCurationPlan {
  const root = exactKeys(value, [
    "schema", "runId", "policyVersion", "sourceManifestSha256", "sourceSnapshotSha256",
    "preprocessedManifestSha256", "inventoryFileSha256", "inventorySemanticSha256", "createdAt",
    "units", "batches", "summary", "guards", "semanticPlanSha256",
  ], "knowledge plan");
  if (root.schema !== KNOWLEDGE_RESOURCE_PLAN_SCHEMA || !Array.isArray(root.units) ||
      !Array.isArray(root.batches)) fail("knowledge plan contract");
  const plan = root as unknown as KnowledgeResourceCurationPlan;
  hash(plan.sourceManifestSha256, "source manifest");
  hash(plan.sourceSnapshotSha256, "source snapshot");
  hash(plan.preprocessedManifestSha256, "preprocessed manifest");
  hash(plan.inventoryFileSha256, "inventory file");
  hash(plan.inventorySemanticSha256, "inventory semantic");
  hash(plan.semanticPlanSha256, "semantic plan");
  iso(plan.createdAt, "plan");
  for (const unit of plan.units) {
    exactKeys(unit, [
      "schema", "unitId", "cohort", "scopeFingerprint", "sources", "bytes",
      "dispositionCandidate", "reviewRequired", "logicalSourceIdentities", "resourceLocators",
      "ordinalCount", "reasonCodes", "candidateOnly",
    ], "plan unit");
    if (unit.schema !== KNOWLEDGE_RESOURCE_UNIT_SCHEMA || !COHORTS.includes(unit.cohort) ||
        unit.candidateOnly !== true || !Array.isArray(unit.sources)) fail("plan unit contract");
  }
  for (const batch of plan.batches) {
    exactKeys(batch, [
      "schema", "sequence", "batchId", "cohort", "mode", "scopeFingerprint", "unitIds",
      "sourceCount", "bytes", "candidateOnly",
    ], "plan batch");
    if (batch.schema !== KNOWLEDGE_RESOURCE_BATCH_SCHEMA || !COHORTS.includes(batch.cohort) ||
        !["review", "deterministic"].includes(batch.mode) || batch.candidateOnly !== true ||
        !Array.isArray(batch.unitIds)) fail("plan batch contract");
  }
  const { semanticPlanSha256, ...body } = plan;
  const actual = canonicalHash(
    "mengshu.knowledge-resource-curation-plan/semantic/v1",
    planSemanticBody(body),
  );
  if (actual !== semanticPlanSha256) fail("semantic plan hash drift");
  return deepFreeze(stableValue(plan)) as KnowledgeResourceCurationPlan;
}

export function serializeKnowledgeResourcePlan(plan: KnowledgeResourceCurationPlan): string {
  return canonicalJson(validateParsedPlan(plan));
}

export function parseKnowledgeResourcePlan(serialized: string): KnowledgeResourceCurationPlan {
  if (typeof serialized !== "string") fail("serialized plan invalid");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("serialized plan invalid");
  }
  return validateParsedPlan(value);
}

export type { MarkdownWorksetPreprocessInventory, MarkdownPreprocessNode };
