import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import {
  parseKnowledgeResourcePlan,
  type KnowledgeResourceCohort,
  type KnowledgeResourceCurationBatch,
  type KnowledgeResourceCurationPlan,
  type KnowledgeResourceCurationUnit,
  type KnowledgeResourceSourceBinding,
} from "../packages/core/src/db/migrations/knowledge-resource-curation.js";

const REVIEW_SCHEMA = "mengshu.knowledge-resource-review-draft/v1" as const;
const ARBITRATION_SCHEMA = "mengshu.knowledge-resource-arbitration/v1" as const;
const UNIT_DECISION_SCHEMA = "mengshu.knowledge-resource-unit-decision/v1" as const;
const RESOURCE_BINDING_SCHEMA = "mengshu.knowledge-resource-binding/v1" as const;
const SOURCE_DISPOSITION_SCHEMA = "mengshu.knowledge-source-disposition/v1" as const;
const SUMMARY_SCHEMA = "mengshu.knowledge-resource-resolution-summary/v1" as const;
const RECEIPT_SCHEMA = "mengshu.knowledge-resource-resolution-receipt/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const REVIEW_AGENTS = ["agent-a", "agent-b", "agent-c"] as const;
const COHORTS = new Set<KnowledgeResourceCohort>([
  "quarantine", "snapshot_document", "strong_locator", "low_signal_resource",
  "namespace_hint_only",
]);
const LOGICAL_DISPOSITIONS = new Set([
  "snapshot_document", "locator_resource", "distinct_chunk",
]);
const REVISION_KINDS = new Set(["snapshot_chunks", "unversioned"]);

export interface RunMarkdownKnowledgeResourceResolutionInput {
  readonly containmentRoot: string;
  readonly planPath: string;
  readonly planFileSha256: string;
  readonly reviewRoot: string;
  readonly arbitrationPath: string;
  readonly arbitrationFileSha256: string;
  readonly outputDirectory: string;
  readonly createdAt: string;
}

export interface MarkdownKnowledgeResourceResolutionResult {
  readonly status: "accepted";
  readonly outputDirectory: string;
  readonly units: number;
  readonly sources: number;
  readonly acceptedReviews: number;
  readonly arbitrated: number;
  readonly unresolved: 0;
  readonly coverage: 1;
  readonly quarantineSources: number;
  readonly eligibleSources: number;
  readonly outputHashes: Readonly<Record<string, string>>;
  readonly receiptSha256: string;
}

type ReviewVerdict = "accept" | "needs_review";
type LogicalSourceDisposition = "snapshot_document" | "locator_resource" | "distinct_chunk";
type RevisionKind = "snapshot_chunks" | "unversioned";
type FinalDisposition = "lookup_only" | "quarantine";

interface DecisionFields {
  readonly unitId: string;
  readonly scopeFingerprint: string;
  readonly sources: readonly KnowledgeResourceSourceBinding[];
  readonly cohort: KnowledgeResourceCohort;
  readonly logicalSourceDisposition: LogicalSourceDisposition;
  readonly revisionKind: RevisionKind;
  readonly disposition: FinalDisposition;
  readonly confidence: number;
  readonly conflict: boolean;
  readonly reasonCodes: readonly string[];
}

interface ReviewDecision extends DecisionFields {
  readonly verdict: ReviewVerdict;
  readonly notes: readonly string[];
}

interface ReviewDraft {
  readonly batchId: string;
  readonly reviewer: string;
  readonly createdAt: string;
  readonly decisions: readonly ReviewDecision[];
}

interface ArbitrationDraft {
  readonly createdAt: string;
  readonly decisions: readonly DecisionFields[];
}

interface ReviewFileHash {
  readonly agent: string;
  readonly relativePath: string;
  readonly batchId: string;
  readonly fileSha256: string;
}

interface FinalUnitDecision {
  readonly schema: typeof UNIT_DECISION_SCHEMA;
  readonly unitId: string;
  readonly batchId: string;
  readonly sequence: number;
  readonly scopeFingerprint: string;
  readonly cohort: KnowledgeResourceCohort;
  readonly disposition: FinalDisposition;
  readonly logicalSourceDisposition: LogicalSourceDisposition;
  readonly revisionKind: RevisionKind;
  readonly confidence: number;
  readonly conflict: boolean;
  readonly resourceIdentity: string;
  readonly resolutionBasis: "quarantine" | "deterministic" | "accepted_review" | "arbitration";
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: false;
}

function fail(message: string): never {
  throw new Error(`MARKDOWN_KNOWLEDGE_RESOURCE_RESOLUTION_INVALID: ${message}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape or proxy`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) fail(`${label} exact keys`);
  return value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("canonical proxy or cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("canonical invalid object or cycle");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key !== key.normalize("NFC") || item === undefined || typeof item === "function" ||
        typeof item === "symbol" || typeof item === "bigint") fail("canonical invalid value");
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

function parseCanonicalJson(text: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${label} JSON`);
  }
  if (canonicalJson(value) !== text) fail(`${label} canonical JSON`);
  return value;
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

function confidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} confidence`);
  }
  return value;
}

function reasonCodes(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.some((item) => typeof item !== "string" || !SAFE_REASON.test(item)) ||
      new Set(value).size !== value.length) fail(`${label} reason codes`);
  return Object.freeze([...value] as string[]);
}

function notes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.some((item) => typeof item !== "string" || item !== item.trim() ||
        item.length === 0 || /[\p{Cc}\r\n]/u.test(item))) fail("review notes");
  return Object.freeze([...value] as string[]);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail(`${label} absolute path`);
  }
  return value;
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function assertContainedPath(
  root: string,
  candidate: string,
  kind: "file" | "directory",
): Promise<void> {
  if (!strictDescendant(root, candidate)) fail("path containment escape");
  const segments = relative(root, candidate).split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!);
    const info = await pathInfo(current);
    if (!info) fail("contained path missing");
    if (info.isSymbolicLink()) fail("symlink input path");
    if (index < segments.length - 1 && !info.isDirectory()) fail("input path ancestor");
    if (index === segments.length - 1 &&
        (kind === "file" ? !info.isFile() : !info.isDirectory())) fail("input path kind");
  }
}

function sourceBindings(value: unknown, label: string): readonly KnowledgeResourceSourceBinding[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) {
    fail(`${label} sources`);
  }
  const seen = new Set<string>();
  const sources = value.map((raw, index) => {
    const item = exactKeys(raw, ["sourceRef", "sourceHash"], `${label} source[${index}]`);
    const sourceRef = text(item.sourceRef, `${label} source ref`);
    const sourceHash = hash(item.sourceHash, `${label} source`);
    if (seen.has(sourceRef)) fail(`${label} duplicate source`);
    seen.add(sourceRef);
    return Object.freeze({ sourceRef, sourceHash });
  });
  return Object.freeze(sources);
}

function parseDecision(value: unknown, arbitration: boolean, label: string): DecisionFields | ReviewDecision {
  const commonKeys = [
    "unitId", "scopeFingerprint", "sources", "cohort", "logicalSourceDisposition",
    "revisionKind", "disposition", "confidence", "conflict", "reasonCodes",
  ];
  const item = exactKeys(
    value,
    arbitration ? commonKeys : [...commonKeys, "verdict", "notes"],
    label,
  );
  const cohort = item.cohort;
  if (typeof cohort !== "string" || !COHORTS.has(cohort as KnowledgeResourceCohort)) {
    fail(`${label} cohort enum`);
  }
  const logical = item.logicalSourceDisposition;
  const revision = item.revisionKind;
  if (typeof logical !== "string" || !LOGICAL_DISPOSITIONS.has(logical) ||
      typeof revision !== "string" || !REVISION_KINDS.has(revision)) {
    fail(`${label} enum`);
  }
  const disposition = item.disposition;
  if (disposition !== "lookup_only" && (!arbitration || disposition !== "quarantine")) {
    fail(`${label} disposition enum`);
  }
  if (typeof item.conflict !== "boolean") fail(`${label} conflict`);
  const fields: DecisionFields = Object.freeze({
    unitId: hash(item.unitId, `${label} unit`),
    scopeFingerprint: hash(item.scopeFingerprint, `${label} scope`),
    sources: sourceBindings(item.sources, label),
    cohort: cohort as KnowledgeResourceCohort,
    logicalSourceDisposition: logical as LogicalSourceDisposition,
    revisionKind: revision as RevisionKind,
    disposition: disposition as FinalDisposition,
    confidence: confidence(item.confidence, label),
    conflict: item.conflict,
    reasonCodes: reasonCodes(item.reasonCodes, label),
  });
  if (arbitration) return fields;
  if (item.verdict !== "accept" && item.verdict !== "needs_review") {
    fail(`${label} verdict enum`);
  }
  return Object.freeze({
    ...fields,
    verdict: item.verdict,
    notes: notes(item.notes),
  }) as ReviewDecision;
}

function parseReviewDraft(
  value: unknown,
  planFileSha256: string,
  plan: KnowledgeResourceCurationPlan,
): ReviewDraft {
  const root = exactKeys(value, [
    "schema", "planFileSha256", "semanticPlanSha256", "batchId", "reviewer", "createdAt",
    "candidateOnly", "decisions",
  ], "review draft");
  if (root.schema !== REVIEW_SCHEMA || root.candidateOnly !== true ||
      root.planFileSha256 !== planFileSha256 ||
      root.semanticPlanSha256 !== plan.semanticPlanSha256 ||
      !Array.isArray(root.decisions) || nodeUtilTypes.isProxy(root.decisions)) {
    fail("review draft plan hash or identity drift");
  }
  const decisions = root.decisions.map((decision, index) =>
    parseDecision(decision, false, `review decision[${index}]`) as ReviewDecision);
  if (new Set(decisions.map((decision) => decision.unitId)).size !== decisions.length) {
    fail("review duplicate unit coverage");
  }
  return Object.freeze({
    batchId: hash(root.batchId, "review batch"),
    reviewer: text(root.reviewer, "reviewer"),
    createdAt: iso(root.createdAt, "review"),
    decisions: Object.freeze(decisions),
  });
}

function parseArbitrationDraft(
  value: unknown,
  planFileSha256: string,
  plan: KnowledgeResourceCurationPlan,
): ArbitrationDraft {
  const root = exactKeys(value, [
    "schema", "planFileSha256", "semanticPlanSha256", "createdAt", "candidateOnly",
    "decisions",
  ], "arbitration draft");
  if (root.schema !== ARBITRATION_SCHEMA || root.candidateOnly !== true ||
      root.planFileSha256 !== planFileSha256 ||
      root.semanticPlanSha256 !== plan.semanticPlanSha256 ||
      !Array.isArray(root.decisions) || nodeUtilTypes.isProxy(root.decisions)) {
    fail("arbitration plan hash or identity drift");
  }
  const decisions = root.decisions.map((decision, index) =>
    parseDecision(decision, true, `arbitration decision[${index}]`) as DecisionFields);
  if (new Set(decisions.map((decision) => decision.unitId)).size !== decisions.length) {
    fail("arbitration duplicate unit coverage");
  }
  return Object.freeze({
    createdAt: iso(root.createdAt, "arbitration"),
    decisions: Object.freeze(decisions),
  });
}

function sameSources(
  left: readonly KnowledgeResourceSourceBinding[],
  right: readonly KnowledgeResourceSourceBinding[],
): boolean {
  return left.length === right.length && left.every((source, index) =>
    source.sourceRef === right[index]?.sourceRef && source.sourceHash === right[index]?.sourceHash);
}

function validateDecisionBinding(
  decision: DecisionFields,
  unit: KnowledgeResourceCurationUnit,
  label: string,
): void {
  if (decision.scopeFingerprint !== unit.scopeFingerprint || decision.cohort !== unit.cohort ||
      !sameSources(decision.sources, unit.sources)) fail(`${label} source scope cohort binding drift`);
}

function validatePlan(plan: KnowledgeResourceCurationPlan): Readonly<{
  unitById: ReadonlyMap<string, KnowledgeResourceCurationUnit>;
  batchById: ReadonlyMap<string, KnowledgeResourceCurationBatch>;
  reviewBatches: readonly KnowledgeResourceCurationBatch[];
  ordered: readonly Readonly<{ unit: KnowledgeResourceCurationUnit; batch: KnowledgeResourceCurationBatch }>[];
}> {
  if (plan.units.length !== plan.summary.unitCount || plan.batches.length !== plan.summary.batchCount ||
      plan.summary.sourceCoverage !== 1 || plan.summary.eligibleStrongRevisionCount !== 0 ||
      plan.guards.candidateOnly !== true || plan.guards.canonicalTargetsSelected !== false ||
      plan.guards.formalAssetsWritten !== false || plan.guards.treeArtifactsWritten !== false ||
      plan.guards.postgresTouched !== false || plan.guards.supersedeAllowed !== false ||
      plan.guards.crossScopeGroupingAllowed !== false) fail("plan summary or guard contract");
  const unitById = new Map<string, KnowledgeResourceCurationUnit>();
  const sourceRefs = new Set<string>();
  let sourceCount = 0;
  for (const unit of plan.units) {
    if (unitById.has(unit.unitId) || !SHA256.test(unit.unitId) ||
        !SHA256.test(unit.scopeFingerprint) || unit.candidateOnly !== true ||
        !COHORTS.has(unit.cohort) || unit.reviewRequired !==
          (unit.cohort === "snapshot_document" || unit.cohort === "strong_locator") ||
        unit.dispositionCandidate !== (unit.cohort === "quarantine" ? "quarantine" : "lookup_only") ||
        !Array.isArray(unit.logicalSourceIdentities) || !Array.isArray(unit.resourceLocators) ||
        !Number.isSafeInteger(unit.ordinalCount) || unit.ordinalCount < 0 ||
        !Number.isSafeInteger(unit.bytes) || unit.bytes < 0) fail("plan unit contract");
    const sources = sourceBindings(unit.sources, `plan unit ${unit.unitId}`);
    for (const source of sources) {
      if (sourceRefs.has(source.sourceRef)) fail("plan duplicate source coverage");
      sourceRefs.add(source.sourceRef);
      sourceCount += 1;
    }
    unitById.set(unit.unitId, unit);
  }
  const batchById = new Map<string, KnowledgeResourceCurationBatch>();
  const assigned = new Set<string>();
  const ordered: Array<Readonly<{
    unit: KnowledgeResourceCurationUnit;
    batch: KnowledgeResourceCurationBatch;
  }>> = [];
  const batches = [...plan.batches].sort((left, right) => left.sequence - right.sequence);
  for (const [index, batch] of batches.entries()) {
    const expectedMode = batch.cohort === "snapshot_document" || batch.cohort === "strong_locator"
      ? "review" : "deterministic";
    if (batch.sequence !== index + 1 || batchById.has(batch.batchId) || !SHA256.test(batch.batchId) ||
        batch.mode !== expectedMode || batch.candidateOnly !== true ||
        !SHA256.test(batch.scopeFingerprint) || !Array.isArray(batch.unitIds) ||
        batch.unitIds.length === 0 || new Set(batch.unitIds).size !== batch.unitIds.length) {
      fail("plan batch sequence or contract");
    }
    let batchSources = 0;
    let batchBytes = 0;
    for (const unitId of batch.unitIds) {
      const unit = unitById.get(unitId);
      if (!unit || assigned.has(unitId) || unit.cohort !== batch.cohort ||
          unit.scopeFingerprint !== batch.scopeFingerprint) fail("plan batch unit coverage");
      assigned.add(unitId);
      batchSources += unit.sources.length;
      batchBytes += unit.bytes;
      ordered.push(Object.freeze({ unit, batch }));
    }
    if (batchSources !== batch.sourceCount || batchBytes !== batch.bytes) {
      fail("plan batch source or byte coverage");
    }
    batchById.set(batch.batchId, batch);
  }
  if (assigned.size !== unitById.size || sourceCount !== plan.summary.sourceCount ||
      sourceRefs.size !== sourceCount) fail("plan global source unit coverage");
  return Object.freeze({
    unitById,
    batchById,
    reviewBatches: Object.freeze(batches.filter((batch) => batch.mode === "review")),
    ordered: Object.freeze(ordered),
  });
}

async function loadReviews(
  root: string,
  reviewRoot: string,
  planFileSha256: string,
  plan: KnowledgeResourceCurationPlan,
  validatedPlan: ReturnType<typeof validatePlan>,
): Promise<Readonly<{
  byUnit: ReadonlyMap<string, ReviewDecision>;
  files: readonly ReviewFileHash[];
}>> {
  await assertContainedPath(root, reviewRoot, "directory");
  const rootEntries = await readdir(reviewRoot, { withFileTypes: true });
  const rootNames = rootEntries.map((entry) => entry.name).sort();
  if (rootNames.length !== REVIEW_AGENTS.length ||
      rootNames.some((name, index) => name !== REVIEW_AGENTS[index]) ||
      rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    fail("review root layout");
  }
  const draftByBatch = new Map<string, ReviewDraft>();
  const byUnit = new Map<string, ReviewDecision>();
  const files: ReviewFileHash[] = [];
  for (const agent of REVIEW_AGENTS) {
    const agentPath = resolve(reviewRoot, agent);
    await assertContainedPath(root, agentPath, "directory");
    const entries = await readdir(agentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        fail("review layout extra file or symlink");
      }
      const path = resolve(agentPath, entry.name);
      await assertContainedPath(root, path, "file");
      const buffer = await readFile(path);
      const draft = parseReviewDraft(
        parseCanonicalJson(buffer.toString("utf8"), "review draft"),
        planFileSha256,
        plan,
      );
      if (entry.name !== `${draft.batchId}.json` || draftByBatch.has(draft.batchId)) {
        fail("review duplicate batch or filename coverage");
      }
      const batch = validatedPlan.batchById.get(draft.batchId);
      if (!batch || batch.mode !== "review" || draft.decisions.length !== batch.unitIds.length) {
        fail("review batch coverage");
      }
      const decisionByUnit = new Map(draft.decisions.map((decision) => [decision.unitId, decision]));
      if (decisionByUnit.size !== batch.unitIds.length ||
          batch.unitIds.some((unitId) => !decisionByUnit.has(unitId))) fail("review unit coverage");
      for (const decision of draft.decisions) {
        const unit = validatedPlan.unitById.get(decision.unitId)!;
        validateDecisionBinding(decision, unit, "review");
        if (decision.disposition !== "lookup_only") fail("review disposition must be lookup_only");
        if (decision.verdict === "accept") {
          const conforming = unit.cohort === "snapshot_document"
            ? decision.logicalSourceDisposition === "snapshot_document" &&
              decision.revisionKind === "snapshot_chunks"
            : unit.cohort === "strong_locator" &&
              decision.logicalSourceDisposition === "locator_resource" &&
              decision.revisionKind === "unversioned";
          if (!conforming || decision.conflict) fail("review accept cohort or conflict drift");
        }
        if (byUnit.has(decision.unitId)) fail("review duplicate unit across batches");
        byUnit.set(decision.unitId, decision);
      }
      draftByBatch.set(draft.batchId, draft);
      files.push(Object.freeze({
        agent,
        relativePath: `${agent}/${entry.name}`,
        batchId: draft.batchId,
        fileSha256: sha256(buffer),
      }));
    }
  }
  if (draftByBatch.size !== validatedPlan.reviewBatches.length ||
      validatedPlan.reviewBatches.some((batch) => !draftByBatch.has(batch.batchId)) ||
      byUnit.size !== validatedPlan.reviewBatches.reduce((sum, batch) =>
        sum + batch.unitIds.length, 0)) fail("review file or unit coverage missing");
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze({ byUnit, files: Object.freeze(files) });
}

function resourceIdentity(planSha256: string, unitId: string): string {
  return `resource_${sha256([
    "mengshu.private-knowledge-resource-identity/v1", planSha256, unitId,
  ].join("\0")).slice(0, 32)}`;
}

async function writeExclusive(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function runMarkdownKnowledgeResourceResolution(
  input: RunMarkdownKnowledgeResourceResolutionInput,
): Promise<MarkdownKnowledgeResourceResolutionResult> {
  const raw = exactKeys(input, [
    "containmentRoot", "planPath", "planFileSha256", "reviewRoot", "arbitrationPath",
    "arbitrationFileSha256", "outputDirectory", "createdAt",
  ], "operator input");
  const root = absolutePath(raw.containmentRoot, "containment root");
  const planPath = absolutePath(raw.planPath, "plan");
  const planFileSha256 = hash(raw.planFileSha256, "plan file");
  const reviewRoot = absolutePath(raw.reviewRoot, "review root");
  const arbitrationPath = absolutePath(raw.arbitrationPath, "arbitration");
  const arbitrationFileSha256 = hash(raw.arbitrationFileSha256, "arbitration file");
  const outputDirectory = absolutePath(raw.outputDirectory, "output");
  const createdAt = iso(raw.createdAt, "resolution");
  const rootInfo = await pathInfo(root);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail("containment root");
  await Promise.all([
    assertContainedPath(root, planPath, "file"),
    assertContainedPath(root, reviewRoot, "directory"),
    assertContainedPath(root, arbitrationPath, "file"),
  ]);
  if (!strictDescendant(root, outputDirectory)) fail("output path containment");
  if (await pathInfo(outputDirectory)) fail("output directory exists; overwrite forbidden");
  const outputParent = dirname(outputDirectory);
  if (outputParent !== root) await assertContainedPath(root, outputParent, "directory");

  const [planBuffer, arbitrationBuffer] = await Promise.all([
    readFile(planPath),
    readFile(arbitrationPath),
  ]);
  if (sha256(planBuffer) !== planFileSha256) fail("plan file hash drift");
  if (sha256(arbitrationBuffer) !== arbitrationFileSha256) {
    fail("arbitration file hash drift");
  }
  let plan: KnowledgeResourceCurationPlan;
  try {
    plan = parseKnowledgeResourcePlan(planBuffer.toString("utf8"));
  } catch {
    fail("plan parse or semantic hash drift");
  }
  const validatedPlan = validatePlan(plan);
  const reviews = await loadReviews(root, reviewRoot, planFileSha256, plan, validatedPlan);
  const arbitration = parseArbitrationDraft(
    parseCanonicalJson(arbitrationBuffer.toString("utf8"), "arbitration draft"),
    planFileSha256,
    plan,
  );
  const needsReview = new Map<string, ReviewDecision>();
  const accepted = new Set<string>();
  for (const [unitId, decision] of reviews.byUnit) {
    if (decision.verdict === "needs_review") needsReview.set(unitId, decision);
    else accepted.add(unitId);
  }
  const arbitrationByUnit = new Map(arbitration.decisions.map((decision) =>
    [decision.unitId, decision] as const));
  if (arbitrationByUnit.size !== needsReview.size ||
      [...needsReview.keys()].some((unitId) => !arbitrationByUnit.has(unitId)) ||
      [...arbitrationByUnit.keys()].some((unitId) => !needsReview.has(unitId) ||
        accepted.has(unitId))) fail("arbitration exact needs_review coverage unresolved or extra accept");
  for (const [unitId, decision] of arbitrationByUnit) {
    const unit = validatedPlan.unitById.get(unitId);
    if (!unit) fail("arbitration unknown unit coverage");
    validateDecisionBinding(decision, unit, "arbitration");
  }

  const unitRows: FinalUnitDecision[] = [];
  const bindingRows: Record<string, unknown>[] = [];
  const sourceRows: Record<string, unknown>[] = [];
  const identities = new Set<string>();
  for (const { unit, batch } of validatedPlan.ordered) {
    let selected: DecisionFields;
    let basis: FinalUnitDecision["resolutionBasis"];
    if (unit.cohort === "quarantine") {
      selected = {
        unitId: unit.unitId,
        scopeFingerprint: unit.scopeFingerprint,
        sources: unit.sources,
        cohort: unit.cohort,
        logicalSourceDisposition: "distinct_chunk",
        revisionKind: "unversioned",
        disposition: "quarantine",
        confidence: 1,
        conflict: false,
        reasonCodes: Object.freeze(["plan_quarantine_resolution"]),
      };
      basis = "quarantine";
    } else if (batch.mode === "deterministic") {
      selected = {
        unitId: unit.unitId,
        scopeFingerprint: unit.scopeFingerprint,
        sources: unit.sources,
        cohort: unit.cohort,
        logicalSourceDisposition: "distinct_chunk",
        revisionKind: "unversioned",
        disposition: "lookup_only",
        confidence: 1,
        conflict: false,
        reasonCodes: Object.freeze(["deterministic_lookup_resolution"]),
      };
      basis = "deterministic";
    } else {
      const review = reviews.byUnit.get(unit.unitId);
      if (!review) fail("review resolution missing");
      selected = review.verdict === "accept"
        ? review
        : arbitrationByUnit.get(unit.unitId) ?? fail("arbitration resolution missing");
      basis = review.verdict === "accept" ? "accepted_review" : "arbitration";
    }
    const identity = resourceIdentity(plan.semanticPlanSha256, unit.unitId);
    if (identities.has(identity)) fail("private resource identity collision");
    identities.add(identity);
    unitRows.push(Object.freeze({
      schema: UNIT_DECISION_SCHEMA,
      unitId: unit.unitId,
      batchId: batch.batchId,
      sequence: batch.sequence,
      scopeFingerprint: unit.scopeFingerprint,
      cohort: unit.cohort,
      disposition: selected.disposition,
      logicalSourceDisposition: selected.logicalSourceDisposition,
      revisionKind: selected.revisionKind,
      confidence: selected.confidence,
      conflict: selected.conflict,
      resourceIdentity: identity,
      resolutionBasis: basis,
      reasonCodes: Object.freeze([...selected.reasonCodes]),
      candidateOnly: false,
    }));
    bindingRows.push(Object.freeze({
      schema: RESOURCE_BINDING_SCHEMA,
      resourceIdentity: identity,
      unitId: unit.unitId,
      scopeFingerprint: unit.scopeFingerprint,
      logicalSourceDisposition: selected.logicalSourceDisposition,
      revisionKind: selected.revisionKind,
      logicalSourceIdentities: Object.freeze([...unit.logicalSourceIdentities]),
      resourceLocators: Object.freeze([...unit.resourceLocators]),
      ordinalCount: unit.ordinalCount,
      sources: Object.freeze(unit.sources.map((source) => Object.freeze({ ...source }))),
      candidateOnly: false,
    }));
    for (const source of unit.sources) {
      sourceRows.push(Object.freeze({
        schema: SOURCE_DISPOSITION_SCHEMA,
        sourceRef: source.sourceRef,
        sourceHash: source.sourceHash,
        unitId: unit.unitId,
        resourceIdentity: identity,
        scopeFingerprint: unit.scopeFingerprint,
        cohort: unit.cohort,
        disposition: selected.disposition,
        logicalSourceDisposition: selected.logicalSourceDisposition,
        revisionKind: selected.revisionKind,
        candidateOnly: false,
      }));
    }
  }
  if (unitRows.length !== plan.summary.unitCount || bindingRows.length !== unitRows.length ||
      sourceRows.length !== plan.summary.sourceCount ||
      new Set(sourceRows.map((row) => row.sourceRef)).size !== sourceRows.length ||
      identities.size !== unitRows.length) fail("final unit binding source coverage");
  sourceRows.sort((left, right) => String(left.sourceRef).localeCompare(String(right.sourceRef)));
  const quarantineSources = sourceRows.filter((row) => row.disposition === "quarantine").length;
  const eligibleSources = sourceRows.length - quarantineSources;
  const counts = Object.freeze({
    batches: plan.summary.batchCount,
    units: unitRows.length,
    sources: sourceRows.length,
    reviewBatches: validatedPlan.reviewBatches.length,
    reviewUnits: reviews.byUnit.size,
    acceptedReviews: accepted.size,
    arbitrated: arbitrationByUnit.size,
    unresolved: 0,
    coverage: 1,
    eligibleSources,
    lookupOnlySources: eligibleSources,
    quarantineSources,
    supersede: 0,
  });
  const guards = Object.freeze({
    canonicalTargetsSelected: false,
    formalAssetsWritten: false,
    treeArtifactsWritten: false,
    postgresTouched: false,
  });
  const summary = Object.freeze({
    schema: SUMMARY_SCHEMA,
    createdAt,
    planFileSha256,
    semanticPlanSha256: plan.semanticPlanSha256,
    counts,
    guards,
    candidateOnly: false,
  });
  const unitText = canonicalJsonl(unitRows);
  const bindingText = canonicalJsonl(bindingRows);
  const sourceText = canonicalJsonl(sourceRows);
  const summaryText = canonicalJson(summary);
  const outputHashes = Object.freeze({
    unitDecisions: sha256(unitText),
    knowledgeResourceBindings: sha256(bindingText),
    knowledgeSourceDispositions: sha256(sourceText),
    resolutionSummary: sha256(summaryText),
  });
  const outputArtifactSetSha256 = sha256(Object.entries(outputHashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\t${value}\n`).join(""));
  const receipt = Object.freeze({
    schema: RECEIPT_SCHEMA,
    createdAt,
    inputHashes: Object.freeze({
      planFileSha256,
      semanticPlanSha256: plan.semanticPlanSha256,
      arbitrationFileSha256,
      reviewFiles: reviews.files,
    }),
    outputHashes,
    outputArtifactSetSha256,
    counts,
    guards,
    candidateOnly: false,
  });
  const receiptText = canonicalJson(receipt);

  try {
    await mkdir(outputDirectory, { mode: 0o700 });
  } catch {
    fail("output directory exists or cannot be created");
  }
  await writeExclusive(resolve(outputDirectory, "unit-decisions.jsonl"), unitText);
  await writeExclusive(resolve(outputDirectory, "knowledge-resource-bindings.jsonl"), bindingText);
  await writeExclusive(resolve(outputDirectory, "knowledge-source-dispositions.jsonl"), sourceText);
  await writeExclusive(resolve(outputDirectory, "resolution-summary.json"), summaryText);
  await writeExclusive(resolve(outputDirectory, "receipt.json"), receiptText);
  return Object.freeze({
    status: "accepted",
    outputDirectory,
    units: unitRows.length,
    sources: sourceRows.length,
    acceptedReviews: accepted.size,
    arbitrated: arbitrationByUnit.size,
    unresolved: 0,
    coverage: 1,
    quarantineSources,
    eligibleSources,
    outputHashes,
    receiptSha256: sha256(receiptText),
  });
}

export function parseMarkdownKnowledgeResourceResolutionArgs(
  argv: readonly string[],
): RunMarkdownKnowledgeResourceResolutionInput {
  if (argv.length % 2 !== 0) fail("CLI arguments");
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) {
      fail("CLI arguments");
    }
    options.set(key, value);
  }
  const keys = [
    "--containment-root", "--plan", "--plan-file-sha256", "--review-root",
    "--arbitration", "--arbitration-file-sha256", "--output-dir", "--created-at",
  ];
  if (options.size !== keys.length || keys.some((key) => !options.has(key))) fail("CLI arguments");
  return {
    containmentRoot: options.get("--containment-root")!,
    planPath: options.get("--plan")!,
    planFileSha256: options.get("--plan-file-sha256")!,
    reviewRoot: options.get("--review-root")!,
    arbitrationPath: options.get("--arbitration")!,
    arbitrationFileSha256: options.get("--arbitration-file-sha256")!,
    outputDirectory: options.get("--output-dir")!,
    createdAt: options.get("--created-at")!,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    const result = await runMarkdownKnowledgeResourceResolution(
      parseMarkdownKnowledgeResourceResolutionArgs(argv),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: "MARKDOWN_KNOWLEDGE_RESOURCE_RESOLUTION_FAILED",
      message: error instanceof Error ? error.message : "Knowledge resolution failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
