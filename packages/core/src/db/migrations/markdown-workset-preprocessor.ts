import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { MemorySemanticType } from "../../domain/types.js";
import { inferDeterministicCandidateSignals } from "../../runtime/llm/extraction-rules.js";
import {
  parseNativeRecordMarkdown,
  renderNativeRecordMarkdown,
  type MarkdownWorksetRecord,
} from "./markdown-workset.js";

export const MARKDOWN_WORKSET_PREPROCESS_SCHEMA =
  "mengshu.markdown-workset-preprocess/v1" as const;

export type MarkdownPreprocessRouteAssessment =
  | "threshold_met"
  | "threshold_not_met"
  | "insufficient_metadata"
  | "not_applicable";

export interface MarkdownPreprocessSemanticTypeCandidate {
  readonly semanticType: MemorySemanticType;
  readonly confidence: number;
  readonly reason: string;
}

export interface MarkdownPreprocessLogicalSourceCandidate {
  readonly identity: string;
  readonly field: string;
  readonly confidence: number;
}

export interface MarkdownPreprocessRevisionCandidate {
  readonly id: string;
  readonly field: string;
  readonly confidence: number;
  readonly order?: number;
}

export interface MarkdownPreprocessOrdinalCandidate {
  readonly ordinal: number;
  readonly field: string;
  readonly confidence: number;
}

export type MarkdownPreprocessResourceKind =
  | "url"
  | "path"
  | "document_id"
  | "repository"
  | "tool"
  | "command";

export interface MarkdownPreprocessResourceCandidate {
  readonly kind: MarkdownPreprocessResourceKind;
  readonly locator: string;
  readonly field: string;
  readonly confidence: number;
}

export interface MarkdownPreprocessTopicCandidate {
  readonly label: string;
  readonly key: string;
  readonly field: string;
  readonly confidence: number;
}

export interface MarkdownPreprocessNode {
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly sourceTable: "memories" | "knowledge";
  readonly scopeFingerprint?: string;
  readonly normalizedContentHash: string;
  readonly semanticTypeCandidates: readonly MarkdownPreprocessSemanticTypeCandidate[];
  readonly logicalSourceCandidates: readonly MarkdownPreprocessLogicalSourceCandidate[];
  readonly revisionCandidates: readonly MarkdownPreprocessRevisionCandidate[];
  readonly ordinalCandidates: readonly MarkdownPreprocessOrdinalCandidate[];
  readonly resourceCandidates: readonly MarkdownPreprocessResourceCandidate[];
  readonly topicCandidates: readonly MarkdownPreprocessTopicCandidate[];
  readonly routeCandidates: Readonly<{
    valueScore?: number;
    importance?: number;
    source: MarkdownPreprocessRouteAssessment;
    topic: MarkdownPreprocessRouteAssessment;
    global: MarkdownPreprocessRouteAssessment;
  }>;
  readonly qualityFlags: readonly string[];
}

export type MarkdownPreprocessGroupKind =
  | "exact_content"
  | "logical_source"
  | "source_revision"
  | "snapshot_revision"
  | "resource_locator";

export interface MarkdownPreprocessGroup {
  readonly kind: MarkdownPreprocessGroupKind;
  readonly key: string;
  readonly members: readonly string[];
}

export type MarkdownPreprocessRelationshipKind =
  | "exact_duplicate_candidate"
  | "same_logical_source_candidate"
  | "same_revision_candidate"
  | "same_snapshot_revision_candidate"
  | "revision_successor_candidate"
  | "resource_alias_candidate";

export interface MarkdownPreprocessRelationship {
  readonly kind: MarkdownPreprocessRelationshipKind;
  readonly from: string;
  readonly to: string;
  readonly groupKey: string;
}

export interface MarkdownWorksetPreprocessInventory {
  readonly schema: typeof MARKDOWN_WORKSET_PREPROCESS_SCHEMA;
  readonly sourceSnapshotSha256: string;
  readonly policyVersion: string;
  readonly sourceCount: number;
  readonly nodes: readonly MarkdownPreprocessNode[];
  readonly groups: readonly MarkdownPreprocessGroup[];
  readonly relationships: readonly MarkdownPreprocessRelationship[];
  readonly summary: Readonly<{
    missingScope: number;
    missingLogicalSource: number;
    weakLogicalSource: number;
    missingRevision: number;
    weakRevision: number;
    missingSemanticType: number;
    weakSemanticType: number;
    bySourceTable: Readonly<Record<"memories" | "knowledge", number>>;
    primarySemanticType: Readonly<Record<MemorySemanticType | "unknown", number>>;
    thresholdMet: Readonly<Record<"source" | "topic" | "global", number>>;
    exactDuplicateGroups: number;
    logicalSourceGroups: number;
    sourceRevisionGroups: number;
    snapshotRevisionGroups: number;
    resourceLocatorGroups: number;
  }>;
  readonly inventorySha256: string;
}

export interface PreprocessMarkdownWorksetInput {
  readonly sourceSnapshotSha256: string;
  readonly policyVersion: string;
  readonly records: readonly MarkdownWorksetRecord[];
}

export interface AssembleMarkdownWorksetPreprocessInventoryInput {
  readonly sourceSnapshotSha256: string;
  readonly policyVersion: string;
  readonly nodes: readonly MarkdownPreprocessNode[];
}

export type MarkdownWorksetPreprocessorErrorCode =
  | "MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT"
  | "MARKDOWN_WORKSET_PREPROCESS_DUPLICATE_SOURCE"
  | "MARKDOWN_WORKSET_PREPROCESS_REQUIRES_SOURCE_PHASE";

const MESSAGES: Record<MarkdownWorksetPreprocessorErrorCode, string> = {
  MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT: "Markdown workset preprocess input is invalid",
  MARKDOWN_WORKSET_PREPROCESS_DUPLICATE_SOURCE: "Markdown workset preprocess source is duplicated",
  MARKDOWN_WORKSET_PREPROCESS_REQUIRES_SOURCE_PHASE:
    "Markdown workset preprocess requires source phase records",
};

export class MarkdownWorksetPreprocessorError extends Error {
  constructor(readonly code: MarkdownWorksetPreprocessorErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownWorksetPreprocessorError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);

function fail(code: MarkdownWorksetPreprocessorErrorCode): never {
  throw new MarkdownWorksetPreprocessorError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().normalize("NFC");
  return SAFE_TEXT.test(normalized) ? normalized : undefined;
}

function score(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function normalizedContentHash(text: string): string {
  return sha256(text.replace(/\r\n?/g, "\n").normalize("NFC"));
}

function normalizedIdentity(value: string): string {
  const normalized = value.normalize("NFC");
  if (/^(?:https?|file):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      url.protocol = url.protocol.toLocaleLowerCase("en-US");
      url.hostname = url.hostname.toLocaleLowerCase("en-US");
      if (url.protocol === "http:" && url.port === "80" ||
          url.protocol === "https:" && url.port === "443") url.port = "";
      return url.toString();
    } catch {
      return normalized;
    }
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(normalized)) {
    return normalized.toLocaleLowerCase("en-US");
  }
  return normalized.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function strongSourceIdentity(value: string): boolean {
  return /^(?:https?:\/\/|file:\/\/)/i.test(value) ||
    value.includes("/") || value.includes("\\") || /\.[a-z0-9]{1,12}(?:[#?].*)?$/i.test(value);
}

function semanticCandidateFromLegacyType(
  dataType: string,
): MarkdownPreprocessSemanticTypeCandidate | undefined {
  const type = dataType.trim().toLocaleLowerCase("en-US");
  const mappings: Readonly<Record<string, MemorySemanticType>> = {
    preference: "profile",
    profile: "profile",
    goal: "task_context",
    task: "task_context",
    plan: "task_context",
    status: "task_context",
    decision: "rules",
    rule: "rules",
    rules: "rules",
    experience: "experience",
    document: "resource",
    knowledge: "resource",
    resource: "resource",
  };
  const semanticType = mappings[type];
  return semanticType
    ? Object.freeze({ semanticType, confidence: 0.72, reason: `legacy.dataType:${type}` })
    : undefined;
}

function semanticCandidates(record: MarkdownWorksetRecord):
readonly MarkdownPreprocessSemanticTypeCandidate[] {
  const candidates: MarkdownPreprocessSemanticTypeCandidate[] = [];
  const explicit = safeString(record.record.metadata.semanticType);
  if (explicit && SEMANTIC_TYPES.has(explicit as MemorySemanticType)) {
    candidates.push({
      semanticType: explicit as MemorySemanticType,
      confidence: 1,
      reason: "metadata.semanticType",
    });
  }
  const legacy = semanticCandidateFromLegacyType(record.record.dataType);
  if (legacy) candidates.push(legacy);
  for (const signal of inferDeterministicCandidateSignals(record.record.text)) {
    candidates.push({
      semanticType: signal.semanticType,
      confidence: signal.confidence,
      reason: signal.reason,
    });
  }
  if (record.record.sourceTable === "knowledge") {
    candidates.push({
      semanticType: "resource",
      confidence: 0.4,
      reason: "knowledge_namespace_hint",
    });
  }
  const best = new Map<MemorySemanticType, MarkdownPreprocessSemanticTypeCandidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.semanticType);
    if (!current || candidate.confidence > current.confidence ||
        candidate.confidence === current.confidence && candidate.reason < current.reason) {
      best.set(candidate.semanticType, Object.freeze(candidate));
    }
  }
  return Object.freeze([...best.values()].sort((left, right) =>
    right.confidence - left.confidence || left.semanticType.localeCompare(right.semanticType)));
}

function logicalSourceCandidates(
  metadata: Readonly<Record<string, unknown>>,
): readonly MarkdownPreprocessLogicalSourceCandidate[] {
  const fields: ReadonlyArray<readonly [string, number]> = [
    ["sourceIdentity", 1], ["logicalSource", 1], ["documentId", 0.95],
    ["logicalId", 0.98], ["sourceId", 0.9], ["document_id", 0.95],
    ["filePath", 0.95], ["path", 0.9],
    ["uri", 0.9], ["url", 0.9], ["repo", 0.85], ["repository", 0.85],
    ["source", 0.6],
  ];
  const candidates: MarkdownPreprocessLogicalSourceCandidate[] = [];
  const seen = new Set<string>();
  for (const [field, baseConfidence] of fields) {
    const identity = safeString(metadata[field]);
    if (!identity) continue;
    const confidence = field === "source" && strongSourceIdentity(identity) ? 0.85 : baseConfidence;
    const key = normalizedIdentity(identity);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(Object.freeze({ identity, field, confidence }));
  }
  return Object.freeze(candidates.sort((left, right) =>
    right.confidence - left.confidence || left.field.localeCompare(right.field) ||
      left.identity.localeCompare(right.identity)));
}

function revisionCandidates(
  metadata: Readonly<Record<string, unknown>>,
): readonly MarkdownPreprocessRevisionCandidate[] {
  const candidates: MarkdownPreprocessRevisionCandidate[] = [];
  const revision = metadata.revision;
  if (plainRecord(revision)) {
    const id = safeString(revision.id);
    const order = revision.order;
    if (id) {
      candidates.push(Object.freeze({
        id,
        field: "revision.id",
        confidence: 1,
        ...(Number.isSafeInteger(order) && (order as number) >= 0 ? { order: order as number } : {}),
      }));
    }
  } else {
    const id = safeString(revision);
    if (id) candidates.push(Object.freeze({ id, field: "revision", confidence: 0.9 }));
  }
  const fields: ReadonlyArray<readonly [string, number]> = [
    ["revisionId", 0.95], ["sourceRevision", 0.95], ["version", 0.7],
  ];
  const seen = new Set(candidates.map((candidate) => normalizedIdentity(candidate.id)));
  for (const [field, confidence] of fields) {
    const id = safeString(metadata[field]);
    if (!id || seen.has(normalizedIdentity(id))) continue;
    seen.add(normalizedIdentity(id));
    candidates.push(Object.freeze({ id, field, confidence }));
  }
  const fileModifiedAt = metadata.fileModifiedAt;
  if (typeof fileModifiedAt === "number" && Number.isSafeInteger(fileModifiedAt) &&
      fileModifiedAt >= 0) {
    candidates.push(Object.freeze({
      id: `mtime:${fileModifiedAt}`,
      field: "fileModifiedAt",
      confidence: 0.95,
      order: fileModifiedAt,
    }));
  }
  const asOf = safeString(metadata.as_of);
  if (asOf) {
    candidates.push(Object.freeze({ id: `as_of:${asOf}`, field: "as_of", confidence: 0.8 }));
  }
  return Object.freeze(candidates.sort((left, right) =>
    right.confidence - left.confidence || left.field.localeCompare(right.field) ||
      left.id.localeCompare(right.id)));
}

function ordinalCandidates(
  metadata: Readonly<Record<string, unknown>>,
): readonly MarkdownPreprocessOrdinalCandidate[] {
  const ordinal = metadata.ordinal;
  return Number.isSafeInteger(ordinal) && (ordinal as number) >= 0
    ? Object.freeze([Object.freeze({ ordinal: ordinal as number, field: "ordinal", confidence: 1 })])
    : Object.freeze([]);
}

function resourceKind(field: string, locator: string): MarkdownPreprocessResourceKind {
  if (/^(?:https?:\/\/|file:\/\/)/i.test(locator) || ["url", "uri", "homepage"].includes(field)) {
    return "url";
  }
  if (["repo", "repository"].includes(field)) return "repository";
  if (["documentId", "document_id", "doc"].includes(field)) return "document_id";
  if (["tool", "toolName"].includes(field)) return "tool";
  if (["command", "cmd"].includes(field)) return "command";
  return "path";
}

function resourceCandidates(
  metadata: Readonly<Record<string, unknown>>,
): readonly MarkdownPreprocessResourceCandidate[] {
  const fields: ReadonlyArray<readonly [string, number]> = [
    ["url", 0.95], ["uri", 0.95], ["homepage", 0.9], ["filePath", 0.95],
    ["path", 0.9], ["repo", 0.9], ["repository", 0.9], ["documentId", 0.9],
    ["document_id", 0.9], ["doc", 0.8], ["tool", 0.8], ["toolName", 0.8],
    ["command", 0.85], ["cmd", 0.85],
  ];
  const result: MarkdownPreprocessResourceCandidate[] = [];
  const seen = new Set<string>();
  const append = (field: string, raw: unknown, confidence: number): void => {
    const locator = safeString(raw);
    if (!locator) return;
    const kind = resourceKind(field, locator);
    const key = `${kind}:${normalizedIdentity(locator)}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(Object.freeze({ kind, locator, field, confidence }));
  };
  for (const [field, confidence] of fields) append(field, metadata[field], confidence);
  if (Array.isArray(metadata.files) && !nodeUtilTypes.isProxy(metadata.files)) {
    for (const file of metadata.files) append("files", file, 0.75);
  }
  return Object.freeze(result.sort((left, right) =>
    right.confidence - left.confidence || left.kind.localeCompare(right.kind) ||
      left.locator.localeCompare(right.locator)));
}

function topicKey(label: string): string {
  return label.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function topicCandidates(
  metadata: Readonly<Record<string, unknown>>,
): readonly MarkdownPreprocessTopicCandidate[] {
  const result: MarkdownPreprocessTopicCandidate[] = [];
  const seen = new Set<string>();
  const append = (field: string, value: unknown, confidence: number): void => {
    const label = safeString(value);
    if (!label) return;
    const key = topicKey(label);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(Object.freeze({ label, key, field, confidence }));
  };
  if (Array.isArray(metadata.topicLabels) && !nodeUtilTypes.isProxy(metadata.topicLabels)) {
    for (const topic of metadata.topicLabels) append("topicLabels", topic, 0.95);
  }
  append("topic", metadata.topic, 0.9);
  return Object.freeze(result.sort((left, right) =>
    right.confidence - left.confidence || left.key.localeCompare(right.key)));
}

function routeCandidates(
  record: MarkdownWorksetRecord,
  semantic: readonly MarkdownPreprocessSemanticTypeCandidate[],
  topics: readonly MarkdownPreprocessTopicCandidate[],
): MarkdownPreprocessNode["routeCandidates"] {
  const valueScore = score(record.record.metadata.valueScore);
  const metadataImportance = score(record.record.metadata.importance);
  const importance = record.record.importance ?? metadataImportance;
  const source: MarkdownPreprocessRouteAssessment = valueScore === undefined
    ? "insufficient_metadata"
    : valueScore >= 0.55 ? "threshold_met" : "threshold_not_met";
  const onlyProfile = semantic.length === 1 && semantic[0]?.semanticType === "profile";
  const topic: MarkdownPreprocessRouteAssessment = onlyProfile
    ? "not_applicable"
    : valueScore === undefined || importance === undefined || topics.length === 0
      ? "insufficient_metadata"
      : valueScore >= 0.7 && importance >= 0.55
        ? "threshold_met"
        : "threshold_not_met";
  const globalSignal = record.record.metadata.explicitGlobal === true ||
    record.record.metadata.workspaceRule === true ||
    (importance !== undefined && importance >= 0.85);
  const global: MarkdownPreprocessRouteAssessment = topic === "not_applicable"
    ? "not_applicable"
    : topic === "insufficient_metadata"
      ? "insufficient_metadata"
      : topic === "threshold_not_met"
        ? "threshold_not_met"
        : globalSignal ? "threshold_met" : "threshold_not_met";
  return Object.freeze({
    ...(valueScore !== undefined ? { valueScore } : {}),
    ...(importance !== undefined ? { importance } : {}),
    source,
    topic,
    global,
  });
}

function nodeFromCanonicalRecord(record: MarkdownWorksetRecord): MarkdownPreprocessNode {
  const semantic = semanticCandidates(record);
  const logicalSources = logicalSourceCandidates(record.record.metadata);
  const revisions = revisionCandidates(record.record.metadata);
  const ordinals = ordinalCandidates(record.record.metadata);
  const resources = resourceCandidates(record.record.metadata);
  const topics = topicCandidates(record.record.metadata);
  const qualityFlags = [
    ...(!record.scopeFingerprint ? ["missing_scope"] : []),
    ...(logicalSources.length === 0 ? ["missing_logical_source"] : []),
    ...(logicalSources.length > 0 &&
      !logicalSources.some((candidate) => candidate.confidence >= 0.8)
      ? ["weak_logical_source"] : []),
    ...(revisions.length === 0 ? ["missing_revision"] : []),
    ...(revisions.length > 0 && !revisions.some((candidate) => candidate.confidence >= 0.8)
      ? ["weak_revision"] : []),
    ...(semantic.length === 0 ? ["missing_semantic_type"] : []),
    ...(semantic.length > 0 && !semantic.some((candidate) => candidate.confidence >= 0.7)
      ? ["weak_semantic_type"] : []),
    ...(score(record.record.metadata.valueScore) === undefined ? ["missing_value_score"] : []),
    ...(topics.length === 0 ? ["missing_topic"] : []),
    ...(record.record.legacyQuarantineReason ? ["legacy_quarantine"] : []),
  ].sort();
  return Object.freeze({
    sourceRef: record.sourceRef,
    sourceHash: record.sourceHash,
    sourceTable: record.record.sourceTable,
    ...(record.scopeFingerprint ? { scopeFingerprint: record.scopeFingerprint } : {}),
    normalizedContentHash: normalizedContentHash(record.record.text),
    semanticTypeCandidates: semantic,
    logicalSourceCandidates: logicalSources,
    revisionCandidates: revisions,
    ordinalCandidates: ordinals,
    resourceCandidates: resources,
    topicCandidates: topics,
    routeCandidates: routeCandidates(record, semantic, topics),
    qualityFlags: Object.freeze(qualityFlags),
  });
}

export function preprocessMarkdownWorksetRecord(
  record: MarkdownWorksetRecord,
): MarkdownPreprocessNode {
  let parsed: MarkdownWorksetRecord;
  try {
    parsed = parseNativeRecordMarkdown(renderNativeRecordMarkdown(record));
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT");
  }
  if (parsed.phase !== "source") fail("MARKDOWN_WORKSET_PREPROCESS_REQUIRES_SOURCE_PHASE");
  return nodeFromCanonicalRecord(parsed);
}

interface MutableGroup {
  kind: MarkdownPreprocessGroupKind;
  key: string;
  members: Set<string>;
}

const SNAPSHOT_SOURCE_FIELD_PRIORITY = [
  "sourceIdentity", "logicalSource", "documentId", "document_id",
  "filePath", "path", "uri", "url",
] as const;

function snapshotSourceCandidate(
  node: MarkdownPreprocessNode,
): MarkdownPreprocessLogicalSourceCandidate | undefined {
  for (const field of SNAPSHOT_SOURCE_FIELD_PRIORITY) {
    const candidate = node.logicalSourceCandidates.find((value) =>
      value.field === field && value.confidence >= 0.8);
    if (candidate) return candidate;
  }
  return undefined;
}

function addGroup(
  groups: Map<string, MutableGroup>,
  kind: MarkdownPreprocessGroupKind,
  scope: string | undefined,
  identity: string,
  sourceRef: string,
): void {
  if (!scope) return;
  const key = sha256(`${kind}\u001f${scope}\u001f${normalizedIdentity(identity)}`);
  const mapKey = `${kind}:${key}`;
  const group = groups.get(mapKey) ?? { kind, key, members: new Set<string>() };
  group.members.add(sourceRef);
  groups.set(mapKey, group);
}

function buildGroups(
  nodes: readonly MarkdownPreprocessNode[],
  sourceSnapshotSha256: string,
): readonly MarkdownPreprocessGroup[] {
  const groups = new Map<string, MutableGroup>();
  const snapshotSources = new Map<string, Array<Readonly<{
    sourceRef: string;
    ordinal?: number;
    contentHash: string;
  }>>>();
  for (const node of nodes) {
    addGroup(groups, "exact_content", node.scopeFingerprint, node.normalizedContentHash, node.sourceRef);
    for (const source of node.logicalSourceCandidates.filter((candidate) => candidate.confidence >= 0.8)) {
      addGroup(groups, "logical_source", node.scopeFingerprint, source.identity, node.sourceRef);
      for (const revision of node.revisionCandidates.filter((candidate) => candidate.confidence >= 0.8)) {
        addGroup(groups, "source_revision", node.scopeFingerprint,
          `${source.identity}\u001f${revision.id}`, node.sourceRef);
      }
    }
    for (const resource of node.resourceCandidates.filter((candidate) => candidate.confidence >= 0.8)) {
      addGroup(groups, "resource_locator", node.scopeFingerprint,
        `${resource.kind}\u001f${resource.locator}`, node.sourceRef);
    }
    const primarySource = snapshotSourceCandidate(node);
    if (node.scopeFingerprint && primarySource) {
      const sourceKey = sha256(`snapshot_source\u001f${node.scopeFingerprint}\u001f${
        normalizedIdentity(primarySource.identity)}`);
      const members = snapshotSources.get(sourceKey) ?? [];
      members.push(Object.freeze({
        sourceRef: node.sourceRef,
        ordinal: node.ordinalCandidates.find((candidate) => candidate.confidence >= 0.8)?.ordinal,
        contentHash: node.normalizedContentHash,
      }));
      snapshotSources.set(sourceKey, members);
    }
  }
  for (const [sourceKey, members] of snapshotSources) {
    if (members.length < 2 || members.some((member) => member.ordinal === undefined)) continue;
    const ordered = [...members].sort((left, right) =>
      left.ordinal! - right.ordinal! || left.sourceRef.localeCompare(right.sourceRef));
    if (ordered.some((member, index) => member.ordinal !== index)) continue;
    const revisionKey = sha256([
      "snapshot_revision", sourceSnapshotSha256, sourceKey,
      ...ordered.map((member) => `${member.ordinal}\u001f${member.contentHash}`),
    ].join("\u001e"));
    groups.set(`snapshot_revision:${revisionKey}`, {
      kind: "snapshot_revision",
      key: revisionKey,
      members: new Set(ordered.map((member) => member.sourceRef)),
    });
  }
  return Object.freeze([...groups.values()]
    .filter((group) => group.members.size > 1)
    .map((group) => Object.freeze({
      kind: group.kind,
      key: group.key,
      members: Object.freeze([...group.members].sort()),
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key)));
}

const RELATIONSHIP_BY_GROUP: Readonly<Record<MarkdownPreprocessGroupKind,
MarkdownPreprocessRelationshipKind>> = {
  exact_content: "exact_duplicate_candidate",
  logical_source: "same_logical_source_candidate",
  source_revision: "same_revision_candidate",
  snapshot_revision: "same_snapshot_revision_candidate",
  resource_locator: "resource_alias_candidate",
};

function relationshipsFromGroups(
  groups: readonly MarkdownPreprocessGroup[],
): MarkdownPreprocessRelationship[] {
  const relationships: MarkdownPreprocessRelationship[] = [];
  for (const group of groups) {
    const [canonical, ...others] = group.members;
    if (!canonical) continue;
    for (const sourceRef of others) {
      relationships.push(Object.freeze({
        kind: RELATIONSHIP_BY_GROUP[group.kind],
        from: sourceRef,
        to: canonical,
        groupKey: group.key,
      }));
    }
  }
  return relationships;
}

function revisionSuccessorRelationships(
  nodes: readonly MarkdownPreprocessNode[],
): readonly MarkdownPreprocessRelationship[] {
  const bySource = new Map<string, Map<number, string[]>>();
  for (const node of nodes) {
    if (!node.scopeFingerprint) continue;
    const source = node.logicalSourceCandidates.find((candidate) => candidate.confidence >= 0.8);
    const revision = node.revisionCandidates.find((candidate) =>
      candidate.confidence >= 0.8 && candidate.order !== undefined);
    if (!source || revision?.order === undefined) continue;
    const groupKey = sha256(`revision_chain\u001f${node.scopeFingerprint}\u001f${normalizedIdentity(source.identity)}`);
    const revisions = bySource.get(groupKey) ?? new Map<number, string[]>();
    const refs = revisions.get(revision.order) ?? [];
    refs.push(node.sourceRef);
    revisions.set(revision.order, refs);
    bySource.set(groupKey, revisions);
  }
  const relationships: MarkdownPreprocessRelationship[] = [];
  for (const [groupKey, revisions] of bySource) {
    const ordered = [...revisions.entries()].sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = [...ordered[index - 1]![1]].sort()[0];
      const current = [...ordered[index]![1]].sort()[0];
      if (previous && current) {
        relationships.push(Object.freeze({
          kind: "revision_successor_candidate",
          from: current,
          to: previous,
          groupKey,
        }));
      }
    }
  }
  return Object.freeze(relationships);
}

function buildRelationships(
  nodes: readonly MarkdownPreprocessNode[],
  groups: readonly MarkdownPreprocessGroup[],
): readonly MarkdownPreprocessRelationship[] {
  const all = [...relationshipsFromGroups(groups), ...revisionSuccessorRelationships(nodes)];
  const unique = new Map<string, MarkdownPreprocessRelationship>();
  for (const relationship of all) {
    unique.set(`${relationship.kind}:${relationship.from}:${relationship.to}:${relationship.groupKey}`,
      relationship);
  }
  return Object.freeze([...unique.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) || left.groupKey.localeCompare(right.groupKey)));
}

export function assembleMarkdownWorksetPreprocessInventory(
  input: AssembleMarkdownWorksetPreprocessInventoryInput,
): MarkdownWorksetPreprocessInventory {
  if (!plainRecord(input) || !SHA256.test(input.sourceSnapshotSha256) ||
      !safeString(input.policyVersion) || !Array.isArray(input.nodes) ||
      nodeUtilTypes.isProxy(input.nodes)) fail("MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT");
  const seen = new Set<string>();
  const nodes = Object.freeze([...input.nodes].map((node) => {
    const candidate = node as unknown;
    if (!plainRecord(candidate)) fail("MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT");
    const sourceRef = safeString(candidate.sourceRef);
    if (!sourceRef ||
        candidate.sourceTable !== "memories" && candidate.sourceTable !== "knowledge" ||
        typeof candidate.sourceHash !== "string" || !SHA256.test(candidate.sourceHash) ||
        typeof candidate.normalizedContentHash !== "string" ||
        !SHA256.test(candidate.normalizedContentHash) ||
        (candidate.scopeFingerprint !== undefined &&
          (typeof candidate.scopeFingerprint !== "string" ||
            !SHA256.test(candidate.scopeFingerprint)))) {
      fail("MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT");
    }
    if (seen.has(sourceRef)) fail("MARKDOWN_WORKSET_PREPROCESS_DUPLICATE_SOURCE");
    seen.add(sourceRef);
    return node;
  }).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef)));
  const groups = buildGroups(nodes, input.sourceSnapshotSha256);
  const relationships = buildRelationships(nodes, groups);
  const countGroups = (kind: MarkdownPreprocessGroupKind): number =>
    groups.filter((group) => group.kind === kind).length;
  const summary = Object.freeze({
    missingScope: nodes.filter((node) => node.qualityFlags.includes("missing_scope")).length,
    missingLogicalSource: nodes.filter((node) =>
      node.qualityFlags.includes("missing_logical_source")).length,
    weakLogicalSource: nodes.filter((node) =>
      node.qualityFlags.includes("weak_logical_source")).length,
    missingRevision: nodes.filter((node) => node.qualityFlags.includes("missing_revision")).length,
    weakRevision: nodes.filter((node) => node.qualityFlags.includes("weak_revision")).length,
    missingSemanticType: nodes.filter((node) =>
      node.qualityFlags.includes("missing_semantic_type")).length,
    weakSemanticType: nodes.filter((node) =>
      node.qualityFlags.includes("weak_semantic_type")).length,
    bySourceTable: Object.freeze({
      memories: nodes.filter((node) => node.sourceTable === "memories").length,
      knowledge: nodes.filter((node) => node.sourceTable === "knowledge").length,
    }),
    primarySemanticType: Object.freeze({
      profile: nodes.filter((node) => node.semanticTypeCandidates[0]?.semanticType === "profile").length,
      task_context: nodes.filter((node) =>
        node.semanticTypeCandidates[0]?.semanticType === "task_context").length,
      rules: nodes.filter((node) => node.semanticTypeCandidates[0]?.semanticType === "rules").length,
      experience: nodes.filter((node) =>
        node.semanticTypeCandidates[0]?.semanticType === "experience").length,
      resource: nodes.filter((node) =>
        node.semanticTypeCandidates[0]?.semanticType === "resource").length,
      unknown: nodes.filter((node) => node.semanticTypeCandidates.length === 0).length,
    }),
    thresholdMet: Object.freeze({
      source: nodes.filter((node) => node.routeCandidates.source === "threshold_met").length,
      topic: nodes.filter((node) => node.routeCandidates.topic === "threshold_met").length,
      global: nodes.filter((node) => node.routeCandidates.global === "threshold_met").length,
    }),
    exactDuplicateGroups: countGroups("exact_content"),
    logicalSourceGroups: countGroups("logical_source"),
    sourceRevisionGroups: countGroups("source_revision"),
    snapshotRevisionGroups: countGroups("snapshot_revision"),
    resourceLocatorGroups: countGroups("resource_locator"),
  });
  const body = Object.freeze({
    schema: MARKDOWN_WORKSET_PREPROCESS_SCHEMA,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    policyVersion: input.policyVersion,
    sourceCount: nodes.length,
    nodes,
    groups,
    relationships,
    summary,
  });
  return Object.freeze({ ...body, inventorySha256: sha256(stableJson(body)) });
}

export function preprocessMarkdownWorkset(
  input: PreprocessMarkdownWorksetInput,
): MarkdownWorksetPreprocessInventory {
  if (!plainRecord(input) || !SHA256.test(input.sourceSnapshotSha256) ||
      !safeString(input.policyVersion) || !Array.isArray(input.records) ||
      nodeUtilTypes.isProxy(input.records)) fail("MARKDOWN_WORKSET_PREPROCESS_INVALID_INPUT");
  return assembleMarkdownWorksetPreprocessInventory({
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    policyVersion: input.policyVersion,
    nodes: input.records.map(preprocessMarkdownWorksetRecord),
  });
}
