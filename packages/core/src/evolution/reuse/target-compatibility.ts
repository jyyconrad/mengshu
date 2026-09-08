import { createHash } from "node:crypto";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import type { SkillArtifactVersion } from "../../skills/types.js";
import { sameExactReuseScope } from "./explicit-reuse-authorizer.js";
import type { ReuseTargetCompatibility } from "./reuse-read-access.js";

export interface TargetExecutionProfile {
  readonly model: { readonly provider: string; readonly modelId: string; readonly revision: string };
  readonly tools: readonly { readonly name: string; readonly version: string; readonly schemaHash: string }[];
  readonly environmentFingerprint: string;
  /** Host-confirmed applicability facts, not conditions asserted by the artifact itself. */
  readonly applicability: readonly string[];
}

export interface CompatibilitySubject {
  readonly kind: "memory" | "skill";
  readonly id: string;
  readonly revision: string;
  readonly contentHash: string;
  readonly sourceScope: MemoryScope;
}

export interface ReuseCompatibilityBinding {
  readonly subject: CompatibilitySubject;
  readonly targetScope: MemoryScope;
  readonly targetFingerprint: string;
  readonly executionMode: "suggest_only";
  readonly status: "validated" | "revoked";
  readonly evaluatorId: string;
  readonly planHash: string;
  readonly reportHash: string;
  readonly holdoutRef: string;
  readonly reviewReceiptId: string;
  readonly validatedAt: string;
  readonly expiresAt: string;
}

/** The host must verify review/evaluation receipts before admitting a persisted binding to this port. */
export interface TargetCompatibilityHostPort {
  readTarget(targetScope: MemoryScope): Promise<TargetExecutionProfile | undefined>;
  readBinding(subject: CompatibilitySubject, targetScope: MemoryScope): Promise<ReuseCompatibilityBinding | undefined>;
}

const ID = /^[^\s\p{Cc}]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_HASH = /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/;
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

export function reuseDigest(tag: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify([tag, value])).digest("hex");
}

export function fingerprintTargetProfile(profile: TargetExecutionProfile): string {
  if (!profile || !profile.model ||
      ![profile.model.provider, profile.model.modelId, profile.model.revision].every((value) =>
        typeof value === "string" && ID.test(value)) ||
      /^(?:latest|default|auto|unknown)$/i.test(profile.model.revision) ||
      !SHA256.test(profile.environmentFingerprint) || !Array.isArray(profile.tools) ||
      profile.tools.length > 128 || profile.tools.some((tool) => !tool || !validId(tool.name) ||
        !validId(tool.version) || /^(?:latest|default|auto|unknown)$/i.test(tool.version) || !SHA256.test(tool.schemaHash)) ||
      new Set(profile.tools.map((tool) => tool.name)).size !== profile.tools.length ||
      !Array.isArray(profile.applicability) || profile.applicability.length === 0 ||
      profile.applicability.length > 128 || profile.applicability.some((item) => !validId(item)) ||
      new Set(profile.applicability).size !== profile.applicability.length) {
    throw new TypeError("REUSE_TARGET_PROFILE_INVALID");
  }
  return reuseDigest("mengshu.target-execution-profile/v1", [
    [profile.model.provider, profile.model.modelId, profile.model.revision],
    [...profile.tools].sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => [tool.name, tool.version, tool.schemaHash]),
    profile.environmentFingerprint,
    [...profile.applicability].sort(),
  ]);
}

export function fingerprintCompatibilitySubject(subject: CompatibilitySubject): string {
  if (!subject || !["memory", "skill"].includes(subject.kind) || !validId(subject.id) ||
      !validId(subject.revision) || !CONTENT_HASH.test(subject.contentHash)) {
    throw new TypeError("REUSE_COMPATIBILITY_SUBJECT_INVALID");
  }
  return reuseDigest("mengshu.compatibility-subject/v1", [subject.kind, subject.id,
    subject.revision, subject.contentHash, authorityScopeFingerprint(subject.sourceScope)]);
}

export function memoryCompatibilitySubject(record: MemoryRecord): CompatibilitySubject {
  const revision = record.metadata?.revision ?? record.updatedAt ?? record.createdAt;
  return Object.freeze({ kind: "memory", id: record.id, revision: String(revision),
    contentHash: record.contentHash, sourceScope: Object.freeze({ ...record.scope }) });
}

export function skillCompatibilitySubject(artifact: SkillArtifactVersion): CompatibilitySubject {
  return Object.freeze({ kind: "skill", id: artifact.skillId, revision: String(artifact.version),
    contentHash: artifact.contentHash, sourceScope: Object.freeze({ ...artifact.scope }) });
}

export function isCompatibleBinding(binding: ReuseCompatibilityBinding | undefined, input: {
  readonly subject: CompatibilitySubject;
  readonly targetScope: MemoryScope;
  readonly target: TargetExecutionProfile;
  readonly now: number;
}): boolean {
  try {
    if (!binding || binding.status !== "validated" || binding.executionMode !== "suggest_only" ||
        ![binding.evaluatorId, binding.holdoutRef, binding.reviewReceiptId].every((id) => typeof id === "string" && ID.test(id)) ||
        !SHA256.test(binding.planHash) || !SHA256.test(binding.reportHash) || !Number.isFinite(input.now)) return false;
    const start = Date.parse(binding.validatedAt);
    const end = Date.parse(binding.expiresAt);
    return Number.isFinite(start) && Number.isFinite(end) && end > start &&
      start <= input.now && input.now < end &&
      binding.targetFingerprint === fingerprintTargetProfile(input.target) &&
      fingerprintCompatibilitySubject(binding.subject) === fingerprintCompatibilitySubject(input.subject) &&
      sameExactReuseScope(binding.targetScope, input.targetScope) &&
      input.subject.sourceScope.tenantId === input.targetScope.tenantId &&
      input.subject.sourceScope.userId === input.targetScope.userId;
  } catch {
    return false;
  }
}

/** No cache: a model/tool change or host binding revocation takes effect on the next read. */
export class HostReuseCompatibilityReader implements ReuseTargetCompatibility {
  constructor(private readonly host: TargetCompatibilityHostPort, private readonly now: () => number = Date.now) {}

  async #allows(subject: CompatibilitySubject, targetScope: MemoryScope): Promise<boolean> {
    try {
      const target = await this.host.readTarget(targetScope);
      const binding = await this.host.readBinding(subject, targetScope);
      const current = await this.host.readTarget(targetScope);
      return target !== undefined && current !== undefined &&
        fingerprintTargetProfile(target) === fingerprintTargetProfile(current) && isCompatibleBinding(binding, {
        subject, targetScope, target, now: this.now(),
      });
    } catch {
      return false;
    }
  }

  allows(record: MemoryRecord, targetScope: MemoryScope): Promise<boolean> {
    return this.#allows(memoryCompatibilitySubject(record), targetScope);
  }

  allowsSkill(artifact: SkillArtifactVersion, targetScope: MemoryScope): Promise<boolean> {
    if (!artifact || artifact.status !== "published" || artifact.executionMode !== "suggest_only" ||
        artifact.ownerUserId !== artifact.scope?.userId || !Array.isArray(artifact.manifest) ||
        artifact.manifest.some((item) => !item || item.executable !== false)) {
      return Promise.resolve(false);
    }
    return this.#allows(skillCompatibilitySubject(artifact), targetScope);
  }
}
