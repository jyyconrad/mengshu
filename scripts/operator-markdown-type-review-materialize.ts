import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import type {
  MemoryCurationBatch,
  MemoryCurationBatchPlan,
  MemoryCurationUnit,
} from "../packages/core/src/db/migrations/markdown-curation-batch-planner.js";
import {
  CURATION_ARTIFACT_BUNDLE_SCHEMA,
  CURATION_BATCH_RECEIPT_SCHEMA,
  CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
  CURATION_UNIT_DECISION_SCHEMA,
  computeCurationArtifactListHash,
  validateCurationArtifactBundle,
  type CurationArtifactBundle,
  type CurationDocumentProposalRef,
  type CurationUnitDecision,
  type SourceBinding,
} from "../packages/core/src/documents/curation-artifacts.js";
import type { MemorySemanticType } from "../packages/core/src/domain/types.js";
import { runMarkdownCurationBatchValidation } from "./operator-markdown-curation-batch-validate.js";

const DRAFT_SCHEMA = "mengshu.type-review-agent-draft/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const DISPOSITION_CANDIDATES = new Set([
  "canonical_keep", "merge_exact", "merge_semantic", "supersede", "archive_stale",
  "lookup_only", "quarantine", "distinct_keep",
]);

export interface TypeReviewAgentDecisionDraft {
  readonly unitId: string;
  readonly proposedSemanticType: MemorySemanticType;
  readonly dispositionCandidate: string;
  readonly confidence: number;
  readonly conflict: boolean;
  readonly reviewRequired: true;
  readonly title: string;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly evidenceNotes: readonly string[];
}

export interface TypeReviewAgentDraft {
  readonly schema: typeof DRAFT_SCHEMA;
  readonly batchId: string;
  readonly reviewer: string;
  readonly createdAt: string;
  readonly candidateOnly: true;
  readonly decisions: readonly TypeReviewAgentDecisionDraft[];
}

export interface RunTypeReviewMaterializeInput {
  readonly containmentRoot: string;
  readonly planPath: string;
  readonly planFileSha256: string;
  readonly batchId: string;
  readonly mode: "draft" | "quarantine";
  readonly draftPath?: string;
  readonly outputDirectory: string;
  readonly createdAt: string;
}

export interface TypeReviewMaterializeResult {
  readonly status: "accepted";
  readonly mode: "draft" | "quarantine";
  readonly batchId: string;
  readonly outputDirectory: string;
  readonly units: number;
  readonly sources: number;
  readonly proposals: number;
  readonly artifactSetSha256: string;
}

function fail(message: string): never {
  throw new Error(`TYPE_REVIEW_MATERIALIZE_INVALID: ${message}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape`);
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail(`${label} keys`);
  }
  return value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
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
  if (!plainRecord(value) || seen.has(value)) fail("non-plain value");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("unsupported value");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalJsonl(values: readonly unknown[]): string {
  return values.length === 0
    ? ""
    : `${values.map((value) => JSON.stringify(stableValue(value))).join("\n")}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail(`${label} path`);
  return value;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} timestamp`);
  return value;
}

function sourceBindings(unit: MemoryCurationUnit): readonly SourceBinding[] {
  if (unit.files.length !== unit.sourceCount) fail("unit file coverage");
  const refs = new Set<string>();
  return Object.freeze(unit.files.map((file) => {
    if (!SAFE_ID.test(file.sourceRef) || !SHA256.test(file.sourceHash) || refs.has(file.sourceRef)) {
      fail("unit source binding");
    }
    refs.add(file.sourceRef);
    return Object.freeze({ sourceRef: file.sourceRef, sourceHash: file.sourceHash });
  }));
}

function parseDraft(value: unknown, batch: MemoryCurationBatch): TypeReviewAgentDraft {
  const draft = exactKeys(value, [
    "schema", "batchId", "reviewer", "createdAt", "candidateOnly", "decisions",
  ], "draft");
  if (draft.schema !== DRAFT_SCHEMA || draft.batchId !== batch.batchId ||
      draft.candidateOnly !== true || typeof draft.reviewer !== "string" ||
      !SAFE_ID.test(draft.reviewer) || !Array.isArray(draft.decisions) ||
      nodeUtilTypes.isProxy(draft.decisions)) fail("draft identity");
  const decisions = draft.decisions.map((raw, index): TypeReviewAgentDecisionDraft => {
    const item = exactKeys(raw, [
      "unitId", "proposedSemanticType", "dispositionCandidate", "confidence", "conflict",
      "reviewRequired", "title", "summary", "reasonCodes", "evidenceNotes",
    ], `decision[${index}]`);
    if (typeof item.unitId !== "string" || !SAFE_ID.test(item.unitId) ||
        typeof item.proposedSemanticType !== "string" ||
        !SEMANTIC_TYPES.has(item.proposedSemanticType as MemorySemanticType) ||
        typeof item.dispositionCandidate !== "string" ||
        !DISPOSITION_CANDIDATES.has(item.dispositionCandidate) ||
        typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
        item.confidence < 0 || item.confidence > 1 || typeof item.conflict !== "boolean" ||
        item.reviewRequired !== true || typeof item.title !== "string" ||
        item.title.trim() !== item.title || item.title.length === 0 || /[\p{Cc}\r\n]/u.test(item.title) ||
        typeof item.summary !== "string" || item.summary.trim() !== item.summary ||
        item.summary.length === 0 || !Array.isArray(item.reasonCodes) ||
        !Array.isArray(item.evidenceNotes)) fail("draft decision value");
    const reasonCodes = item.reasonCodes.map((reason) => {
      if (typeof reason !== "string" || !SAFE_REASON.test(reason)) fail("draft reason code");
      return reason;
    });
    const evidenceNotes = item.evidenceNotes.map((note) => {
      if (typeof note !== "string" || note.trim() !== note || note.length === 0 ||
          note.length > 2_000 || /[\p{Cc}\r\n]/u.test(note)) fail("draft evidence note");
      return note;
    });
    if (reasonCodes.length === 0 || evidenceNotes.length === 0 ||
        new Set(reasonCodes).size !== reasonCodes.length) fail("draft decision evidence");
    return Object.freeze({
      unitId: item.unitId,
      proposedSemanticType: item.proposedSemanticType as MemorySemanticType,
      dispositionCandidate: item.dispositionCandidate,
      confidence: item.confidence,
      conflict: item.conflict,
      reviewRequired: true,
      title: item.title,
      summary: item.summary,
      reasonCodes: Object.freeze(reasonCodes),
      evidenceNotes: Object.freeze(evidenceNotes),
    });
  });
  if (decisions.length !== batch.unitIds.length || new Set(decisions.map((item) => item.unitId)).size !==
      decisions.length || batch.unitIds.some((unitId) => !decisions.some((item) => item.unitId === unitId))) {
    fail("draft unit coverage");
  }
  return Object.freeze({
    schema: DRAFT_SCHEMA,
    batchId: batch.batchId,
    reviewer: draft.reviewer,
    createdAt: parseIso(draft.createdAt, "draft"),
    candidateOnly: true,
    decisions: Object.freeze(decisions),
  });
}

function proposalId(plan: MemoryCurationBatchPlan, batchId: string, decision: TypeReviewAgentDecisionDraft): string {
  return `proposal_${sha256([
    "mengshu.type-review-proposal/v1", plan.planSha256, batchId, decision.unitId,
    decision.proposedSemanticType,
  ].join("\0")).slice(0, 32)}`;
}

function proposalMarkdown(
  decision: TypeReviewAgentDecisionDraft,
  unit: MemoryCurationUnit,
): string {
  return [
    `# ${decision.title}`,
    "",
    `- Proposed semantic type: ${decision.proposedSemanticType}`,
    `- Candidate disposition: ${decision.dispositionCandidate}`,
    `- Confidence: ${decision.confidence.toFixed(3)}`,
    `- Source count: ${unit.sourceCount}`,
    `- Conflict observed: ${decision.conflict ? "yes" : "no"}`,
    "",
    "## Type rationale",
    "",
    decision.summary,
    "",
    "## Evidence cues",
    "",
    ...decision.evidenceNotes.map((note) => `- ${note}`),
    "",
    "## Review reasons",
    "",
    ...decision.reasonCodes.map((reason) => `- ${reason}`),
    "",
    "> Candidate proposal only. This file is not a canonical asset.",
    "",
  ].join("\n");
}

function buildBundle(
  plan: MemoryCurationBatchPlan,
  batch: MemoryCurationBatch,
  draft: TypeReviewAgentDraft | undefined,
  createdAt: string,
): { bundle: CurationArtifactBundle; markdown: ReadonlyMap<string, string> } {
  const unitById = new Map(plan.units.map((unit) => [unit.unitId, unit] as const));
  const decisionById = new Map(draft?.decisions.map((decision) => [decision.unitId, decision] as const));
  const markdown = new Map<string, string>();
  const documentProposals: CurationDocumentProposalRef[] = [];
  const unitDecisions: CurationUnitDecision[] = batch.unitIds.map((unitId) => {
    const unit = unitById.get(unitId);
    if (!unit) fail("plan unit identity");
    const sources = sourceBindings(unit);
    if (!draft) {
      return Object.freeze({
        schema: CURATION_UNIT_DECISION_SCHEMA,
        unitId,
        scopeFingerprint: unit.scopeFingerprint ?? null,
        sources,
        proposedSemanticType: null,
        disposition: "exclude",
        documentProposalIds: Object.freeze([]),
        reasonCodes: Object.freeze(["legacy_quarantine"]),
        candidateOnly: true,
      });
    }
    if (!unit.scopeFingerprint) fail("draft unit scope is required");
    const decision = decisionById.get(unitId);
    if (!decision) fail("draft unit missing");
    const id = proposalId(plan, batch.batchId, decision);
    const path = `document-proposals/${id}.md`;
    const body = proposalMarkdown(decision, unit);
    markdown.set(path, body);
    documentProposals.push(Object.freeze({
      schema: CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
      proposalId: id,
      unitIds: Object.freeze([unitId]),
      scopeFingerprint: unit.scopeFingerprint,
      semanticType: decision.proposedSemanticType,
      relativePath: path,
      markdownSha256: sha256(body),
      sources,
      candidateOnly: true,
    }));
    return Object.freeze({
      schema: CURATION_UNIT_DECISION_SCHEMA,
      unitId,
      scopeFingerprint: unit.scopeFingerprint,
      sources,
      proposedSemanticType: decision.proposedSemanticType,
      disposition: "needs_review",
      documentProposalIds: Object.freeze([id]),
      reasonCodes: Object.freeze([
        ...decision.reasonCodes,
        `candidate_disposition_${decision.dispositionCandidate}`,
        decision.conflict ? "content_conflict_observed" : "content_conflict_not_observed",
      ]),
      candidateOnly: true,
    });
  });
  const relationProposals = Object.freeze([]);
  const reviewVerdicts = Object.freeze([]);
  const receipt = Object.freeze({
    schema: CURATION_BATCH_RECEIPT_SCHEMA,
    batchId: batch.batchId,
    planSha256: plan.planSha256,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    sourceManifestSha256: plan.sourceManifestSha256,
    preprocessedManifestSha256: plan.preprocessedManifestSha256,
    inventorySha256: plan.inventorySha256,
    unitCount: batch.unitIds.length,
    sourceCount: batch.sourceCount,
    sectionHashes: Object.freeze({
      unitDecisions: computeCurationArtifactListHash("unit-decisions", unitDecisions),
      documentProposals: computeCurationArtifactListHash("document-proposals", documentProposals),
      relationProposals: computeCurationArtifactListHash("relation-proposals", relationProposals),
      reviewVerdicts: computeCurationArtifactListHash("review-verdicts", reviewVerdicts),
    }),
    candidateOnly: true,
    canonicalTargetsSelected: false,
    formalAssetsWritten: false,
    treeArtifactsWritten: false,
    postgresTouched: false,
    createdAt,
  });
  const bundle = validateCurationArtifactBundle({
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt,
    unitDecisions,
    documentProposals,
    relationProposals,
    reviewVerdicts,
  }, { plan, batchId: batch.batchId });
  return { bundle, markdown };
}

async function durableWrite(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function readPlan(path: string, expectedSha256: string): Promise<MemoryCurationBatchPlan> {
  const content = await readFile(path);
  if (sha256(content) !== expectedSha256) fail("plan file hash");
  const text = content.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("plan JSON");
  }
  if (!plainRecord(value) || value.schema !== "mengshu.memory-curation-batch-plan/v1" ||
      !Array.isArray(value.units) || !Array.isArray(value.batches) || !SHA256.test(String(value.planSha256)) ||
      canonicalJson(value) !== text) fail("plan contract");
  return value as unknown as MemoryCurationBatchPlan;
}

export async function runTypeReviewMaterialize(
  input: RunTypeReviewMaterializeInput,
): Promise<TypeReviewMaterializeResult> {
  if (!plainRecord(input) || !SHA256.test(input.planFileSha256) || !SAFE_ID.test(input.batchId) ||
      !["draft", "quarantine"].includes(input.mode)) fail("input shape");
  const root = absolutePath(input.containmentRoot, "containment root");
  const planPath = absolutePath(input.planPath, "plan");
  const outputDirectory = absolutePath(input.outputDirectory, "output");
  const createdAt = parseIso(input.createdAt, "materialize");
  const draftPath = input.draftPath === undefined ? undefined : absolutePath(input.draftPath, "draft");
  if (!strictDescendant(root, planPath) || !strictDescendant(root, outputDirectory) ||
      draftPath !== undefined && !strictDescendant(root, draftPath) ||
      !await directory(root) || !await regularFile(planPath) ||
      draftPath !== undefined && !await regularFile(draftPath) ||
      !await directory(dirname(outputDirectory))) fail("path containment or input file");
  if ((input.mode === "draft") !== (draftPath !== undefined)) fail("mode/draft contract");
  const plan = await readPlan(planPath, input.planFileSha256);
  const batch = plan.batches.find((candidate) => candidate.batchId === input.batchId);
  if (!batch || input.mode === "quarantine" && batch.cohort !== "quarantine" ||
      input.mode === "draft" && batch.mode !== "type_review") fail("batch mode");
  let draft: TypeReviewAgentDraft | undefined;
  if (draftPath) {
    const content = await readFile(draftPath, "utf8");
    try {
      draft = parseDraft(JSON.parse(content), batch);
    } catch (error) {
      if (error instanceof SyntaxError) fail("draft JSON");
      throw error;
    }
  }
  const built = buildBundle(plan, batch, draft, createdAt);
  await mkdir(outputDirectory, { mode: 0o700 });
  const proposalDirectory = resolve(outputDirectory, "document-proposals");
  await mkdir(proposalDirectory, { mode: 0o700 });
  await durableWrite(resolve(outputDirectory, "batch-receipt.json"), canonicalJson(built.bundle.receipt));
  await durableWrite(resolve(outputDirectory, "unit-decisions.jsonl"),
    canonicalJsonl(built.bundle.unitDecisions));
  await durableWrite(resolve(proposalDirectory, "manifest.jsonl"),
    canonicalJsonl(built.bundle.documentProposals));
  for (const [path, content] of built.markdown) {
    await durableWrite(resolve(outputDirectory, path), content);
  }
  await durableWrite(resolve(outputDirectory, "relation-proposals.jsonl"), "");
  await durableWrite(resolve(outputDirectory, "review-verdicts.jsonl"), "");
  const validation = await runMarkdownCurationBatchValidation({
    containmentRoot: root,
    planPath,
    planFileSha256: input.planFileSha256,
    batchId: input.batchId,
    attemptDirectory: outputDirectory,
  });
  return Object.freeze({
    status: "accepted",
    mode: input.mode,
    batchId: input.batchId,
    outputDirectory,
    units: validation.counts.units,
    sources: validation.counts.sources,
    proposals: validation.counts.documentProposals,
    artifactSetSha256: validation.artifactSetSha256,
  });
}

function args(argv: readonly string[]): RunTypeReviewMaterializeInput {
  if (argv.length % 2 !== 0) fail("CLI arguments");
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || options.has(key)) fail("CLI arguments");
    options.set(key, value);
  }
  const mode = options.get("--mode");
  const expected = [
    "--containment-root", "--plan", "--plan-file-sha256", "--batch-id", "--mode",
    "--output-dir", "--created-at",
  ];
  if (mode === "draft") expected.push("--draft");
  if ((mode !== "draft" && mode !== "quarantine") || options.size !== expected.length ||
      expected.some((key) => !options.has(key))) fail("CLI arguments");
  return {
    containmentRoot: options.get("--containment-root")!,
    planPath: options.get("--plan")!,
    planFileSha256: options.get("--plan-file-sha256")!,
    batchId: options.get("--batch-id")!,
    mode,
    ...(mode === "draft" ? { draftPath: options.get("--draft")! } : {}),
    outputDirectory: options.get("--output-dir")!,
    createdAt: options.get("--created-at")!,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTypeReviewMaterialize(args(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: "TYPE_REVIEW_MATERIALIZE_FAILED",
      message: error instanceof Error ? error.message : "Materialization failed",
    })}\n`);
    process.exitCode = 1;
  });
}
