import type { MemoryScopeInput } from "../../../packages/core/src/domain/types.js";

export type EvalPrivateCohort =
  | "governed-canonical"
  | "fresh-holdout"
  | "legacy-paired"
  | "adversarial";

export interface EvalGovernanceProvenance {
  readonly governanceRunId: string;
  readonly governanceState: "provisional" | "verified" | "deployed";
  readonly policyVersion: string;
  readonly sourceSnapshotSha256: string;
  readonly canonicalManifestSha256?: string;
  readonly cutoffAt?: string;
  readonly disposition?: string;
}

export interface EvalCaseV2 {
  readonly schemaVersion: "2";
  readonly id: string;
  readonly track: "general" | "private";
  readonly benchmarkId: string;
  readonly datasetVersion: string;
  readonly split: "dev" | "test";
  readonly capability: string;
  readonly privateCohort?: EvalPrivateCohort;
  readonly governanceProvenance?: EvalGovernanceProvenance;
  readonly scope?: MemoryScopeInput;
  readonly memoryStream: ReadonlyArray<{
    readonly eventId: string;
    readonly occurredAt: string;
    readonly payload: unknown;
    readonly evidenceRef?: string;
  }>;
  readonly query: Readonly<{
    readonly text: string;
    readonly occurredAt?: string;
    readonly expectedMode: "answer" | "action" | "abstain";
  }>;
  readonly gold: Readonly<{
    readonly answer?: unknown;
    readonly action?: unknown;
    readonly requiredEvidenceRefs: readonly string[];
    readonly forbiddenEvidenceRefs?: readonly string[];
    readonly supersededEvidenceRefs?: readonly string[];
  }>;
  readonly protocol: Readonly<{
    readonly ingestMode: "incremental" | "batch";
    readonly topK: number;
    readonly contextTokenBudget: number;
    readonly officialScorer?: string;
  }>;
  readonly official?: Readonly<Record<string, unknown>>;
}

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COHORTS = new Set<EvalPrivateCohort>([
  "governed-canonical", "fresh-holdout", "legacy-paired", "adversarial",
]);

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value !== value.trim() || !SAFE_TEXT.test(value)) {
    throw new Error(`${field} must be a non-empty safe string`);
  }
  return value;
}

function contentText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_000_000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be non-empty bounded text`);
  }
  return value;
}

function iso(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} must be an ISO timestamp`);
  return result;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !SAFE_TEXT.test(item))) {
    throw new Error(`${field} must be an array of safe strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
  return Object.freeze([...value]);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}

function provenance(value: unknown): EvalGovernanceProvenance | undefined {
  if (value === undefined) return undefined;
  const raw = record(value, "governanceProvenance");
  if (!["provisional", "verified", "deployed"].includes(String(raw.governanceState))) {
    throw new Error("governanceProvenance.governanceState is invalid");
  }
  const sourceSnapshotSha256 = text(
    raw.sourceSnapshotSha256,
    "governanceProvenance.sourceSnapshotSha256",
  );
  if (!SHA256.test(sourceSnapshotSha256)) {
    throw new Error("governanceProvenance.sourceSnapshotSha256 must be a SHA-256 digest");
  }
  const canonicalManifestSha256 = raw.canonicalManifestSha256 === undefined
    ? undefined
    : text(raw.canonicalManifestSha256, "governanceProvenance.canonicalManifestSha256");
  if (canonicalManifestSha256 !== undefined && !SHA256.test(canonicalManifestSha256)) {
    throw new Error("governanceProvenance.canonicalManifestSha256 must be a SHA-256 digest");
  }
  return Object.freeze({
    governanceRunId: text(raw.governanceRunId, "governanceProvenance.governanceRunId"),
    governanceState: raw.governanceState as EvalGovernanceProvenance["governanceState"],
    policyVersion: text(raw.policyVersion, "governanceProvenance.policyVersion"),
    sourceSnapshotSha256,
    ...(canonicalManifestSha256 === undefined ? {} : { canonicalManifestSha256 }),
    ...(raw.cutoffAt === undefined ? {} : { cutoffAt: iso(raw.cutoffAt, "governanceProvenance.cutoffAt") }),
    ...(raw.disposition === undefined ? {} : {
      disposition: text(raw.disposition, "governanceProvenance.disposition"),
    }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function parseEvalCaseV2(value: unknown): Readonly<EvalCaseV2> {
  const raw = record(value, "EvalCaseV2");
  if (raw.schemaVersion !== "2") throw new Error("schemaVersion must be '2'");
  if (raw.track !== "general" && raw.track !== "private") throw new Error("track is invalid");
  if (raw.split !== "dev" && raw.split !== "test") throw new Error("split is invalid");
  const privateCohort = raw.privateCohort === undefined
    ? undefined
    : raw.privateCohort as EvalPrivateCohort;
  if ((raw.track === "private") !== (privateCohort !== undefined) ||
      (privateCohort !== undefined && !COHORTS.has(privateCohort))) {
    throw new Error("privateCohort is invalid for track");
  }
  const governanceProvenance = provenance(raw.governanceProvenance);
  if (raw.track === "private" && governanceProvenance === undefined) {
    throw new Error("private case requires governance provenance");
  }
  if (raw.track === "private" && raw.split === "test" &&
      governanceProvenance?.governanceState !== "verified" &&
      governanceProvenance?.governanceState !== "deployed") {
    throw new Error("private test case requires verified or deployed governance");
  }
  if (!Array.isArray(raw.memoryStream)) throw new Error("memoryStream must be an array");
  const memoryStream = raw.memoryStream.map((value, index) => {
    const event = record(value, `memoryStream[${index}]`);
    return Object.freeze({
      eventId: text(event.eventId, `memoryStream[${index}].eventId`),
      occurredAt: iso(event.occurredAt, `memoryStream[${index}].occurredAt`),
      payload: structuredClone(event.payload),
      ...(event.evidenceRef === undefined ? {} : {
        evidenceRef: text(event.evidenceRef, `memoryStream[${index}].evidenceRef`),
      }),
    });
  });
  if (new Set(memoryStream.map((event) => event.eventId)).size !== memoryStream.length) {
    throw new Error("memoryStream eventId must be unique");
  }
  const queryRaw = record(raw.query, "query");
  if (!["answer", "action", "abstain"].includes(String(queryRaw.expectedMode))) {
    throw new Error("query.expectedMode is invalid");
  }
  const goldRaw = record(raw.gold, "gold");
  const requiredEvidenceRefs = strings(goldRaw.requiredEvidenceRefs, "gold.requiredEvidenceRefs");
  const availableEvidence = new Set(memoryStream.flatMap((event) =>
    event.evidenceRef === undefined ? [] : [event.evidenceRef]));
  for (const evidenceRef of requiredEvidenceRefs) {
    if (!availableEvidence.has(evidenceRef)) {
      throw new Error(`required evidence ref '${evidenceRef}' is missing from memoryStream`);
    }
  }
  const protocolRaw = record(raw.protocol, "protocol");
  if (protocolRaw.ingestMode !== "incremental" && protocolRaw.ingestMode !== "batch") {
    throw new Error("protocol.ingestMode is invalid");
  }
  const parsed: EvalCaseV2 = {
    schemaVersion: "2",
    id: text(raw.id, "id"),
    track: raw.track,
    benchmarkId: text(raw.benchmarkId, "benchmarkId"),
    datasetVersion: text(raw.datasetVersion, "datasetVersion"),
    split: raw.split,
    capability: text(raw.capability, "capability"),
    ...(privateCohort === undefined ? {} : { privateCohort }),
    ...(governanceProvenance === undefined ? {} : { governanceProvenance }),
    ...(raw.scope === undefined ? {} : { scope: structuredClone(raw.scope as MemoryScopeInput) }),
    memoryStream: Object.freeze(memoryStream),
    query: Object.freeze({
      text: contentText(queryRaw.text, "query.text"),
      ...(queryRaw.occurredAt === undefined ? {} : {
        occurredAt: iso(queryRaw.occurredAt, "query.occurredAt"),
      }),
      expectedMode: queryRaw.expectedMode as EvalCaseV2["query"]["expectedMode"],
    }),
    gold: Object.freeze({
      ...(goldRaw.answer === undefined ? {} : { answer: structuredClone(goldRaw.answer) }),
      ...(goldRaw.action === undefined ? {} : { action: structuredClone(goldRaw.action) }),
      requiredEvidenceRefs,
      ...(goldRaw.forbiddenEvidenceRefs === undefined ? {} : {
        forbiddenEvidenceRefs: strings(goldRaw.forbiddenEvidenceRefs, "gold.forbiddenEvidenceRefs"),
      }),
      ...(goldRaw.supersededEvidenceRefs === undefined ? {} : {
        supersededEvidenceRefs: strings(
          goldRaw.supersededEvidenceRefs,
          "gold.supersededEvidenceRefs",
        ),
      }),
    }),
    protocol: Object.freeze({
      ingestMode: protocolRaw.ingestMode,
      topK: positiveInteger(protocolRaw.topK, "protocol.topK"),
      contextTokenBudget: positiveInteger(
        protocolRaw.contextTokenBudget,
        "protocol.contextTokenBudget",
      ),
      ...(protocolRaw.officialScorer === undefined ? {} : {
        officialScorer: text(protocolRaw.officialScorer, "protocol.officialScorer"),
      }),
    }),
    ...(raw.official === undefined ? {} : {
      official: structuredClone(record(raw.official, "official")),
    }),
  };
  return deepFreeze(parsed);
}
