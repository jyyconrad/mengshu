import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
} from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import {
  parseNativeRecordMarkdown,
  renderNativeRecordMarkdown,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetRecord,
} from "./markdown-workset.js";

export const MARKDOWN_SCOPE_REGISTRY_SCHEMA =
  "mengshu.authority-scope-registry/v1" as const;

export interface MarkdownScopeRegistryEntry {
  readonly scopeFingerprint: string;
  readonly scope: MemoryScope;
  readonly sourceCount: number;
  readonly memorySourceCount: number;
  readonly knowledgeSourceCount: number;
  readonly sourceSetSha256: string;
}

export interface MarkdownScopeRegistrySummary {
  readonly sourceCount: number;
  readonly scopedSourceCount: number;
  readonly unscopedSourceCount: number;
  readonly memoryScopedSourceCount: number;
  readonly knowledgeScopedSourceCount: number;
  readonly scopeCount: number;
}

export interface MarkdownScopeRegistry {
  readonly schema: typeof MARKDOWN_SCOPE_REGISTRY_SCHEMA;
  readonly migrationRunId: string;
  readonly sourceManifestFileSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly createdAt: string;
  readonly entries: readonly MarkdownScopeRegistryEntry[];
  readonly summary: MarkdownScopeRegistrySummary;
  readonly registrySha256: string;
}

export interface CreateMarkdownScopeRegistryInput {
  readonly migrationRunId: string;
  readonly sourceManifestFileSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly createdAt: string;
  readonly records: readonly MarkdownWorksetRecord[];
}

export type MarkdownScopeRegistryErrorCode =
  | "MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT"
  | "MARKDOWN_SCOPE_REGISTRY_SCOPE_DRIFT"
  | "MARKDOWN_SCOPE_REGISTRY_DUPLICATE_SOURCE"
  | "MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT";

const MESSAGES: Readonly<Record<MarkdownScopeRegistryErrorCode, string>> = {
  MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT: "Markdown scope registry input is invalid",
  MARKDOWN_SCOPE_REGISTRY_SCOPE_DRIFT: "Markdown scope registry authority scope drifted",
  MARKDOWN_SCOPE_REGISTRY_DUPLICATE_SOURCE: "Markdown scope registry source is duplicated",
  MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT: "Markdown scope registry artifact drifted",
};

export class MarkdownScopeRegistryError extends Error {
  constructor(readonly code: MarkdownScopeRegistryErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownScopeRegistryError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[^\s\p{Cc}]{1,1024}$/u;
const ENTRY_KEYS = [
  "scopeFingerprint", "scope", "sourceCount", "memorySourceCount",
  "knowledgeSourceCount", "sourceSetSha256",
] as const;
const SCOPE_REQUIRED_KEYS = [
  "tenantId", "appId", "userId", "projectId", "agentId", "namespace", "visibility",
] as const;
const SCOPE_OPTIONAL_KEYS = ["workspaceId", "sessionId"] as const;
const SUMMARY_KEYS = [
  "sourceCount", "scopedSourceCount", "unscopedSourceCount",
  "memoryScopedSourceCount", "knowledgeScopedSourceCount", "scopeCount",
] as const;
const REGISTRY_KEYS = [
  "schema", "migrationRunId", "sourceManifestFileSha256", "sourceSnapshotSha256",
  "createdAt", "entries", "summary", "registrySha256",
] as const;

function fail(code: MarkdownScopeRegistryErrorCode): never {
  throw new MarkdownScopeRegistryError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) {
    fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
  }
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * 重放 source workset 导出时冻结的 authority scope 规则。sessionId 当时未进入指纹，
 * 因此这里也不能从 metadata 猜测或补入。
 */
export function authorityScopeFromMarkdownRecord(
  record: MarkdownWorksetNativeRecord,
): MemoryScope | undefined {
  const required = [
    record.tenantId,
    record.userId,
    record.canonicalProjectId,
    record.productId,
    record.producerId,
    record.namespace,
    record.visibility,
  ];
  if (required.some((value) => value === undefined || value === "")) return undefined;
  const scope: MemoryScope = {
    tenantId: record.tenantId!,
    appId: record.productId!,
    userId: record.userId!,
    projectId: record.canonicalProjectId!,
    agentId: record.producerId!,
    namespace: record.namespace!,
    visibility: record.visibility!,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
  };
  try {
    canonicalAuthorityScope(scope);
  } catch {
    return undefined;
  }
  return Object.freeze(scope);
}

function validateScope(value: unknown): asserts value is MemoryScope {
  if (!plainRecord(value) || !exactKeys(value, SCOPE_REQUIRED_KEYS, SCOPE_OPTIONAL_KEYS)) {
    fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
  }
  try {
    canonicalAuthorityScope(value as unknown as MemoryScope);
  } catch {
    fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
  }
}

function registrySemanticSha256(
  value: Omit<MarkdownScopeRegistry, "registrySha256">,
): string {
  return sha256(stableJson(value));
}

interface MutableEntry {
  scope: MemoryScope;
  sources: string[];
  memorySourceCount: number;
  knowledgeSourceCount: number;
}

export function createMarkdownScopeRegistry(
  input: CreateMarkdownScopeRegistryInput,
): MarkdownScopeRegistry {
  if (!plainRecord(input) || !exactKeys(input, [
    "migrationRunId", "sourceManifestFileSha256", "sourceSnapshotSha256",
    "createdAt", "records",
  ]) || typeof input.migrationRunId !== "string" || !SAFE_ID.test(input.migrationRunId) ||
      !SHA256.test(input.sourceManifestFileSha256) ||
      !SHA256.test(input.sourceSnapshotSha256) || !validIso(input.createdAt) ||
      !Array.isArray(input.records) || nodeUtilTypes.isProxy(input.records)) {
    fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
  }
  const seenSources = new Set<string>();
  const grouped = new Map<string, MutableEntry>();
  let unscopedSourceCount = 0;
  for (const candidate of input.records) {
    let record: MarkdownWorksetRecord;
    try {
      record = parseNativeRecordMarkdown(renderNativeRecordMarkdown(candidate));
    } catch {
      fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
    }
    if (record.phase !== "source") fail("MARKDOWN_SCOPE_REGISTRY_INVALID_INPUT");
    if (seenSources.has(record.sourceRef)) {
      fail("MARKDOWN_SCOPE_REGISTRY_DUPLICATE_SOURCE");
    }
    seenSources.add(record.sourceRef);
    const scope = authorityScopeFromMarkdownRecord(record.record);
    if (!record.scopeFingerprint) {
      if (scope) fail("MARKDOWN_SCOPE_REGISTRY_SCOPE_DRIFT");
      unscopedSourceCount += 1;
      continue;
    }
    if (!scope || authorityScopeFingerprint(scope) !== record.scopeFingerprint) {
      fail("MARKDOWN_SCOPE_REGISTRY_SCOPE_DRIFT");
    }
    const current = grouped.get(record.scopeFingerprint);
    if (current) {
      if (stableJson(current.scope) !== stableJson(scope)) {
        fail("MARKDOWN_SCOPE_REGISTRY_SCOPE_DRIFT");
      }
      current.sources.push(`${record.sourceRef}\u001f${record.sourceHash}`);
      if (record.record.sourceTable === "memories") current.memorySourceCount += 1;
      else current.knowledgeSourceCount += 1;
    } else {
      grouped.set(record.scopeFingerprint, {
        scope,
        sources: [`${record.sourceRef}\u001f${record.sourceHash}`],
        memorySourceCount: record.record.sourceTable === "memories" ? 1 : 0,
        knowledgeSourceCount: record.record.sourceTable === "knowledge" ? 1 : 0,
      });
    }
  }
  const entries = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([scopeFingerprint, value]): MarkdownScopeRegistryEntry => {
      const sources = [...value.sources].sort((left, right) => left.localeCompare(right));
      return Object.freeze({
        scopeFingerprint,
        scope: value.scope,
        sourceCount: sources.length,
        memorySourceCount: value.memorySourceCount,
        knowledgeSourceCount: value.knowledgeSourceCount,
        sourceSetSha256: sha256(sources.join("\n")),
      });
    });
  const memoryScopedSourceCount = entries.reduce(
    (total, entry) => total + entry.memorySourceCount, 0,
  );
  const knowledgeScopedSourceCount = entries.reduce(
    (total, entry) => total + entry.knowledgeSourceCount, 0,
  );
  const summary: MarkdownScopeRegistrySummary = Object.freeze({
    sourceCount: input.records.length,
    scopedSourceCount: memoryScopedSourceCount + knowledgeScopedSourceCount,
    unscopedSourceCount,
    memoryScopedSourceCount,
    knowledgeScopedSourceCount,
    scopeCount: entries.length,
  });
  const payload = Object.freeze({
    schema: MARKDOWN_SCOPE_REGISTRY_SCHEMA,
    migrationRunId: input.migrationRunId,
    sourceManifestFileSha256: input.sourceManifestFileSha256,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    createdAt: input.createdAt,
    entries: Object.freeze(entries),
    summary,
  });
  return Object.freeze({ ...payload, registrySha256: registrySemanticSha256(payload) });
}

function validateRegistry(value: unknown): asserts value is MarkdownScopeRegistry {
  if (!plainRecord(value) || !exactKeys(value, REGISTRY_KEYS) ||
      value.schema !== MARKDOWN_SCOPE_REGISTRY_SCHEMA ||
      typeof value.migrationRunId !== "string" || !SAFE_ID.test(value.migrationRunId) ||
      typeof value.sourceManifestFileSha256 !== "string" ||
      !SHA256.test(value.sourceManifestFileSha256) ||
      typeof value.sourceSnapshotSha256 !== "string" ||
      !SHA256.test(value.sourceSnapshotSha256) || !validIso(value.createdAt) ||
      !Array.isArray(value.entries) || nodeUtilTypes.isProxy(value.entries) ||
      !plainRecord(value.summary) || !exactKeys(value.summary, SUMMARY_KEYS) ||
      typeof value.registrySha256 !== "string" || !SHA256.test(value.registrySha256)) {
    fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
  }
  let previous: string | undefined;
  let memory = 0;
  let knowledge = 0;
  for (const entry of value.entries) {
    if (!plainRecord(entry) || !exactKeys(entry, ENTRY_KEYS) ||
        typeof entry.scopeFingerprint !== "string" || !SHA256.test(entry.scopeFingerprint) ||
        previous !== undefined && previous.localeCompare(entry.scopeFingerprint) >= 0 ||
        !nonNegativeInteger(entry.sourceCount) || !nonNegativeInteger(entry.memorySourceCount) ||
        !nonNegativeInteger(entry.knowledgeSourceCount) ||
        entry.sourceCount !== entry.memorySourceCount + entry.knowledgeSourceCount ||
        typeof entry.sourceSetSha256 !== "string" || !SHA256.test(entry.sourceSetSha256)) {
      fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
    }
    validateScope(entry.scope);
    if (authorityScopeFingerprint(entry.scope) !== entry.scopeFingerprint) {
      fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
    }
    previous = entry.scopeFingerprint;
    memory += entry.memorySourceCount as number;
    knowledge += entry.knowledgeSourceCount as number;
  }
  const summary = value.summary as unknown as MarkdownScopeRegistrySummary;
  if (Object.values(summary).some((item) => !nonNegativeInteger(item)) ||
      summary.scopeCount !== value.entries.length ||
      summary.memoryScopedSourceCount !== memory ||
      summary.knowledgeScopedSourceCount !== knowledge ||
      summary.scopedSourceCount !== memory + knowledge ||
      summary.sourceCount !== summary.scopedSourceCount + summary.unscopedSourceCount) {
    fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
  }
  const { registrySha256, ...payload } = value;
  if (registrySemanticSha256(payload as Omit<MarkdownScopeRegistry, "registrySha256">) !==
      registrySha256) fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
}

export function serializeMarkdownScopeRegistry(registry: MarkdownScopeRegistry): string {
  validateRegistry(registry);
  return `${JSON.stringify(stableValue(registry), null, 2)}\n`;
}

export function parseMarkdownScopeRegistry(serialized: string): MarkdownScopeRegistry {
  if (typeof serialized !== "string") fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("MARKDOWN_SCOPE_REGISTRY_ARTIFACT_DRIFT");
  }
  validateRegistry(value);
  return stableValue(value) as MarkdownScopeRegistry;
}
