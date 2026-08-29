import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { parseTypedMemoryBatchPlan } from
  "../packages/core/src/db/migrations/typed-memory-batch-plan.js";
import {
  computeGovernanceProjectionHash,
  computePublicContentHash,
  validateGovernedDocumentAssetVersion,
} from "../packages/core/src/documents/canonical.js";
import {
  createGovernedCanonicalManifest,
  serializeGovernedCanonicalManifest,
  type SourceBinding,
} from "../packages/core/src/documents/curation-artifacts.js";
import {
  parseGovernedDocumentMarkdown,
  renderGovernedDocumentMarkdown,
} from "../packages/core/src/documents/markdown-codec.js";
import {
  parsePrivateEvidenceBindingsManifest,
  type PrivateClaimEvidenceBinding,
} from "../packages/core/src/documents/private-evidence-bindings.js";
import type {
  CanonicalPublicDocumentContent,
  GovernedDocumentAssetVersion,
  GovernedDocumentProjection,
  GovernanceDisposition,
} from "../packages/core/src/documents/types.js";
import { resolveCanonicalVaultPlacement } from "../packages/core/src/vault/placement.js";

const INPUT_SCHEMA = "mengshu.p6-materialization-input/v1";
const RESOLUTION_SCHEMA = "mengshu.p5-final-asset-resolution/v1";
const UNIT_LEDGER_SCHEMA = "mengshu.p5-final-unit-disposition/v1";
const RECEIPT_SCHEMA = "mengshu.p6-materialization-receipt/v1";
const SOURCE_MANIFEST_SCHEMA = "mengshu.markdown-workset-manifest/v1";
const KNOWLEDGE_DISPOSITION_SCHEMA = "mengshu.knowledge-source-disposition/v1";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;

interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

interface P6Input {
  readonly schema: typeof INPUT_SCHEMA;
  readonly governanceRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceManifest: ArtifactRef;
  readonly typedMemoryPlan: ArtifactRef;
  readonly p5Resolution: ArtifactRef;
  readonly p5UnitLedger: ArtifactRef;
  readonly privateEvidence: ArtifactRef;
  readonly knowledgeDispositions: ArtifactRef;
  readonly vaultRoot: string;
  readonly privateBindingsRoot: string;
  readonly receiptRoot: string;
}

interface P5SourceAnchor {
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly excerptHash: string;
}

interface P5ResolvedAsset {
  readonly assetId: string;
  readonly proposalId: string;
  readonly governanceClusterId: string | null;
  readonly scopeFingerprint: string;
  readonly scope: GovernedDocumentAssetVersion["scope"];
  readonly semanticType: NonNullable<GovernedDocumentAssetVersion["semanticType"]>;
  readonly unitIds: readonly string[];
  readonly title: string;
  readonly claims: readonly {
    readonly claimId: string;
    readonly claimKey: string;
    readonly text: string;
    readonly supportingUnitIds: readonly string[];
    readonly sourceBindings: readonly P5SourceAnchor[];
  }[];
  readonly relations: readonly {
    readonly type: GovernedDocumentAssetVersion["relations"][number]["type"];
    readonly targetAssetId: string;
    readonly reasonCode: string;
  }[];
  readonly internalClaimRelations: readonly {
    readonly type: string;
    readonly fromClaimId: string;
    readonly toClaimId: string;
    readonly reasonCode: string;
  }[];
  readonly confidence: number;
  readonly resolutionKind: string;
  readonly candidateOnly: true;
}

interface P5UnitDisposition {
  readonly unitId: string;
  readonly scopeFingerprint: string;
  readonly semanticType: string;
  readonly sourceBindings: readonly SourceBinding[];
  readonly action: "publish_candidate" | "defer" | "quarantine";
  readonly targetAssetId: string | null;
  readonly reasonCodes: readonly string[];
}

class P6MaterializationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "P6MaterializationError";
  }
}

function fail(code: string): never {
  throw new P6MaterializationError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalLine(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("P6_MATERIALIZATION_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const item = record(value);
  const actual = Object.keys(item).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P6_MATERIALIZATION_INPUT_INVALID");
  }
  return item;
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) fail("P6_MATERIALIZATION_PATH_INVALID");
  const target = resolve(root, relativePath);
  if (!strictDescendant(root, target)) fail("P6_MATERIALIZATION_PATH_INVALID");
  return target;
}

function artifact(value: unknown): ArtifactRef {
  const item = exactKeys(value, ["path", "sha256"]);
  if (typeof item.path !== "string" || typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)) fail("P6_MATERIALIZATION_INPUT_INVALID");
  return { path: item.path, sha256: item.sha256 };
}

function parseInput(value: unknown): P6Input {
  const item = exactKeys(value, [
    "schema", "governanceRunId", "policyVersion", "createdAt", "sourceManifest",
    "typedMemoryPlan", "p5Resolution", "p5UnitLedger", "privateEvidence",
    "knowledgeDispositions", "vaultRoot", "privateBindingsRoot", "receiptRoot",
  ]);
  if (item.schema !== INPUT_SCHEMA || typeof item.governanceRunId !== "string" ||
      !SAFE_ID.test(item.governanceRunId) || typeof item.policyVersion !== "string" ||
      item.policyVersion.length === 0 || typeof item.createdAt !== "string" ||
      new Date(item.createdAt).toISOString() !== item.createdAt ||
      typeof item.vaultRoot !== "string" || typeof item.privateBindingsRoot !== "string" ||
      typeof item.receiptRoot !== "string") fail("P6_MATERIALIZATION_INPUT_INVALID");
  return {
    schema: INPUT_SCHEMA,
    governanceRunId: item.governanceRunId,
    policyVersion: item.policyVersion,
    createdAt: item.createdAt,
    sourceManifest: artifact(item.sourceManifest),
    typedMemoryPlan: artifact(item.typedMemoryPlan),
    p5Resolution: artifact(item.p5Resolution),
    p5UnitLedger: artifact(item.p5UnitLedger),
    privateEvidence: artifact(item.privateEvidence),
    knowledgeDispositions: artifact(item.knowledgeDispositions),
    vaultRoot: item.vaultRoot,
    privateBindingsRoot: item.privateBindingsRoot,
    receiptRoot: item.receiptRoot,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("P6_MATERIALIZATION_INPUT_INVALID");
  }
}

function parseJsonLines(text: string): unknown[] {
  if (!text.endsWith("\n") || text.trim().length === 0) {
    fail("P6_MATERIALIZATION_INPUT_INVALID");
  }
  return text.trimEnd().split("\n").map(parseJson);
}

async function readVerified(root: string, ref: ArtifactRef): Promise<string> {
  const path = containedPath(root, ref.path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P6_MATERIALIZATION_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P6_MATERIALIZATION_SYMLINK");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const text = await handle.readFile("utf8");
    if (sha256(text) !== ref.sha256) fail("P6_MATERIALIZATION_INPUT_DRIFT");
    return text;
  } catch (error) {
    if (error instanceof P6MaterializationError) throw error;
    fail("P6_MATERIALIZATION_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("P6_MATERIALIZATION_FILESYSTEM_ERROR");
}

function parseP5Assets(value: unknown, runId: string): P5ResolvedAsset[] {
  const root = record(value);
  if (root.schema !== RESOLUTION_SCHEMA || root.governanceRunId !== runId ||
      !Array.isArray(root.assets)) fail("P6_MATERIALIZATION_INPUT_INVALID");
  return root.assets as P5ResolvedAsset[];
}

function parseUnitLedger(rows: readonly unknown[]): P5UnitDisposition[] {
  return rows.map((raw) => {
    const row = record(raw);
    if (row.schema !== UNIT_LEDGER_SCHEMA || typeof row.unitId !== "string" ||
        typeof row.scopeFingerprint !== "string" || !SHA256.test(row.scopeFingerprint) ||
        !["publish_candidate", "defer", "quarantine"].includes(String(row.action)) ||
        !Array.isArray(row.sourceBindings) || !Array.isArray(row.reasonCodes) ||
        row.candidateOnly !== true) fail("P6_MATERIALIZATION_INPUT_INVALID");
    return row as unknown as P5UnitDisposition;
  });
}

function headingFor(type: P5ResolvedAsset["semanticType"]): string {
  return ({
    profile: "稳定偏好",
    task_context: "任务上下文",
    rules: "规则与约束",
    experience: "经验与结论",
    resource: "资源说明",
  } as const)[type];
}

function canonicalClaimText(value: string): string {
  const normalized = value.normalize("NFC").replace(/[ \t\n]+/gu, " ").trim();
  if (normalized.length === 0 || /\p{Cc}/u.test(normalized)) {
    fail("P6_MATERIALIZATION_CLAIM_TEXT_INVALID");
  }
  return normalized;
}

function canonicalTitleText(value: string): string {
  const normalized = value.normalize("NFC").replace(/[ \t\n]+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > 256 || /\p{Cc}/u.test(normalized)) {
    fail("P6_MATERIALIZATION_TITLE_INVALID");
  }
  return normalized;
}

function placementFor(asset: P5ResolvedAsset, canonicalTitle: string): string {
  const title = [...canonicalTitle].slice(0, 48).join("");
  switch (asset.semanticType) {
    case "profile":
      return resolveCanonicalVaultPlacement({
        kind: "memory_document", assetId: asset.assetId, title,
        semanticType: "profile", profileLayer: "project", projectId: asset.scope.projectId,
      });
    case "task_context":
      return resolveCanonicalVaultPlacement({
        kind: "memory_document", assetId: asset.assetId, title,
        semanticType: "task_context", primaryProject: asset.scope.projectId,
      });
    case "rules":
      return resolveCanonicalVaultPlacement({
        kind: "memory_document", assetId: asset.assetId, title,
        semanticType: "rules", ruleDomain: asset.scope.projectId,
      });
    case "experience":
      return resolveCanonicalVaultPlacement({
        kind: "memory_document", assetId: asset.assetId, title,
        semanticType: "experience", primaryTopic: asset.scope.projectId,
      });
    case "resource":
      return resolveCanonicalVaultPlacement({
        kind: "memory_document", assetId: asset.assetId, title,
        semanticType: "resource", primarySourceOrProject: asset.scope.projectId,
      });
  }
}

function materializeAsset(
  candidate: P5ResolvedAsset,
  evidenceByClaim: ReadonlyMap<string, readonly PrivateClaimEvidenceBinding[]>,
  resolutionHash: string,
  policyVersion: string,
  createdAt: string,
): { asset: GovernedDocumentAssetVersion; markdown: string; path: string } {
  const sectionId = `section_${sha256(candidate.assetId).slice(0, 24)}`;
  const title = canonicalTitleText(candidate.title);
  const content: CanonicalPublicDocumentContent = {
    title,
    sections: [{
      id: sectionId,
      heading: headingFor(candidate.semanticType),
      claims: candidate.claims.map((claim) => ({
        id: claim.claimId,
        text: canonicalClaimText(claim.text),
      })),
    }],
    userNotes: "",
    topics: [],
    relatedAssetIds: [...new Set(candidate.relations.map((relation) =>
      relation.targetAssetId))].sort(),
    sourceAssetIds: [],
    aliases: [],
    tags: [`mengshu/${candidate.semanticType}`],
  };
  const publicContentHash = computePublicContentHash(content);
  const claimEvidence = Object.fromEntries(candidate.claims.map((claim) => {
    const evidence = evidenceByClaim.get(claim.claimId);
    if (!evidence || evidence.length === 0) fail("P6_MATERIALIZATION_EVIDENCE_MISSING");
    return [claim.claimId, evidence.map((item) => item.evidenceId).sort()];
  }));
  const provenanceRefs = [...new Set(candidate.claims.flatMap((claim) =>
    claim.sourceBindings.map((source) => source.sourceRef)))].sort();
  const evidenceRefs = [...new Set(Object.values(claimEvidence).flat())].sort();
  const projection: GovernedDocumentProjection = {
    assetId: candidate.assetId,
    assetVersion: 1,
    claimEvidence,
    provenanceRefs,
    relationRefs: candidate.relations.map((relation) => relation.targetAssetId).sort(),
    sourceDispositionRefs: [...candidate.unitIds].sort(),
    resolutionHash,
    policyVersion,
  };
  const governanceProjectionHash = computeGovernanceProjectionHash(projection);
  const conflictCount = [...candidate.relations, ...candidate.internalClaimRelations]
    .filter((relation) => relation.type === "contradicts").length;
  const asset: GovernedDocumentAssetVersion = {
    assetId: candidate.assetId,
    assetVersion: 1,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: candidate.semanticType,
    title,
    lifecycleState: "active",
    governanceState: "current",
    scope: candidate.scope,
    scopeFingerprint: candidate.scopeFingerprint,
    governanceDescription: {
      assetId: candidate.assetId,
      assetVersion: 1,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: candidate.semanticType,
      scopeFingerprint: candidate.scopeFingerprint,
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title,
      sectionIndex: [{
        sectionId,
        heading: headingFor(candidate.semanticType),
        brief: `共 ${candidate.claims.length} 条可追溯 claim`,
      }],
      claimEvidenceCoverage: 1,
      sourceDispositionCoverage: 1,
      conflictCount,
      staleReasons: [],
      publicContentHash,
      governanceProjectionHash,
      navigationRefs: [],
    },
    content,
    publicContentHash,
    governanceProjectionHash,
    provenanceRefs,
    evidenceRefs,
    relations: candidate.relations.map((relation) => ({
      type: relation.type,
      targetAssetId: relation.targetAssetId,
    })),
    createdAt,
    updatedAt: createdAt,
  };
  validateGovernedDocumentAssetVersion(asset);
  const markdown = renderGovernedDocumentMarkdown(asset);
  const parsed = parseGovernedDocumentMarkdown(markdown);
  if (parsed.identity.assetId !== asset.assetId || parsed.identity.assetVersion !== 1 ||
      parsed.identity.scopeFingerprint !== asset.scopeFingerprint ||
      parsed.identity.publicContentHash !== asset.publicContentHash ||
      JSON.stringify(stableValue(parsed.content)) !== JSON.stringify(stableValue(asset.content))) {
    fail("P6_MATERIALIZATION_PARSE_BACK_DRIFT");
  }
  return { asset, markdown, path: placementFor(candidate, title) };
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch {
    fail("P6_MATERIALIZATION_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    fail("P6_MATERIALIZATION_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof P6MaterializationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail("P6_MATERIALIZATION_FILESYSTEM_ERROR");
    }
  }
}

function sourceMappings(
  sourceFiles: readonly SourceBinding[],
  units: readonly P5UnitDisposition[],
  typedPlan: ReturnType<typeof parseTypedMemoryBatchPlan>,
  knowledgeRows: readonly unknown[],
  evidence: readonly PrivateClaimEvidenceBinding[],
): {
  readonly source: SourceBinding;
  readonly scopeFingerprint: string;
  readonly disposition: GovernanceDisposition;
  readonly targetAssetIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reasonCode: string;
}[] {
  const evidenceBySource = new Map<string, string[]>();
  for (const item of evidence) {
    const values = evidenceBySource.get(item.sourceRef) ?? [];
    values.push(item.evidenceId);
    evidenceBySource.set(item.sourceRef, values);
  }
  const mappings = new Map<string, ReturnType<typeof sourceMappings>[number]>();
  for (const unit of units) {
    const disposition: GovernanceDisposition = unit.action === "publish_candidate"
      ? "attached_to_typed_document" : unit.action === "defer" ? "deferred" : "quarantine";
    for (const source of unit.sourceBindings) {
      mappings.set(source.sourceRef, {
        source,
        scopeFingerprint: unit.scopeFingerprint,
        disposition,
        targetAssetIds: unit.targetAssetId ? [unit.targetAssetId] : [],
        evidenceRefs: unit.targetAssetId
          ? [...new Set(evidenceBySource.get(source.sourceRef) ?? [])].sort() : [],
        reasonCode: `p5_${unit.action}`,
      });
    }
  }
  for (const unit of typedPlan.excludedResolutions) {
    for (const source of unit.sources) {
      if (mappings.has(source.sourceRef)) fail("P6_MATERIALIZATION_SOURCE_DUPLICATE");
      const disposition: GovernanceDisposition = unit.disposition === "supersede"
        ? "superseded" : unit.disposition;
      mappings.set(source.sourceRef, {
        source,
        scopeFingerprint: unit.scopeFingerprint ?? sha256(
          `mengshu.unscoped-quarantine/v1\0${unit.unitId}`,
        ),
        disposition,
        targetAssetIds: [],
        evidenceRefs: [],
        reasonCode: `p4_${unit.disposition}`,
      });
    }
  }
  for (const raw of knowledgeRows) {
    const row = record(raw);
    if (row.schema !== KNOWLEDGE_DISPOSITION_SCHEMA || typeof row.sourceRef !== "string" ||
        typeof row.sourceHash !== "string" || !SHA256.test(row.sourceHash) ||
        typeof row.scopeFingerprint !== "string" || !SHA256.test(row.scopeFingerprint) ||
        row.disposition !== "lookup_only" && row.disposition !== "quarantine") {
      fail("P6_MATERIALIZATION_KNOWLEDGE_INVALID");
    }
    if (mappings.has(row.sourceRef)) fail("P6_MATERIALIZATION_SOURCE_DUPLICATE");
    mappings.set(row.sourceRef, {
      source: { sourceRef: row.sourceRef, sourceHash: row.sourceHash },
      scopeFingerprint: row.scopeFingerprint,
      disposition: row.disposition,
      targetAssetIds: [],
      evidenceRefs: [],
      reasonCode: `p3_${row.disposition}`,
    });
  }
  if (mappings.size !== sourceFiles.length || sourceFiles.some((source) => {
    const mapping = mappings.get(source.sourceRef);
    return !mapping || mapping.source.sourceHash !== source.sourceHash;
  })) fail("P6_MATERIALIZATION_SOURCE_COVERAGE_INVALID");
  return [...mappings.values()].sort((left, right) =>
    left.source.sourceRef.localeCompare(right.source.sourceRef));
}

async function materialize(root: string, input: P6Input): Promise<Record<string, unknown>> {
  const texts = await Promise.all([
    readVerified(root, input.sourceManifest),
    readVerified(root, input.typedMemoryPlan),
    readVerified(root, input.p5Resolution),
    readVerified(root, input.p5UnitLedger),
    readVerified(root, input.privateEvidence),
    readVerified(root, input.knowledgeDispositions),
  ]);
  const sourceManifest = record(parseJson(texts[0]!));
  if (sourceManifest.schema !== SOURCE_MANIFEST_SCHEMA ||
      sourceManifest.migrationRunId !== input.governanceRunId ||
      typeof sourceManifest.snapshotSha256 !== "string" ||
      !SHA256.test(sourceManifest.snapshotSha256) || !Array.isArray(sourceManifest.files)) {
    fail("P6_MATERIALIZATION_SOURCE_MANIFEST_INVALID");
  }
  const sourceFiles = sourceManifest.files.map((raw) => {
    const file = record(raw);
    if (typeof file.sourceRef !== "string" || typeof file.sourceHash !== "string" ||
        !SHA256.test(file.sourceHash)) fail("P6_MATERIALIZATION_SOURCE_MANIFEST_INVALID");
    return { sourceRef: file.sourceRef, sourceHash: file.sourceHash };
  }).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  const typedPlan = parseTypedMemoryBatchPlan(texts[1]!);
  const candidates = parseP5Assets(parseJson(texts[2]!), input.governanceRunId);
  const units = parseUnitLedger(parseJsonLines(texts[3]!));
  const privateEvidence = parsePrivateEvidenceBindingsManifest(texts[4]!);
  const knowledgeRows = parseJsonLines(texts[5]!);
  if (privateEvidence.governanceRunId !== input.governanceRunId ||
      candidates.length !== privateEvidence.summary.assetCount ||
      units.length !== typedPlan.eligibleUnits.length || sourceFiles.length !== 49_465) {
    fail("P6_MATERIALIZATION_INPUT_DRIFT");
  }
  const evidenceByClaim = new Map<string, PrivateClaimEvidenceBinding[]>();
  for (const binding of privateEvidence.bindings) {
    const rows = evidenceByClaim.get(binding.claimId) ?? [];
    rows.push(binding);
    evidenceByClaim.set(binding.claimId, rows);
  }
  const documents = candidates.map((candidate) => materializeAsset(
    candidate,
    evidenceByClaim,
    input.p5Resolution.sha256,
    input.policyVersion,
    input.createdAt,
  )).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(documents.map((document) => document.path.toLowerCase())).size !== documents.length) {
    fail("P6_MATERIALIZATION_PATH_DUPLICATE");
  }
  const mappings = sourceMappings(sourceFiles, units, typedPlan, knowledgeRows,
    privateEvidence.bindings);
  const canonicalManifest = createGovernedCanonicalManifest({
    governanceRunId: input.governanceRunId,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    sourceSnapshotSha256: sourceManifest.snapshotSha256,
    expectedSources: sourceFiles,
    assets: documents.map((document) => ({
      asset: document.asset,
      canonicalPath: document.path,
      markdownSha256: sha256(document.markdown),
    })),
    sourceMappings: mappings,
  });
  const canonicalManifestText = serializeGovernedCanonicalManifest(canonicalManifest);
  const assetRecordsText = `${documents.map((document) => canonicalLine(document.asset)).join("\n")}\n`;
  const syncText = `${documents.map((document) => canonicalLine({
    assetId: document.asset.assetId,
    assetVersion: 1,
    canonicalPath: document.path,
    publicContentHash: document.asset.publicContentHash,
    governanceProjectionHash: document.asset.governanceProjectionHash,
    markdownSha256: sha256(document.markdown),
    state: "complete",
  })).join("\n")}\n`;

  const vaultRoot = containedPath(root, input.vaultRoot);
  const privateRoot = containedPath(root, input.privateBindingsRoot);
  const receiptRoot = containedPath(root, input.receiptRoot);
  await Promise.all([assertAbsent(vaultRoot), assertAbsent(privateRoot), assertAbsent(receiptRoot)]);
  await Promise.all([
    mkdir(vaultRoot, { recursive: true, mode: 0o700 }),
    mkdir(privateRoot, { recursive: true, mode: 0o700 }),
    mkdir(receiptRoot, { recursive: true, mode: 0o700 }),
  ]);
  const directories = new Set(documents.map((document) => dirname(document.path)));
  directories.add(".mengshu");
  await Promise.all([...directories].map((directory) =>
    mkdir(resolve(vaultRoot, directory), { recursive: true, mode: 0o700 })));
  await Promise.all(documents.map((document) =>
    writeExclusive(resolve(vaultRoot, document.path), document.markdown)));
  await Promise.all([
    writeExclusive(resolve(vaultRoot, ".mengshu/governance-manifest.json"), canonicalManifestText),
    writeExclusive(resolve(vaultRoot, ".mengshu/asset-sync.jsonl"), syncText),
    writeExclusive(resolve(privateRoot, "private-evidence-bindings.json"), texts[4]!),
    writeExclusive(resolve(privateRoot, "governed-asset-records.jsonl"), assetRecordsText),
  ]);

  const receipt = {
    schema: RECEIPT_SCHEMA,
    governanceRunId: input.governanceRunId,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    inputs: {
      sourceManifestSha256: input.sourceManifest.sha256,
      p5ResolutionSha256: input.p5Resolution.sha256,
      p5UnitLedgerSha256: input.p5UnitLedger.sha256,
      privateEvidenceSha256: input.privateEvidence.sha256,
      knowledgeDispositionsSha256: input.knowledgeDispositions.sha256,
    },
    outputs: {
      canonicalManifest: {
        path: `${input.vaultRoot}/.mengshu/governance-manifest.json`,
        sha256: sha256(canonicalManifestText),
      },
      assetSync: {
        path: `${input.vaultRoot}/.mengshu/asset-sync.jsonl`, sha256: sha256(syncText),
      },
      assetRecords: {
        path: `${input.privateBindingsRoot}/governed-asset-records.jsonl`,
        sha256: sha256(assetRecordsText),
      },
      privateEvidence: {
        path: `${input.privateBindingsRoot}/private-evidence-bindings.json`,
        sha256: input.privateEvidence.sha256,
      },
    },
    summary: {
      canonicalAssetCount: documents.length,
      markdownFileCount: documents.length,
      sourceMappingCount: mappings.length,
      attachedSourceCount: mappings.filter((mapping) =>
        mapping.disposition === "attached_to_typed_document").length,
      lookupOnlySourceCount: mappings.filter((mapping) =>
        mapping.disposition === "lookup_only").length,
      deferredSourceCount: mappings.filter((mapping) =>
        mapping.disposition === "deferred").length,
      archivedSourceCount: mappings.filter((mapping) =>
        mapping.disposition === "archive_stale").length,
      quarantinedSourceCount: mappings.filter((mapping) =>
        mapping.disposition === "quarantine").length,
      whitespaceNormalizedClaimCount: candidates.reduce((sum, candidate) => sum +
        candidate.claims.filter((claim) => canonicalClaimText(claim.text) !== claim.text).length, 0),
      parseBackDrift: 0,
      duplicateAssetId: 0,
      duplicateCanonicalPath: 0,
      sourceCoverage: 1,
      claimEvidenceCoverage: 1,
    },
    guards: {
      formalMarkdownWritten: true,
      stagingOnly: true,
      publicEvidenceProjectionAllowed: false,
      productionVaultPublished: false,
      postgresTouched: false,
    },
  };
  const receiptText = canonicalJson(receipt);
  await writeExclusive(resolve(receiptRoot, "receipt.json"), receiptText);
  return {
    receipt: `${input.receiptRoot}/receipt.json`,
    receiptSha256: sha256(receiptText),
    outputs: receipt.outputs,
    summary: receipt.summary,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 6 || argv[0] !== "--migration-root" || argv[2] !== "--input" ||
      argv[4] !== "--input-sha256") fail("P6_MATERIALIZATION_INVALID_ARGUMENT");
  const root = resolve(argv[1]!);
  if (!isAbsolute(argv[1]!) || root !== argv[1]) fail("P6_MATERIALIZATION_INVALID_ARGUMENT");
  const inputRef = { path: argv[3]!, sha256: argv[5]! };
  const input = parseInput(parseJson(await readVerified(root, inputRef)));
  process.stdout.write(`${JSON.stringify(await materialize(root, input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P6MaterializationError
      ? error.code
      : error instanceof Error
        ? `P6_MATERIALIZATION_CONTRACT_ERROR:${error.name}:${error.message}`
        : "P6_MATERIALIZATION_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
