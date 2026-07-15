import { createHash } from "node:crypto";
import { isAbsolute, normalize, relative } from "node:path";
import type { MemoryScope, MemoryVisibility } from "../../domain/types.js";
import {
  resolveProjectAlias,
  type MemoryAutodbRegistry,
  type RegistryProjectLookup,
} from "../../runtime/registry.js";

export interface LegacyScopeBackfillRecord {
  readonly metadata: unknown;
  readonly provenance?: unknown;
}

export interface BackfilledProducer {
  readonly productId: string;
  readonly producerId: string;
}

export interface BackfillEligibility {
  readonly eligibleForRecall: boolean;
  readonly eligibleForContext: boolean;
  readonly eligibleForAnn: boolean;
}

export interface ScopeBackfillAuditEvidence {
  readonly field: string;
  readonly source: string;
  readonly valueHash: string;
}

export interface ScopeBackfillAudit {
  readonly planVersion: "scope-backfill-v1";
  readonly registryVersion: number;
  readonly registryValueHash: string;
  readonly originalValueHash: string;
  readonly evidence: readonly ScopeBackfillAuditEvidence[];
}

export type ScopeBackfillReasonCode =
  | "conflicting-agent-id"
  | "conflicting-app-id"
  | "conflicting-namespace"
  | "conflicting-producer-id"
  | "conflicting-product-id"
  | "conflicting-project-evidence"
  | "conflicting-project-paths"
  | "conflicting-tenant-id"
  | "conflicting-user-id"
  | "conflicting-visibility"
  | "conflicting-workspace-id"
  | "invalid-visibility"
  | "invalid-project-path"
  | "invalid-metadata-shape"
  | "missing-agent-id"
  | "missing-app-id"
  | "missing-namespace"
  | "missing-producer-id"
  | "missing-product-id"
  | "missing-tenant-id"
  | "missing-user-id"
  | "missing-visibility"
  | "missing-workspace-id"
  | "registry-project-conflict"
  | "unknown-project"
  | "unknown-project-reference";

interface CommonBackfillPlan {
  readonly eligibility: BackfillEligibility;
  readonly audit: ScopeBackfillAudit;
}

export interface ResolvedScopeBackfillPlan extends CommonBackfillPlan {
  readonly status: "resolved";
  readonly targetPartition: "canonical";
  readonly scope: MemoryScope;
  readonly producer: BackfilledProducer;
}

export interface QuarantinedScopeBackfillPlan extends CommonBackfillPlan {
  readonly status: "legacy-quarantine";
  readonly targetPartition: "legacy-quarantine";
  readonly reasonCodes: readonly ScopeBackfillReasonCode[];
}

export interface ConflictingScopeBackfillPlan extends CommonBackfillPlan {
  readonly status: "conflict";
  readonly targetPartition: "legacy-quarantine";
  readonly reasonCodes: readonly ScopeBackfillReasonCode[];
}

export type ScopeBackfillPlan =
  | ResolvedScopeBackfillPlan
  | QuarantinedScopeBackfillPlan
  | ConflictingScopeBackfillPlan;

interface EvidenceValue {
  readonly field: string;
  readonly source: string;
  readonly value: string;
}

const DENY_ELIGIBILITY: BackfillEligibility = Object.freeze({
  eligibleForRecall: false,
  eligibleForContext: false,
  eligibleForAnn: false,
});

const ALLOW_ELIGIBILITY: BackfillEligibility = Object.freeze({
  eligibleForRecall: true,
  eligibleForContext: true,
  eligibleForAnn: true,
});

// `default` 是 runtime/authority 与 operator registry 可显式声明的合法 canonical ID。
// 缺字段仍然不会被猜成 default；这里只禁止真正的 unknown/unset/null 占位值。
const UNKNOWN_MARKERS = new Set(["unknown", "unset", "null"]);
const MEMORY_VISIBILITIES = new Set<MemoryVisibility>(["private", "workspace", "team", "public"]);

function asRecord(value: unknown): Record<string, unknown> {
  return isRecordShape(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecordShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function explicitString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || UNKNOWN_MARKERS.has(trimmed.toLocaleLowerCase("en-US"))) return undefined;
  return trimmed;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return { $type: typeof value };
}

function hashValue(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${JSON.stringify(canonicalJsonValue(value))}`)
    .digest("hex");
}

function evidenceHash(value: string): string {
  return hashValue("scope-backfill-evidence-v1", value);
}

function collectEvidence(record: LegacyScopeBackfillRecord): EvidenceValue[] {
  const metadata = asRecord(record.metadata);
  const provenance = asRecord(record.provenance);
  const metadataScope = asRecord(metadata.scope);
  const provenanceScope = asRecord(provenance.scope);
  const metadataProducer = asRecord(metadata.producer);
  const provenanceProducer = asRecord(provenance.producer);
  const evidence: EvidenceValue[] = [];

  const add = (field: string, source: string, value: unknown): void => {
    if (typeof value !== "string" || value.trim().length === 0) return;
    evidence.push({ field, source, value });
  };
  const addScopeField = (field: string): void => {
    add(field, `metadata.${field}`, metadata[field]);
    add(field, `metadata.scope.${field}`, metadataScope[field]);
    add(field, `provenance.${field}`, provenance[field]);
    add(field, `provenance.scope.${field}`, provenanceScope[field]);
  };

  for (const field of ["tenantId", "userId", "appId", "agentId", "namespace", "visibility", "workspaceId"]) {
    addScopeField(field);
  }
  for (const field of ["productId", "producerId"]) {
    add(field, `metadata.${field}`, metadata[field]);
    add(field, `metadata.producer.${field}`, metadataProducer[field]);
    add(field, `provenance.${field}`, provenance[field]);
    add(field, `provenance.producer.${field}`, provenanceProducer[field]);
  }

  add("projectReference", "metadata.projectId", metadata.projectId);
  add("projectReference", "metadata.scope.projectId", metadataScope.projectId);
  add("projectReference", "metadata.projectAlias", metadata.projectAlias);
  add("projectReference", "metadata.manifest.projectId", asRecord(metadata.manifest).projectId);
  add("projectReference", "provenance.projectId", provenance.projectId);
  add("projectReference", "provenance.scope.projectId", provenanceScope.projectId);
  add("projectReference", "provenance.projectAlias", provenance.projectAlias);
  add("projectReference", "provenance.manifest.projectId", asRecord(provenance.manifest).projectId);

  for (const field of ["projectRoot", "projectPath", "cwd", "filePath", "sourcePath"]) {
    add("projectPath", `metadata.${field}`, metadata[field]);
    add("projectPath", `provenance.${field}`, provenance[field]);
  }
  return evidence;
}

function auditFor(
  record: LegacyScopeBackfillRecord,
  registry: MemoryAutodbRegistry,
  evidence: readonly EvidenceValue[],
): ScopeBackfillAudit {
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const auditEvidence = evidence
    .map(({ field, source, value }) => ({ field, source, valueHash: evidenceHash(value) }))
    .sort((left, right) =>
      compare(left.field, right.field) ||
      compare(left.source, right.source) ||
      compare(left.valueHash, right.valueHash));
  return {
    planVersion: "scope-backfill-v1",
    registryVersion: registry.version,
    registryValueHash: hashValue("scope-backfill-registry-v1", registry),
    originalValueHash: hashValue("scope-backfill-original-v1", {
      metadata: record.metadata,
      provenance: record.provenance ?? {},
    }),
    evidence: auditEvidence,
  };
}

function uniqueReasonCodes(reasonCodes: readonly ScopeBackfillReasonCode[]): ScopeBackfillReasonCode[] {
  return [...new Set(reasonCodes)].sort();
}

function conflictPlan(
  reasonCodes: readonly ScopeBackfillReasonCode[],
  audit: ScopeBackfillAudit,
): ConflictingScopeBackfillPlan {
  return {
    status: "conflict",
    targetPartition: "legacy-quarantine",
    reasonCodes: uniqueReasonCodes(reasonCodes),
    eligibility: DENY_ELIGIBILITY,
    audit,
  };
}

function quarantinePlan(
  reasonCodes: readonly ScopeBackfillReasonCode[],
  audit: ScopeBackfillAudit,
): QuarantinedScopeBackfillPlan {
  return {
    status: "legacy-quarantine",
    targetPartition: "legacy-quarantine",
    reasonCodes: uniqueReasonCodes(reasonCodes),
    eligibility: DENY_ELIGIBILITY,
    audit,
  };
}

function resolveField(
  evidence: readonly EvidenceValue[],
  field: string,
): { value?: string; conflict: boolean } {
  const values = new Set<string>();
  for (const item of evidence) {
    if (item.field !== field) continue;
    const value = explicitString(item.value);
    if (value !== undefined) values.add(value);
  }
  return values.size > 1
    ? { conflict: true }
    : { value: values.values().next().value as string | undefined, conflict: false };
}

function pathBelongsToRoot(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function projectsForPath(registry: MemoryAutodbRegistry, rawPath: string): string[] | null {
  if (!isAbsolute(rawPath)) return null;
  const path = normalize(rawPath);
  const projectIds = Object.entries(registry.projects)
    .filter(([, entry]) => {
      const root = entry.canonicalRoot;
      return typeof root === "string" && isAbsolute(root) && pathBelongsToRoot(path, normalize(root));
    })
    .map(([projectId]) => projectId);
  return [...new Set(projectIds)].sort();
}

interface ProjectResolution {
  lookup?: RegistryProjectLookup;
  quarantineReasons: ScopeBackfillReasonCode[];
  conflictReasons: ScopeBackfillReasonCode[];
}

function resolveProject(
  registry: MemoryAutodbRegistry,
  evidence: readonly EvidenceValue[],
): ProjectResolution {
  const references = evidence.filter((item) => item.field === "projectReference");
  const paths = evidence.filter((item) => item.field === "projectPath");
  const lookups: RegistryProjectLookup[] = [];
  let unknownReference = false;
  let registryConflict = false;

  for (const reference of references) {
    const value = explicitString(reference.value);
    if (!value) continue;
    try {
      const lookup = resolveProjectAlias(registry, value);
      if (lookup) lookups.push(lookup);
      else unknownReference = true;
    } catch {
      registryConflict = true;
    }
  }

  let invalidPath = false;
  let conflictingPaths = false;
  for (const pathEvidence of paths) {
    const projects = projectsForPath(registry, pathEvidence.value.trim());
    if (projects === null) {
      invalidPath = true;
      continue;
    }
    if (projects.length > 1) {
      conflictingPaths = true;
      continue;
    }
    if (projects.length === 1) {
      const projectId = projects[0]!;
      lookups.push({
        projectId,
        entry: registry.projects[projectId]!,
        matchedBy: "canonical-path",
        aliasSource: "canonical-path",
        normalizedReference: normalize(pathEvidence.value.trim()),
      });
    }
  }

  const conflictReasons: ScopeBackfillReasonCode[] = [];
  if (registryConflict) conflictReasons.push("registry-project-conflict");
  if (conflictingPaths) conflictReasons.push("conflicting-project-paths");
  const projectIds = new Set(lookups.map((lookup) => lookup.projectId));
  if (projectIds.size > 1 || (unknownReference && lookups.length > 0)) {
    conflictReasons.push("conflicting-project-evidence");
  }
  if (conflictReasons.length > 0) {
    return { quarantineReasons: [], conflictReasons };
  }

  const quarantineReasons: ScopeBackfillReasonCode[] = [];
  if (unknownReference) quarantineReasons.push("unknown-project-reference");
  if (invalidPath) quarantineReasons.push("invalid-project-path");
  if (lookups.length === 0) quarantineReasons.push("unknown-project");
  return { lookup: lookups[0], quarantineReasons, conflictReasons: [] };
}

const REQUIRED_FIELDS = [
  ["tenantId", "missing-tenant-id", "conflicting-tenant-id"],
  ["userId", "missing-user-id", "conflicting-user-id"],
  ["appId", "missing-app-id", "conflicting-app-id"],
  ["agentId", "missing-agent-id", "conflicting-agent-id"],
  ["namespace", "missing-namespace", "conflicting-namespace"],
  ["visibility", "missing-visibility", "conflicting-visibility"],
  ["productId", "missing-product-id", "conflicting-product-id"],
  ["producerId", "missing-producer-id", "conflicting-producer-id"],
] as const satisfies ReadonlyArray<readonly [string, ScopeBackfillReasonCode, ScopeBackfillReasonCode]>;

/**
 * Pure P0-B planner: no provider calls, no filesystem access and no default identity guesses.
 */
export function planLegacyScopeBackfill(
  record: LegacyScopeBackfillRecord,
  registry: MemoryAutodbRegistry,
): ScopeBackfillPlan {
  const evidence = collectEvidence(record);
  const audit = auditFor(record, registry, evidence);
  if (!isRecordShape(record.metadata) ||
      (record.provenance !== undefined && !isRecordShape(record.provenance))) {
    return quarantinePlan(["invalid-metadata-shape"], audit);
  }
  const values = new Map<string, string>();
  const quarantineReasons: ScopeBackfillReasonCode[] = [];
  const conflictReasons: ScopeBackfillReasonCode[] = [];

  for (const [field, missingReason, conflictReason] of REQUIRED_FIELDS) {
    const resolved = resolveField(evidence, field);
    if (resolved.conflict) conflictReasons.push(conflictReason);
    else if (resolved.value) values.set(field, resolved.value);
    else quarantineReasons.push(missingReason);
  }
  const visibility = values.get("visibility");
  if (visibility && !MEMORY_VISIBILITIES.has(visibility as MemoryVisibility)) {
    quarantineReasons.push("invalid-visibility");
  }

  const project = resolveProject(registry, evidence);
  conflictReasons.push(...project.conflictReasons);
  quarantineReasons.push(...project.quarantineReasons);

  if (project.lookup) {
    const workspace = resolveField(evidence, "workspaceId");
    if (workspace.conflict || (workspace.value && workspace.value !== project.lookup.entry.workspaceId)) {
      conflictReasons.push("conflicting-workspace-id");
    }
    if (!project.lookup.entry.workspaceId) quarantineReasons.push("missing-workspace-id");
  }

  if (conflictReasons.length > 0) return conflictPlan(conflictReasons, audit);
  if (quarantineReasons.length > 0 || !project.lookup) {
    return quarantinePlan(quarantineReasons.length > 0 ? quarantineReasons : ["unknown-project"], audit);
  }

  return {
    status: "resolved",
    targetPartition: "canonical",
    scope: {
      tenantId: values.get("tenantId")!,
      userId: values.get("userId")!,
      appId: values.get("appId")!,
      agentId: values.get("agentId")!,
      namespace: values.get("namespace")!,
      visibility: values.get("visibility")! as MemoryVisibility,
      projectId: project.lookup.projectId,
      workspaceId: project.lookup.entry.workspaceId,
    },
    producer: {
      productId: values.get("productId")!,
      producerId: values.get("producerId")!,
    },
    eligibility: ALLOW_ELIGIBILITY,
    audit,
  };
}
