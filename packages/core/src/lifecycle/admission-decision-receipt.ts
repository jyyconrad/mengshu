/**
 * Persisted admission decision receipts (accept/reject) for Agent explainability.
 *
 * Postgres is the durable primary path. In-memory holds last-decision for the
 * process (and is the only path on LanceDB). Receipt persistence is best-effort
 * relative to the write: admission itself stays fail-closed; a store failure
 * must not flip an accepted write into a reject.
 */

import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { WriteAdmissionRoute, WriteScope } from "../service/write-kernel.js";

export type AdmissionDecisionOutcome = "accepted" | "rejected";

export type AdmissionDecisionReceiptSource =
  | "write_kernel"
  | "explain_dry_run"
  | "mcp_observe";

export interface AdmissionDecisionReceiptV1 {
  readonly version: 1;
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly candidateHash: string;
  readonly decision: AdmissionDecisionOutcome;
  readonly reasonCodes: readonly string[];
  readonly semanticType: MemorySemanticType;
  readonly route?: WriteAdmissionRoute | string;
  readonly memoryId?: string;
  readonly rejectedReason?: string;
  readonly source: AdmissionDecisionReceiptSource;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AdmissionDecisionReceiptRepository {
  append(
    scope: MemoryScope | WriteScope,
    receipt: AdmissionDecisionReceiptV1,
  ): Promise<AdmissionDecisionReceiptV1>;
  getLatest(
    scope: MemoryScope | WriteScope,
  ): Promise<AdmissionDecisionReceiptV1 | undefined>;
  getByCandidateHash(
    scope: MemoryScope | WriteScope,
    candidateHash: string,
  ): Promise<AdmissionDecisionReceiptV1 | undefined>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function invalid(message = "Admission decision receipt is invalid"): never {
  throw new Error(message);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    invalid();
  }
  return value;
}

export function toMemoryScopeForReceipt(scope: MemoryScope | WriteScope): MemoryScope {
  const visibility = scope.visibility ?? "private";
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility,
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
  });
}

export function fingerprintAdmissionScope(scope: MemoryScope | WriteScope): string {
  return authorityScopeFingerprint(toMemoryScopeForReceipt(scope));
}

export function computeAdmissionCandidateHash(input: {
  readonly text: string;
  readonly semanticType: MemorySemanticType;
  readonly temporality?: string;
  readonly profileDimension?: string;
}): string {
  return digest([
    "mengshu.admission-candidate/v1",
    input.text.trim(),
    input.semanticType,
    input.temporality ?? "",
    input.profileDimension ?? "",
  ]);
}

export function validatePersistedAdmissionDecisionReceipt(
  value: unknown,
): AdmissionDecisionReceiptV1 {
  if (!plain(value)) invalid();
  if (value.version !== 1) invalid();
  if (typeof value.id !== "string" || !SHA256.test(value.id)) invalid();
  if (typeof value.scopeFingerprint !== "string" || !SHA256.test(value.scopeFingerprint)) {
    invalid();
  }
  if (typeof value.candidateHash !== "string" || !SHA256.test(value.candidateHash)) {
    invalid();
  }
  if (value.decision !== "accepted" && value.decision !== "rejected") invalid();
  if (!Array.isArray(value.reasonCodes) ||
      value.reasonCodes.some((code) => typeof code !== "string" || code.length === 0 || code.length > 256)) {
    invalid();
  }
  if (typeof value.semanticType !== "string" ||
      !SEMANTIC_TYPES.has(value.semanticType as MemorySemanticType)) {
    invalid();
  }
  if (value.route !== undefined && (typeof value.route !== "string" || value.route.length > 128)) {
    invalid();
  }
  if (value.memoryId !== undefined &&
      (typeof value.memoryId !== "string" || value.memoryId.length === 0 || value.memoryId.length > 256)) {
    invalid();
  }
  if (value.rejectedReason !== undefined &&
      (typeof value.rejectedReason !== "string" || value.rejectedReason.length > 256)) {
    invalid();
  }
  if (
    value.source !== "write_kernel" &&
    value.source !== "explain_dry_run" &&
    value.source !== "mcp_observe"
  ) {
    invalid();
  }
  const createdAt = timestamp(value.createdAt);
  const expiresAt = timestamp(value.expiresAt);
  if (Date.parse(expiresAt) < Date.parse(createdAt)) invalid();

  const receiptWithoutId = { ...value };
  delete (receiptWithoutId as { id?: string }).id;
  if (digest(["mengshu.admission-decision-receipt/v1", receiptWithoutId]) !== value.id) {
    invalid("Admission decision receipt id mismatch");
  }

  return deepFreeze({
    version: 1 as const,
    id: value.id,
    scopeFingerprint: value.scopeFingerprint,
    candidateHash: value.candidateHash,
    decision: value.decision,
    reasonCodes: Object.freeze([...value.reasonCodes as string[]]),
    semanticType: value.semanticType as MemorySemanticType,
    ...(value.route === undefined ? {} : { route: value.route as string }),
    ...(value.memoryId === undefined ? {} : { memoryId: value.memoryId as string }),
    ...(value.rejectedReason === undefined
      ? {}
      : { rejectedReason: value.rejectedReason as string }),
    source: value.source as AdmissionDecisionReceiptSource,
    createdAt,
    expiresAt,
  });
}

export function createAdmissionDecisionReceipt(input: {
  readonly scope: MemoryScope | WriteScope;
  readonly text: string;
  readonly semanticType: MemorySemanticType;
  readonly decision: AdmissionDecisionOutcome;
  readonly reasonCodes: readonly string[];
  readonly source: AdmissionDecisionReceiptSource;
  readonly route?: string;
  readonly memoryId?: string;
  readonly rejectedReason?: string;
  readonly temporality?: string;
  readonly profileDimension?: string;
  readonly now?: number;
  readonly ttlMs?: number;
}): AdmissionDecisionReceiptV1 {
  if (!SEMANTIC_TYPES.has(input.semanticType)) {
    throw new Error("Admission decision receipt requires a 5type semanticType");
  }
  if (input.reasonCodes.length === 0) {
    throw new Error("Admission decision receipt requires reasonCodes");
  }
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const scopeFingerprint = fingerprintAdmissionScope(input.scope);
  const candidateHash = computeAdmissionCandidateHash({
    text: input.text,
    semanticType: input.semanticType,
    temporality: input.temporality,
    profileDimension: input.profileDimension,
  });
  const body = {
    version: 1 as const,
    scopeFingerprint,
    candidateHash,
    decision: input.decision,
    reasonCodes: Object.freeze([...input.reasonCodes]),
    semanticType: input.semanticType,
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.memoryId === undefined ? {} : { memoryId: input.memoryId }),
    ...(input.rejectedReason === undefined ? {} : { rejectedReason: input.rejectedReason }),
    source: input.source,
    createdAt,
    expiresAt,
  };
  const id = digest(["mengshu.admission-decision-receipt/v1", body]);
  return validatePersistedAdmissionDecisionReceipt({ ...body, id });
}

export class InMemoryAdmissionDecisionReceiptRepository
implements AdmissionDecisionReceiptRepository {
  private readonly byScope = new Map<string, AdmissionDecisionReceiptV1[]>();
  private readonly maxPerScope: number;
  private readonly now: () => number;

  constructor(options: { maxPerScope?: number; now?: () => number } = {}) {
    this.maxPerScope = options.maxPerScope ?? 64;
    this.now = options.now ?? Date.now;
  }

  async append(
    scope: MemoryScope | WriteScope,
    value: AdmissionDecisionReceiptV1,
  ): Promise<AdmissionDecisionReceiptV1> {
    const receipt = validatePersistedAdmissionDecisionReceipt(value);
    const fingerprint = fingerprintAdmissionScope(scope);
    if (receipt.scopeFingerprint !== fingerprint) {
      throw new Error("Admission decision receipt scope mismatch");
    }
    const list = this.byScope.get(fingerprint) ?? [];
    const existing = list.find((item) => item.id === receipt.id);
    if (existing) return existing;
    list.unshift(receipt);
    while (list.length > this.maxPerScope) list.pop();
    this.byScope.set(fingerprint, list);
    return receipt;
  }

  async getLatest(
    scope: MemoryScope | WriteScope,
  ): Promise<AdmissionDecisionReceiptV1 | undefined> {
    const fingerprint = fingerprintAdmissionScope(scope);
    const now = this.now();
    const list = (this.byScope.get(fingerprint) ?? []).filter(
      (item) => Date.parse(item.expiresAt) >= now,
    );
    this.byScope.set(fingerprint, list);
    return list[0];
  }

  async getByCandidateHash(
    scope: MemoryScope | WriteScope,
    candidateHash: string,
  ): Promise<AdmissionDecisionReceiptV1 | undefined> {
    if (!SHA256.test(candidateHash)) {
      throw new Error("Admission candidate hash is invalid");
    }
    const fingerprint = fingerprintAdmissionScope(scope);
    const now = this.now();
    const list = (this.byScope.get(fingerprint) ?? []).filter(
      (item) => Date.parse(item.expiresAt) >= now,
    );
    this.byScope.set(fingerprint, list);
    return list.find((item) => item.candidateHash === candidateHash);
  }
}

/**
 * Writes to primary (Postgres) and mirror (in-memory). Reads prefer primary,
 * then fall back to mirror. Primary failures on append fall back to mirror only
 * (best-effort durability); read failures fall back to mirror.
 */
export class CompositeAdmissionDecisionReceiptRepository
implements AdmissionDecisionReceiptRepository {
  constructor(
    private readonly primary: AdmissionDecisionReceiptRepository,
    private readonly mirror: AdmissionDecisionReceiptRepository,
  ) {}

  async append(
    scope: MemoryScope | WriteScope,
    receipt: AdmissionDecisionReceiptV1,
  ): Promise<AdmissionDecisionReceiptV1> {
    let persisted = receipt;
    try {
      persisted = await this.primary.append(scope, receipt);
    } catch {
      // Durable path optional; mirror still records last-decision.
    }
    return this.mirror.append(scope, persisted);
  }

  async getLatest(
    scope: MemoryScope | WriteScope,
  ): Promise<AdmissionDecisionReceiptV1 | undefined> {
    try {
      const fromPrimary = await this.primary.getLatest(scope);
      if (fromPrimary) return fromPrimary;
    } catch {
      // fall through
    }
    return this.mirror.getLatest(scope);
  }

  async getByCandidateHash(
    scope: MemoryScope | WriteScope,
    candidateHash: string,
  ): Promise<AdmissionDecisionReceiptV1 | undefined> {
    try {
      const fromPrimary = await this.primary.getByCandidateHash(scope, candidateHash);
      if (fromPrimary) return fromPrimary;
    } catch {
      // fall through
    }
    return this.mirror.getByCandidateHash(scope, candidateHash);
  }
}

/** Best-effort recorder used by write-kernel / explain — never throws to caller. */
export async function recordAdmissionDecisionBestEffort(
  repository: AdmissionDecisionReceiptRepository | undefined,
  scope: MemoryScope | WriteScope,
  receipt: AdmissionDecisionReceiptV1,
): Promise<void> {
  if (!repository) return;
  try {
    await repository.append(scope, receipt);
  } catch {
    // Observability must not fail closed the write/explain path.
  }
}
