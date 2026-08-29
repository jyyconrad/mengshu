import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

export const PRIVATE_EVIDENCE_BINDINGS_SCHEMA =
  "mengshu.private-evidence-bindings/v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const STATUSES = new Set<PrivateEvidenceStatus>([
  "active", "superseded", "quarantined",
]);

export type PrivateEvidenceStatus = "active" | "superseded" | "quarantined";

export interface PrivateEvidenceInputArtifact {
  readonly artifact: string;
  readonly sha256: string;
}

export interface PrivateEvidenceAnchor {
  /** Byte offsets are over the exact UTF-8 source content identified by sourceContentHash. */
  readonly utf8ByteStart: number;
  readonly utf8ByteEnd: number;
  /** Hash of the anchored bytes. The private manifest never stores the excerpt itself. */
  readonly excerptHash: string;
}

export interface PrivateClaimEvidenceBinding {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly claimId: string;
  readonly evidenceId: string;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly sourceContentHash: string;
  readonly scopeFingerprint: string;
  readonly anchor: PrivateEvidenceAnchor;
  readonly status: PrivateEvidenceStatus;
  /** Stable private Knowledge resource identity, when the source has one. */
  readonly resourceIdentity: string | null;
}

export interface PrivateEvidenceExpectedAsset {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly scopeFingerprint: string;
  readonly claimIds: readonly string[];
}

export interface PrivateClaimCoverage {
  readonly claimId: string;
  readonly activeEvidenceCount: number;
  readonly totalEvidenceCount: number;
}

export interface PrivateAssetClaimCoverage {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly scopeFingerprint: string;
  readonly claims: readonly PrivateClaimCoverage[];
  readonly claimCount: number;
  readonly activeClaimCount: number;
  readonly claimCoverage: 1;
}

export interface PrivateEvidenceBindingsOutputHashes {
  readonly bindingsSha256: string;
  readonly assetClaimCoverageSha256: string;
}

export interface PrivateEvidenceBindingsSummary {
  readonly assetCount: number;
  readonly claimCount: number;
  readonly bindingCount: number;
  readonly activeBindingCount: number;
  readonly supersededBindingCount: number;
  readonly quarantinedBindingCount: number;
  readonly claimCoverage: 1;
}

export interface PrivateEvidenceBindingsManifest {
  readonly schema: typeof PRIVATE_EVIDENCE_BINDINGS_SCHEMA;
  readonly governanceRunId: string;
  readonly createdAt: string;
  readonly inputs: readonly PrivateEvidenceInputArtifact[];
  readonly bindings: readonly PrivateClaimEvidenceBinding[];
  readonly assetCoverage: readonly PrivateAssetClaimCoverage[];
  readonly outputs: PrivateEvidenceBindingsOutputHashes;
  readonly summary: PrivateEvidenceBindingsSummary;
  readonly guards: Readonly<{
    privateOnly: true;
    publicMarkdownProjectionForbidden: true;
  }>;
  readonly manifestSha256: string;
}

export interface CreatePrivateEvidenceBindingsManifestInput {
  readonly governanceRunId: string;
  readonly createdAt: string;
  readonly inputs: readonly PrivateEvidenceInputArtifact[];
  readonly expectedAssets: readonly PrivateEvidenceExpectedAsset[];
  readonly bindings: readonly PrivateClaimEvidenceBinding[];
}

export interface ValidatePrivateEvidenceBindingsContext {
  readonly expectedAssets?: readonly PrivateEvidenceExpectedAsset[];
  readonly expectedInputs?: readonly PrivateEvidenceInputArtifact[];
}

export class PrivateEvidenceBindingsContractError extends Error {
  constructor(message: string) {
    super(`PRIVATE_EVIDENCE_BINDINGS_INVALID: ${message}`);
    this.name = "PrivateEvidenceBindingsContractError";
  }
}

function fail(message: string): never {
  throw new PrivateEvidenceBindingsContractError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape or proxy is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} exact keys are invalid`);
  }
  return value;
}

function array(value: unknown, label: string, allowEmpty = false): readonly unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} array or proxy is invalid`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || !SAFE_ID.test(value)) {
    fail(`${label} ID is invalid`);
  }
  return value;
}

function safeSourceRef(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value !== value.trim() ||
      value.length === 0 || value.length > 4096 || /[\p{Cc}\r\n]/u.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} hash is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} is invalid`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} ISO timestamp is invalid`);
  return value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical value contains non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("canonical value proxy or cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("canonical value shape, proxy, or cycle");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key !== key.normalize("NFC") || item === undefined || typeof item === "function" ||
        typeof item === "symbol" || typeof item === "bigint") fail("canonical value is invalid");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0")
    .update(JSON.stringify(stableValue(value))).digest("hex");
}

function serializedHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function compareInputs(left: PrivateEvidenceInputArtifact, right: PrivateEvidenceInputArtifact): number {
  return left.artifact.localeCompare(right.artifact);
}

function compareAssets(
  left: Pick<PrivateEvidenceExpectedAsset, "assetId" | "assetVersion">,
  right: Pick<PrivateEvidenceExpectedAsset, "assetId" | "assetVersion">,
): number {
  return left.assetId.localeCompare(right.assetId) || left.assetVersion - right.assetVersion;
}

function compareBindings(left: PrivateClaimEvidenceBinding, right: PrivateClaimEvidenceBinding): number {
  return compareAssets(left, right) || left.claimId.localeCompare(right.claimId) ||
    left.evidenceId.localeCompare(right.evidenceId) || left.sourceRef.localeCompare(right.sourceRef) ||
    left.anchor.utf8ByteStart - right.anchor.utf8ByteStart ||
    left.anchor.utf8ByteEnd - right.anchor.utf8ByteEnd;
}

function requireSorted<T>(items: readonly T[], compare: (left: T, right: T) => number, label: string): void {
  for (let index = 1; index < items.length; index += 1) {
    if (compare(items[index - 1]!, items[index]!) >= 0) {
      fail(`${label} must be strictly sorted and unique`);
    }
  }
}

function validateInputArtifact(value: unknown, label: string): PrivateEvidenceInputArtifact {
  const item = exactKeys(value, ["artifact", "sha256"], label);
  return Object.freeze({
    artifact: safeId(item.artifact, `${label}.artifact`),
    sha256: hash(item.sha256, `${label}.sha256`),
  });
}

function validateInputs(value: unknown, label = "inputs"): readonly PrivateEvidenceInputArtifact[] {
  const result = array(value, label).map((item, index) =>
    validateInputArtifact(item, `${label}[${index}]`));
  requireSorted(result, compareInputs, label);
  return Object.freeze(result);
}

function validateExpectedAsset(value: unknown, label: string): PrivateEvidenceExpectedAsset {
  const item = exactKeys(value, [
    "assetId", "assetVersion", "scopeFingerprint", "claimIds",
  ], label);
  const claimIds = array(item.claimIds, `${label}.claimIds`).map((claimId) =>
    safeId(claimId, `${label}.claimId`));
  for (let index = 1; index < claimIds.length; index += 1) {
    if (claimIds[index - 1]!.localeCompare(claimIds[index]!) >= 0) {
      fail(`${label}.claimIds must be strictly sorted and unique`);
    }
  }
  return Object.freeze({
    assetId: safeId(item.assetId, `${label}.assetId`),
    assetVersion: positiveInteger(item.assetVersion, `${label}.assetVersion`),
    scopeFingerprint: hash(item.scopeFingerprint, `${label}.scopeFingerprint`),
    claimIds: Object.freeze(claimIds),
  });
}

function validateExpectedAssets(
  value: unknown,
  label = "expectedAssets",
): readonly PrivateEvidenceExpectedAsset[] {
  const result = array(value, label).map((item, index) =>
    validateExpectedAsset(item, `${label}[${index}]`));
  requireSorted(result, compareAssets, label);
  return Object.freeze(result);
}

function validateAnchor(value: unknown, label: string): PrivateEvidenceAnchor {
  const item = exactKeys(value, ["utf8ByteStart", "utf8ByteEnd", "excerptHash"], label);
  const utf8ByteStart = nonNegativeInteger(item.utf8ByteStart, `${label}.utf8ByteStart`);
  const utf8ByteEnd = nonNegativeInteger(item.utf8ByteEnd, `${label}.utf8ByteEnd`);
  if (utf8ByteEnd <= utf8ByteStart) fail(`${label} byte range is invalid`);
  return Object.freeze({
    utf8ByteStart,
    utf8ByteEnd,
    excerptHash: hash(item.excerptHash, `${label}.excerptHash`),
  });
}

function validateBinding(value: unknown, label: string): PrivateClaimEvidenceBinding {
  const item = exactKeys(value, [
    "assetId", "assetVersion", "claimId", "evidenceId", "sourceRef", "sourceHash",
    "sourceContentHash", "scopeFingerprint", "anchor", "status", "resourceIdentity",
  ], label);
  if (typeof item.status !== "string" || !STATUSES.has(item.status as PrivateEvidenceStatus)) {
    fail(`${label}.status is invalid`);
  }
  return Object.freeze({
    assetId: safeId(item.assetId, `${label}.assetId`),
    assetVersion: positiveInteger(item.assetVersion, `${label}.assetVersion`),
    claimId: safeId(item.claimId, `${label}.claimId`),
    evidenceId: safeId(item.evidenceId, `${label}.evidenceId`),
    sourceRef: safeSourceRef(item.sourceRef, `${label}.sourceRef`),
    sourceHash: hash(item.sourceHash, `${label}.sourceHash`),
    sourceContentHash: hash(item.sourceContentHash, `${label}.sourceContentHash`),
    scopeFingerprint: hash(item.scopeFingerprint, `${label}.scopeFingerprint`),
    anchor: validateAnchor(item.anchor, `${label}.anchor`),
    status: item.status as PrivateEvidenceStatus,
    resourceIdentity: item.resourceIdentity === null
      ? null : safeId(item.resourceIdentity, `${label}.resourceIdentity`),
  });
}

function evidenceIdentity(binding: PrivateClaimEvidenceBinding): string {
  return JSON.stringify({
    evidenceId: binding.evidenceId,
    sourceRef: binding.sourceRef,
    sourceHash: binding.sourceHash,
    sourceContentHash: binding.sourceContentHash,
    scopeFingerprint: binding.scopeFingerprint,
    anchor: binding.anchor,
    resourceIdentity: binding.resourceIdentity,
  });
}

function validateBindings(value: unknown): readonly PrivateClaimEvidenceBinding[] {
  const result = array(value, "bindings").map((item, index) =>
    validateBinding(item, `bindings[${index}]`));
  const compositeKeys = new Set<string>();
  const evidenceById = new Map<string, string>();
  const sourceByRef = new Map<string, string>();
  for (const binding of result) {
    const composite = [
      binding.assetId, binding.assetVersion, binding.claimId, binding.evidenceId,
    ].join("\0");
    if (compositeKeys.has(composite)) fail("bindings contain a duplicate claim evidence binding");
    compositeKeys.add(composite);
    const evidence = evidenceIdentity(binding);
    const previousEvidence = evidenceById.get(binding.evidenceId);
    if (previousEvidence !== undefined && previousEvidence !== evidence) {
      fail(`evidence ${binding.evidenceId} is inconsistent`);
    }
    evidenceById.set(binding.evidenceId, evidence);
    const sourceIdentity = JSON.stringify({
      sourceHash: binding.sourceHash,
      sourceContentHash: binding.sourceContentHash,
      scopeFingerprint: binding.scopeFingerprint,
      resourceIdentity: binding.resourceIdentity,
    });
    const previousSource = sourceByRef.get(binding.sourceRef);
    if (previousSource !== undefined && previousSource !== sourceIdentity) {
      fail(`source ${binding.sourceRef} is inconsistent`);
    }
    sourceByRef.set(binding.sourceRef, sourceIdentity);
  }
  requireSorted(result, compareBindings, "bindings");
  return Object.freeze(result);
}

function assetKey(value: Pick<PrivateEvidenceExpectedAsset, "assetId" | "assetVersion">): string {
  return `${value.assetId}\0${value.assetVersion}`;
}

function buildCoverage(
  expectedAssets: readonly PrivateEvidenceExpectedAsset[],
  bindings: readonly PrivateClaimEvidenceBinding[],
): readonly PrivateAssetClaimCoverage[] {
  const expectedByAsset = new Map(expectedAssets.map((asset) => [assetKey(asset), asset]));
  for (const binding of bindings) {
    const asset = expectedByAsset.get(assetKey(binding));
    if (!asset) fail(`binding asset ${binding.assetId}@${binding.assetVersion} is unknown`);
    if (binding.scopeFingerprint !== asset.scopeFingerprint) fail("binding crosses asset scope");
    if (!asset.claimIds.includes(binding.claimId)) fail(`binding claim ${binding.claimId} is unknown`);
  }
  return Object.freeze(expectedAssets.map((asset) => {
    const assetBindings = bindings.filter((binding) => assetKey(binding) === assetKey(asset));
    const claims = asset.claimIds.map((claimId) => {
      const claimBindings = assetBindings.filter((binding) => binding.claimId === claimId);
      const activeEvidenceCount = claimBindings.filter((binding) => binding.status === "active").length;
      if (activeEvidenceCount < 1) {
        fail(`claim ${asset.assetId}@${asset.assetVersion}/${claimId} has no active evidence`);
      }
      return Object.freeze({
        claimId,
        activeEvidenceCount,
        totalEvidenceCount: claimBindings.length,
      });
    });
    return Object.freeze({
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      scopeFingerprint: asset.scopeFingerprint,
      claims: Object.freeze(claims),
      claimCount: claims.length,
      activeClaimCount: claims.length,
      claimCoverage: 1 as const,
    });
  }));
}

function validateClaimCoverage(value: unknown): PrivateClaimCoverage {
  const item = exactKeys(value, [
    "claimId", "activeEvidenceCount", "totalEvidenceCount",
  ], "claim coverage");
  const activeEvidenceCount = positiveInteger(
    item.activeEvidenceCount, "claim coverage activeEvidenceCount",
  );
  const totalEvidenceCount = positiveInteger(
    item.totalEvidenceCount, "claim coverage totalEvidenceCount",
  );
  if (activeEvidenceCount > totalEvidenceCount) fail("claim coverage counts are inconsistent");
  return Object.freeze({
    claimId: safeId(item.claimId, "claim coverage claimId"),
    activeEvidenceCount,
    totalEvidenceCount,
  });
}

function validateAssetCoverage(value: unknown): PrivateAssetClaimCoverage {
  const item = exactKeys(value, [
    "assetId", "assetVersion", "scopeFingerprint", "claims", "claimCount",
    "activeClaimCount", "claimCoverage",
  ], "asset coverage");
  const claims = array(item.claims, "asset coverage claims").map(validateClaimCoverage);
  for (let index = 1; index < claims.length; index += 1) {
    if (claims[index - 1]!.claimId.localeCompare(claims[index]!.claimId) >= 0) {
      fail("asset coverage claims must be strictly sorted and unique");
    }
  }
  if (item.claimCount !== claims.length || item.activeClaimCount !== claims.length ||
      item.claimCoverage !== 1) fail("asset claim coverage is not complete");
  return Object.freeze({
    assetId: safeId(item.assetId, "asset coverage assetId"),
    assetVersion: positiveInteger(item.assetVersion, "asset coverage assetVersion"),
    scopeFingerprint: hash(item.scopeFingerprint, "asset coverage scopeFingerprint"),
    claims: Object.freeze(claims),
    claimCount: claims.length,
    activeClaimCount: claims.length,
    claimCoverage: 1,
  });
}

function validateAssetCoverages(value: unknown): readonly PrivateAssetClaimCoverage[] {
  const result = array(value, "assetCoverage").map(validateAssetCoverage);
  requireSorted(result, compareAssets, "assetCoverage");
  return Object.freeze(result);
}

function expectedFromCoverage(
  coverage: readonly PrivateAssetClaimCoverage[],
): readonly PrivateEvidenceExpectedAsset[] {
  return Object.freeze(coverage.map((asset) => Object.freeze({
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    scopeFingerprint: asset.scopeFingerprint,
    claimIds: Object.freeze(asset.claims.map((claim) => claim.claimId)),
  })));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function summaryFor(
  assetCoverage: readonly PrivateAssetClaimCoverage[],
  bindings: readonly PrivateClaimEvidenceBinding[],
): PrivateEvidenceBindingsSummary {
  return Object.freeze({
    assetCount: assetCoverage.length,
    claimCount: assetCoverage.reduce((sum, asset) => sum + asset.claimCount, 0),
    bindingCount: bindings.length,
    activeBindingCount: bindings.filter((binding) => binding.status === "active").length,
    supersededBindingCount: bindings.filter((binding) => binding.status === "superseded").length,
    quarantinedBindingCount: bindings.filter((binding) => binding.status === "quarantined").length,
    claimCoverage: 1,
  });
}

function manifestBody(value: Omit<PrivateEvidenceBindingsManifest, "manifestSha256">): unknown {
  return value;
}

export function createPrivateEvidenceBindingsManifest(
  value: CreatePrivateEvidenceBindingsManifestInput,
): PrivateEvidenceBindingsManifest {
  const input = exactKeys(value, [
    "governanceRunId", "createdAt", "inputs", "expectedAssets", "bindings",
  ], "create input");
  const inputs = validateInputs(input.inputs);
  const expectedAssets = validateExpectedAssets(input.expectedAssets);
  const bindings = validateBindings(input.bindings);
  const assetCoverage = buildCoverage(expectedAssets, bindings);
  const body = {
    schema: PRIVATE_EVIDENCE_BINDINGS_SCHEMA,
    governanceRunId: safeId(input.governanceRunId, "governanceRunId"),
    createdAt: iso(input.createdAt, "createdAt"),
    inputs,
    bindings,
    assetCoverage,
    outputs: Object.freeze({
      bindingsSha256: canonicalHash("mengshu.private-evidence-bindings/bindings/v1", bindings),
      assetClaimCoverageSha256: canonicalHash(
        "mengshu.private-evidence-bindings/asset-claim-coverage/v1", assetCoverage,
      ),
    }),
    summary: summaryFor(assetCoverage, bindings),
    guards: Object.freeze({
      privateOnly: true as const,
      publicMarkdownProjectionForbidden: true as const,
    }),
  };
  return deepFreeze({
    ...body,
    manifestSha256: canonicalHash(
      "mengshu.private-evidence-bindings/manifest/v1", manifestBody(body),
    ),
  }) as PrivateEvidenceBindingsManifest;
}

export function validatePrivateEvidenceBindingsManifest(
  value: unknown,
  context: ValidatePrivateEvidenceBindingsContext = {},
): PrivateEvidenceBindingsManifest {
  const root = exactKeys(value, [
    "schema", "governanceRunId", "createdAt", "inputs", "bindings", "assetCoverage",
    "outputs", "summary", "guards", "manifestSha256",
  ], "private evidence bindings manifest");
  if (root.schema !== PRIVATE_EVIDENCE_BINDINGS_SCHEMA) fail("manifest schema is invalid");
  const inputs = validateInputs(root.inputs);
  const bindings = validateBindings(root.bindings);
  const assetCoverage = validateAssetCoverages(root.assetCoverage);
  const rebuiltCoverage = buildCoverage(expectedFromCoverage(assetCoverage), bindings);
  if (!sameCanonical(assetCoverage, rebuiltCoverage)) fail("asset claim coverage drifted");

  const outputs = exactKeys(root.outputs, [
    "bindingsSha256", "assetClaimCoverageSha256",
  ], "output hashes");
  const normalizedOutputs = Object.freeze({
    bindingsSha256: hash(outputs.bindingsSha256, "bindingsSha256"),
    assetClaimCoverageSha256: hash(
      outputs.assetClaimCoverageSha256, "assetClaimCoverageSha256",
    ),
  });
  if (normalizedOutputs.bindingsSha256 !== canonicalHash(
    "mengshu.private-evidence-bindings/bindings/v1", bindings,
  ) || normalizedOutputs.assetClaimCoverageSha256 !== canonicalHash(
    "mengshu.private-evidence-bindings/asset-claim-coverage/v1", assetCoverage,
  )) fail("output hash drifted");

  const summary = exactKeys(root.summary, [
    "assetCount", "claimCount", "bindingCount", "activeBindingCount",
    "supersededBindingCount", "quarantinedBindingCount", "claimCoverage",
  ], "summary");
  const normalizedSummary: PrivateEvidenceBindingsSummary = Object.freeze({
    assetCount: nonNegativeInteger(summary.assetCount, "summary.assetCount"),
    claimCount: nonNegativeInteger(summary.claimCount, "summary.claimCount"),
    bindingCount: nonNegativeInteger(summary.bindingCount, "summary.bindingCount"),
    activeBindingCount: nonNegativeInteger(
      summary.activeBindingCount, "summary.activeBindingCount",
    ),
    supersededBindingCount: nonNegativeInteger(
      summary.supersededBindingCount, "summary.supersededBindingCount",
    ),
    quarantinedBindingCount: nonNegativeInteger(
      summary.quarantinedBindingCount, "summary.quarantinedBindingCount",
    ),
    claimCoverage: summary.claimCoverage === 1
      ? 1 : fail("summary claim coverage is not complete"),
  });
  if (!sameCanonical(normalizedSummary, summaryFor(assetCoverage, bindings))) {
    fail("summary counts drifted");
  }

  const guards = exactKeys(root.guards, [
    "privateOnly", "publicMarkdownProjectionForbidden",
  ], "guards");
  if (guards.privateOnly !== true || guards.publicMarkdownProjectionForbidden !== true) {
    fail("private/public Markdown guards are invalid");
  }
  const body = {
    schema: PRIVATE_EVIDENCE_BINDINGS_SCHEMA,
    governanceRunId: safeId(root.governanceRunId, "governanceRunId"),
    createdAt: iso(root.createdAt, "createdAt"),
    inputs,
    bindings,
    assetCoverage,
    outputs: normalizedOutputs,
    summary: normalizedSummary,
    guards: Object.freeze({
      privateOnly: true as const,
      publicMarkdownProjectionForbidden: true as const,
    }),
  };
  const manifestSha256 = hash(root.manifestSha256, "manifestSha256");
  if (manifestSha256 !== canonicalHash(
    "mengshu.private-evidence-bindings/manifest/v1", manifestBody(body),
  )) fail("manifest hash drifted");

  const contextRecord = exactKeys(context, [
    ...(context.expectedAssets === undefined ? [] : ["expectedAssets"]),
    ...(context.expectedInputs === undefined ? [] : ["expectedInputs"]),
  ], "validation context");
  if (contextRecord.expectedAssets !== undefined) {
    const expectedAssets = validateExpectedAssets(contextRecord.expectedAssets, "context expectedAssets");
    if (!sameCanonical(expectedAssets, expectedFromCoverage(assetCoverage))) {
      fail("external asset/claim coverage drifted");
    }
  }
  if (contextRecord.expectedInputs !== undefined) {
    const expectedInputs = validateInputs(contextRecord.expectedInputs, "context expectedInputs");
    if (!sameCanonical(expectedInputs, inputs)) fail("external input coverage drifted");
  }
  return deepFreeze({ ...body, manifestSha256 }) as PrivateEvidenceBindingsManifest;
}

export function serializePrivateEvidenceBindingsManifest(
  value: PrivateEvidenceBindingsManifest,
): string {
  return canonicalJson(validatePrivateEvidenceBindingsManifest(value));
}

export function parsePrivateEvidenceBindingsManifest(
  serialized: string,
  context: ValidatePrivateEvidenceBindingsContext = {},
): PrivateEvidenceBindingsManifest {
  if (typeof serialized !== "string") fail("serialized manifest is invalid");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("serialized manifest JSON is invalid");
  }
  if (canonicalJson(value) !== serialized) fail("serialized manifest is not canonical JSON");
  return validatePrivateEvidenceBindingsManifest(value, context);
}

export function privateEvidenceBindingsManifestSha256(
  value: PrivateEvidenceBindingsManifest,
): string {
  return serializedHash(serializePrivateEvidenceBindingsManifest(value));
}
