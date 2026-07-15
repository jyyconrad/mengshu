import { readFileSync } from "node:fs";

export type ExtensionSuiteName =
  | "mengshu-extraction"
  | "mengshu-dedup"
  | "mengshu-recall-explain"
  | "mengshu-conflict"
  | "mengshu-tree-summary"
  | "mengshu-skill-candidate";

export type SemanticType =
  | "profile"
  | "rules"
  | "experience"
  | "task_context"
  | "resource";

export interface ContractIssue {
  suite: ExtensionSuiteName;
  caseId?: string;
  severity: "warning";
  code:
    | "recall_breakdown_semantics_ambiguous"
    | "recall_breakdown_input_underspecified"
    | "skill_generation_below_min_evidence"
    | "skill_observation_window_missing_timestamps"
    | "tree_seal_input_missing_leaves";
  path: string;
  message: string;
}

interface ExtensionCaseBase<S extends ExtensionSuiteName> {
  id: string;
  suite: S;
  task: string;
  expected: object;
  notes?: string;
}

export interface ExtractionMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
}

export interface ExtractionCandidate {
  type: SemanticType;
  body: string;
  targetScope: "session" | "project" | "app" | "user";
  profileDimension?:
    | "language"
    | "response_style"
    | "verification_preference"
    | "planning_preference"
    | "risk_boundary"
    | "domain_focus";
  profileLayer?: "global" | "app" | "project";
  crossContextual?: boolean;
  evidence?: string;
  eventIds?: string[];
  explicitSave?: boolean;
  extractionRoute?: "heuristic_fallback";
  notes?: string;
  potentialConflict?: string;
  source?: "rule_file";
  temporality?: "ephemeral";
}

export type ExtractionRejectedReason =
  | "common_knowledge"
  | "evidence_not_in_source_if_llm_hallucinate"
  | "experience_no_context"
  | "not_actionable"
  | "profile_capability_inference"
  | "profile_sensitive_personality"
  | "prompt_injection"
  | "query_not_memory"
  | "resource_no_purpose"
  | "salience_too_low"
  | "sensitive_emotion"
  | "sensitive_health"
  | "sensitive_pii"
  | "sensitive_political"
  | "text_too_generic"
  | "text_too_short";

export interface CandidateExtractionCase
  extends ExtensionCaseBase<"mengshu-extraction"> {
  scope: {
    tenantId?: string;
    appId?: string;
    userId?: string;
    projectId?: string;
    sessionId?: string;
  };
  input: {
    conversation?: ExtractionMessage[];
    documentChunk?: { text: string };
    sourceKind?: "rule_file";
    hints?: { explicitSave: boolean };
  };
  expected: {
    candidates: ExtractionCandidate[];
    rejectedReason?: ExtractionRejectedReason;
    riskFlags?: Array<"sensitive" | "prompt_injection">;
    notes?: string;
  };
}

export interface DedupMemory {
  body: string;
  type: SemanticType;
  scope?: { projectId: string };
  context?: string;
}

export interface SemanticDedupCase
  extends ExtensionCaseBase<"mengshu-dedup"> {
  memoryA: DedupMemory;
  memoryB: DedupMemory;
  expected: {
    relation: "duplicate" | "update" | "conflict" | "related" | "distinct";
    canonical?: string;
    contradicts?: boolean;
  };
}

export interface RecallMemory {
  id: string;
  body: string;
  type: SemanticType;
  salience_llm?: number;
  scope?: { projectId?: string; sessionId?: string };
  riskFlags?: Array<"sensitive" | "prompt_injection">;
  lifecycleStatus?:
    | "active"
    | "archived"
    | "candidate"
    | "revoked"
    | "superseded"
    | "promoted";
  createdAt?: string;
  temporality?: "ephemeral";
  profileDimension?:
    | "language"
    | "response_style"
    | "verification_preference"
    | "risk_boundary"
    | "domain_focus";
  source?: "rule_file" | "inferred";
  explicitSave?: boolean;
  userCorrected?: boolean;
  profileLayer?: "global" | "project";
  evidenceCount?: number;
  queryHits?: number;
  relevance?: number;
  crossContextual?: boolean;
  sources?: Array<"conversation" | "rule_file" | "explicit_save">;
  contradicts?: string[];
  updatedBy?: string;
  mergedFrom?: string[];
}

export interface RecallImportanceExpectation {
  salience_llm: number;
  sourceAuthority: number;
  explicitnessBonus: number;
  typePrior: number;
}

export interface RecallExpectedHit {
  id: string;
  importance?: RecallImportanceExpectation;
  breakdown_visible?: boolean;
  slot?: SemanticType;
  overridden?: string[];
  confidence?: number;
  hotness?: number;
  recencyDecay?: number;
  breakdown_complete?: Array<keyof RecallImportanceExpectation>;
}

export type RecallFilteredReason =
  | "salience_below_threshold"
  | "scope_mismatch"
  | "risk_flag_sensitive"
  | "lifecycle_archived"
  | "temporality_expired"
  | "overridden_by_project_layer"
  | "duplicate_of_m28a"
  | "relevance_too_low"
  | "token_budget_exceeded"
  | "risk_flag_prompt_injection"
  | "lifecycle_candidate_not_active"
  | "session_scope_mismatch"
  | "not_cross_contextual"
  | "conflict_with_m54a"
  | "updated_by_m55b"
  | "temporality_expired_ephemeral";

export interface RecallExpectedFiltered {
  id: string;
  reason: RecallFilteredReason;
  threshold?: number;
  query_scope?: string;
  memory_scope?: string;
  age_days?: number;
  slot_limit?: number;
  contradicts?: string;
}

export interface RecallExplainCase
  extends ExtensionCaseBase<"mengshu-recall-explain"> {
  query: string;
  scope: { userId: string; projectId?: string; sessionId?: string };
  memories: RecallMemory[];
  expected: {
    recalled?: RecallExpectedHit[];
    filtered?: RecallExpectedFiltered[];
    breakdown_visible?: boolean;
    slot_order?: SemanticType[];
  };
}

export interface ConflictMemory {
  body: string;
  type: "profile" | "rules" | "resource";
  scope?: { projectId: string };
  createdAt?: string;
  lifecycleStatus?: "active";
  userCorrected?: boolean;
}

export interface ConflictDetectionCase
  extends ExtensionCaseBase<"mengshu-conflict"> {
  memoryA: ConflictMemory;
  memoryB: ConflictMemory;
  expected: {
    conflict_detected: boolean;
    conflict_type?:
      | "rules_mutually_exclusive"
      | "conditional_compatible"
      | "profile_priority_conflict"
      | "resource_mutually_exclusive";
    false_merge?: number;
    resolved_by?: "user_correction";
    winner?: "memoryA" | "memoryB";
    action?: "downgrade_to_candidate";
    rollback_available?: boolean;
    reason?: "different_scope";
    relation?: "related";
  };
}

export interface TreeTextLeaf {
  id: string;
  body: string;
}

export type TreeFoldLeaf =
  | { L0: string }
  | { L1: string }
  | { L2: string };

export interface TreeKeyFact {
  fact: string;
  evidence: string[];
}

export interface TreeSummaryCase
  extends ExtensionCaseBase<"mengshu-tree-summary"> {
  treeType: "source" | "topic" | "global";
  leaves?: Array<TreeTextLeaf | TreeFoldLeaf>;
  llm_summary?: string;
  level?: "L0" | "L1" | "L2" | "L3";
  buffer_size?: number;
  seal_threshold?: number;
  existing_summary?: string;
  new_leaves?: TreeTextLeaf[];
  expected: {
    summary?: string;
    keyFacts?: TreeKeyFact[];
    faithfulness?: number;
    evidence_rate?: number;
    rejected?: boolean;
    reason?: "llm_hallucination";
    keyFacts_missing_evidence?: string[];
    folding_correct?: boolean;
    seal_triggered?: boolean;
    summary_generated?: boolean;
    summary_updated?: string;
    incremental?: boolean;
  };
}

export interface SkillExperience {
  id: string;
  body: string;
  createdAt?: string;
}

export interface SkillCandidateExpectation {
  title: string;
  pattern?: string;
  evidence?: string[];
  confidence?: number;
  schema?: "skill_candidate";
  status?: "candidate";
  not_executable?: boolean;
  domain?: "frontend";
  aggregated_count?: number;
}

export interface SkillCandidateCase
  extends ExtensionCaseBase<"mengshu-skill-candidate"> {
  experiences: SkillExperience[];
  expected: {
    skill_candidate_generated?: boolean;
    skill_candidate?: SkillCandidateExpectation;
    executable_skill_generated?: boolean;
    threshold_met?: "5_evidence";
    observation_window?: "3_days";
    reason?: "insufficient_evidence" | "conflicting_experiences";
    min_required?: number;
    not_skill_object?: boolean;
    llm_role?: "suggest_only";
    user_approval_required?: boolean;
    auto_execute?: boolean;
    observation_window_met?: boolean;
    window_days?: number;
    downgrade_to_candidate?: boolean;
  };
}

export interface ExtensionCaseBySuite {
  "mengshu-extraction": CandidateExtractionCase;
  "mengshu-dedup": SemanticDedupCase;
  "mengshu-recall-explain": RecallExplainCase;
  "mengshu-conflict": ConflictDetectionCase;
  "mengshu-tree-summary": TreeSummaryCase;
  "mengshu-skill-candidate": SkillCandidateCase;
}

export type ExtensionCase = ExtensionCaseBySuite[ExtensionSuiteName];

export interface ExtensionLoadResult<S extends ExtensionSuiteName> {
  suite: S;
  cases: Array<ExtensionCaseBySuite[S]>;
  contractIssues: ContractIssue[];
}

interface ValidationContext {
  suite: string;
  line: number;
}

type UnknownRecord = Record<string, unknown>;

const SUITES = new Set<ExtensionSuiteName>([
  "mengshu-extraction",
  "mengshu-dedup",
  "mengshu-recall-explain",
  "mengshu-conflict",
  "mengshu-tree-summary",
  "mengshu-skill-candidate",
]);

const SEMANTIC_TYPES = [
  "profile",
  "rules",
  "experience",
  "task_context",
  "resource",
] as const;

const EXTRACTION_REJECTED_REASONS = [
  "common_knowledge",
  "evidence_not_in_source_if_llm_hallucinate",
  "experience_no_context",
  "not_actionable",
  "profile_capability_inference",
  "profile_sensitive_personality",
  "prompt_injection",
  "query_not_memory",
  "resource_no_purpose",
  "salience_too_low",
  "sensitive_emotion",
  "sensitive_health",
  "sensitive_pii",
  "sensitive_political",
  "text_too_generic",
  "text_too_short",
] as const satisfies readonly ExtractionRejectedReason[];

function fail(ctx: ValidationContext, path: string, detail: string): never {
  throw new Error(
    `[extension-loader] suite=${ctx.suite} line=${ctx.line}: ${path} ${detail}`,
  );
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string, ctx: ValidationContext): UnknownRecord {
  if (!isRecord(value)) fail(ctx, path, "必须为对象");
  return value;
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  ctx: ValidationContext,
): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(ctx, path, `缺少字段 '${key}'`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(ctx, path, `包含额外字段 '${key}'`);
  }
}

function stringValue(
  value: unknown,
  path: string,
  ctx: ValidationContext,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(ctx, path, "必须为非空字符串");
  }
  return value;
}

function optionalString(value: unknown, path: string, ctx: ValidationContext): void {
  if (value !== undefined) stringValue(value, path, ctx);
}

function booleanValue(value: unknown, path: string, ctx: ValidationContext): void {
  if (typeof value !== "boolean") fail(ctx, path, "必须为 boolean");
}

function optionalBoolean(value: unknown, path: string, ctx: ValidationContext): void {
  if (value !== undefined) booleanValue(value, path, ctx);
}

function numberValue(
  value: unknown,
  path: string,
  ctx: ValidationContext,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(ctx, path, "必须为有限数值");
  }
  if (options.integer && !Number.isInteger(value)) fail(ctx, path, "必须为整数");
  if (options.min !== undefined && value < options.min) {
    fail(ctx, path, `必须在 ${options.min}..${options.max ?? "∞"}`);
  }
  if (options.max !== undefined && value > options.max) {
    fail(ctx, path, `必须在 ${options.min ?? "-∞"}..${options.max}`);
  }
  return value;
}

function optionalNumber(
  value: unknown,
  path: string,
  ctx: ValidationContext,
  options: { min?: number; max?: number; integer?: boolean } = {},
): void {
  if (value !== undefined) numberValue(value, path, ctx, options);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  ctx: ValidationContext,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(ctx, path, "不是允许的枚举值");
  }
  return value as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  ctx: ValidationContext,
): void {
  if (value !== undefined) enumValue(value, allowed, path, ctx);
}

function arrayValue(value: unknown, path: string, ctx: ValidationContext): unknown[] {
  if (!Array.isArray(value)) fail(ctx, path, "必须为数组");
  return value;
}

function stringArray(
  value: unknown,
  path: string,
  ctx: ValidationContext,
  options: { nonEmpty?: boolean } = {},
): string[] {
  const items = arrayValue(value, path, ctx);
  if (options.nonEmpty && items.length === 0) fail(ctx, path, "不得为空数组");
  items.forEach((item, index) => stringValue(item, `${path}[${index}]`, ctx));
  return items as string[];
}

function optionalStringArray(value: unknown, path: string, ctx: ValidationContext): void {
  if (value !== undefined) stringArray(value, path, ctx);
}

function isoDate(value: unknown, path: string, ctx: ValidationContext): void {
  const text = stringValue(value, path, ctx);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) || Number.isNaN(Date.parse(text))) {
    fail(ctx, path, "必须为 ISO 日期");
  }
}

function baseCase(
  value: UnknownRecord,
  suite: ExtensionSuiteName,
  allowed: readonly string[],
  required: readonly string[],
  ctx: ValidationContext,
): void {
  exactKeys(value, allowed, required, "顶层", ctx);
  stringValue(value.id, "id", ctx);
  if (value.suite !== suite) fail(ctx, "suite", "与 loader suite 不一致");
  stringValue(value.task, "task", ctx);
  optionalString(value.notes, "notes", ctx);
}

function scope(
  value: unknown,
  allowed: readonly string[],
  path: string,
  ctx: ValidationContext,
  required: readonly string[] = [],
): void {
  const item = record(value, path, ctx);
  exactKeys(item, allowed, required, path, ctx);
  for (const key of Object.keys(item)) stringValue(item[key], `${path}.${key}`, ctx);
}

function validateExtraction(value: UnknownRecord, ctx: ValidationContext): CandidateExtractionCase {
  baseCase(
    value,
    "mengshu-extraction",
    ["id", "suite", "task", "scope", "input", "expected", "notes"],
    ["id", "suite", "task", "scope", "input", "expected"],
    ctx,
  );
  scope(value.scope, ["tenantId", "appId", "userId", "projectId", "sessionId"], "scope", ctx);

  const input = record(value.input, "input", ctx);
  exactKeys(input, ["conversation", "documentChunk", "sourceKind", "hints"], [], "input", ctx);
  if (input.conversation === undefined && input.documentChunk === undefined) {
    fail(ctx, "input", "必须包含 conversation 或 documentChunk");
  }
  if (input.conversation !== undefined) {
    const messages = arrayValue(input.conversation, "input.conversation", ctx);
    if (messages.length === 0) fail(ctx, "input.conversation", "不得为空数组");
    messages.forEach((raw, index) => {
      const message = record(raw, `input.conversation[${index}]`, ctx);
      exactKeys(message, ["id", "role", "text"], ["role", "text"], `input.conversation[${index}]`, ctx);
      optionalString(message.id, `input.conversation[${index}].id`, ctx);
      enumValue(message.role, ["user", "assistant"], `input.conversation[${index}].role`, ctx);
      stringValue(message.text, `input.conversation[${index}].text`, ctx);
    });
  }
  if (input.documentChunk !== undefined) {
    const chunk = record(input.documentChunk, "input.documentChunk", ctx);
    exactKeys(chunk, ["text"], ["text"], "input.documentChunk", ctx);
    stringValue(chunk.text, "input.documentChunk.text", ctx);
  }
  optionalEnum(input.sourceKind, ["rule_file"], "input.sourceKind", ctx);
  if (input.hints !== undefined) {
    const hints = record(input.hints, "input.hints", ctx);
    exactKeys(hints, ["explicitSave"], ["explicitSave"], "input.hints", ctx);
    booleanValue(hints.explicitSave, "input.hints.explicitSave", ctx);
  }

  const expected = record(value.expected, "expected", ctx);
  exactKeys(expected, ["candidates", "rejectedReason", "riskFlags", "notes"], ["candidates"], "expected", ctx);
  const candidates = arrayValue(expected.candidates, "expected.candidates", ctx);
  candidates.forEach((raw, index) => {
    const path = `expected.candidates[${index}]`;
    const candidate = record(raw, path, ctx);
    exactKeys(
      candidate,
      [
        "type", "body", "targetScope", "profileDimension", "profileLayer",
        "crossContextual", "evidence", "eventIds", "explicitSave",
        "extractionRoute", "notes", "potentialConflict", "source", "temporality",
      ],
      ["type", "body", "targetScope"],
      path,
      ctx,
    );
    enumValue(candidate.type, SEMANTIC_TYPES, `${path}.type`, ctx);
    stringValue(candidate.body, `${path}.body`, ctx);
    enumValue(candidate.targetScope, ["session", "project", "app", "user"], `${path}.targetScope`, ctx);
    optionalEnum(candidate.profileDimension, ["language", "response_style", "verification_preference", "planning_preference", "risk_boundary", "domain_focus"], `${path}.profileDimension`, ctx);
    optionalEnum(candidate.profileLayer, ["global", "app", "project"], `${path}.profileLayer`, ctx);
    optionalBoolean(candidate.crossContextual, `${path}.crossContextual`, ctx);
    optionalString(candidate.evidence, `${path}.evidence`, ctx);
    if (candidate.eventIds !== undefined) stringArray(candidate.eventIds, `${path}.eventIds`, ctx, { nonEmpty: true });
    optionalBoolean(candidate.explicitSave, `${path}.explicitSave`, ctx);
    optionalEnum(candidate.extractionRoute, ["heuristic_fallback"], `${path}.extractionRoute`, ctx);
    optionalString(candidate.notes, `${path}.notes`, ctx);
    optionalString(candidate.potentialConflict, `${path}.potentialConflict`, ctx);
    optionalEnum(candidate.source, ["rule_file"], `${path}.source`, ctx);
    optionalEnum(candidate.temporality, ["ephemeral"], `${path}.temporality`, ctx);
  });
  optionalEnum(
    expected.rejectedReason,
    EXTRACTION_REJECTED_REASONS,
    "expected.rejectedReason",
    ctx,
  );
  if (expected.riskFlags !== undefined) {
    const flags = arrayValue(expected.riskFlags, "expected.riskFlags", ctx);
    flags.forEach((flag, index) => enumValue(flag, ["sensitive", "prompt_injection"], `expected.riskFlags[${index}]`, ctx));
  }
  optionalString(expected.notes, "expected.notes", ctx);
  if (candidates.length === 0 && expected.rejectedReason === undefined) {
    fail(ctx, "expected", "空 candidates 必须提供 rejectedReason");
  }
  return value as unknown as CandidateExtractionCase;
}

function validateDedupMemory(value: unknown, path: string, ctx: ValidationContext, allowContext: boolean): void {
  const item = record(value, path, ctx);
  const allowed = allowContext ? ["body", "type", "scope", "context"] : ["body", "type", "scope"];
  exactKeys(item, allowed, ["body", "type"], path, ctx);
  stringValue(item.body, `${path}.body`, ctx);
  enumValue(item.type, SEMANTIC_TYPES, `${path}.type`, ctx);
  if (item.scope !== undefined) scope(item.scope, ["projectId"], `${path}.scope`, ctx, ["projectId"]);
  optionalString(item.context, `${path}.context`, ctx);
}

function validateDedup(value: UnknownRecord, ctx: ValidationContext): SemanticDedupCase {
  baseCase(value, "mengshu-dedup", ["id", "suite", "task", "memoryA", "memoryB", "expected", "notes"], ["id", "suite", "task", "memoryA", "memoryB", "expected"], ctx);
  validateDedupMemory(value.memoryA, "memoryA", ctx, false);
  validateDedupMemory(value.memoryB, "memoryB", ctx, true);
  const expected = record(value.expected, "expected", ctx);
  exactKeys(expected, ["relation", "canonical", "contradicts"], ["relation"], "expected", ctx);
  const relation = enumValue(expected.relation, ["duplicate", "update", "conflict", "related", "distinct"], "expected.relation", ctx);
  optionalString(expected.canonical, "expected.canonical", ctx);
  optionalBoolean(expected.contradicts, "expected.contradicts", ctx);
  if (relation === "update" && expected.canonical === undefined) fail(ctx, "expected.canonical", "update 必须提供 canonical");
  if (relation === "conflict" && expected.contradicts !== true) fail(ctx, "expected.contradicts", "conflict 必须为 true");
  return value as unknown as SemanticDedupCase;
}

const RECALL_MEMORY_KEYS = [
  "id", "body", "type", "salience_llm", "scope", "riskFlags", "lifecycleStatus",
  "createdAt", "temporality", "profileDimension", "source", "explicitSave",
  "userCorrected", "profileLayer", "evidenceCount", "queryHits", "relevance",
  "crossContextual", "sources", "contradicts", "updatedBy", "mergedFrom",
] as const;

const RECALL_FILTER_REASONS = [
  "salience_below_threshold", "scope_mismatch", "risk_flag_sensitive",
  "lifecycle_archived", "temporality_expired", "overridden_by_project_layer",
  "duplicate_of_m28a", "relevance_too_low", "token_budget_exceeded",
  "risk_flag_prompt_injection", "lifecycle_candidate_not_active",
  "session_scope_mismatch", "not_cross_contextual", "conflict_with_m54a",
  "updated_by_m55b", "temporality_expired_ephemeral",
] as const;

function validateRecallMemory(value: unknown, index: number, ctx: ValidationContext): void {
  const path = `memories[${index}]`;
  const item = record(value, path, ctx);
  exactKeys(item, RECALL_MEMORY_KEYS, ["id", "body", "type"], path, ctx);
  stringValue(item.id, `${path}.id`, ctx);
  stringValue(item.body, `${path}.body`, ctx);
  enumValue(item.type, SEMANTIC_TYPES, `${path}.type`, ctx);
  optionalNumber(item.salience_llm, `${path}.salience_llm`, ctx, { min: 0, max: 1 });
  if (item.scope !== undefined) scope(item.scope, ["projectId", "sessionId"], `${path}.scope`, ctx);
  if (item.riskFlags !== undefined) {
    arrayValue(item.riskFlags, `${path}.riskFlags`, ctx).forEach((flag, flagIndex) =>
      enumValue(flag, ["sensitive", "prompt_injection"], `${path}.riskFlags[${flagIndex}]`, ctx));
  }
  optionalEnum(item.lifecycleStatus, ["active", "archived", "candidate", "revoked", "superseded", "promoted"], `${path}.lifecycleStatus`, ctx);
  if (item.createdAt !== undefined) isoDate(item.createdAt, `${path}.createdAt`, ctx);
  optionalEnum(item.temporality, ["ephemeral"], `${path}.temporality`, ctx);
  optionalEnum(
    item.profileDimension,
    ["language", "response_style", "verification_preference", "risk_boundary", "domain_focus"],
    `${path}.profileDimension`,
    ctx,
  );
  optionalEnum(item.source, ["rule_file", "inferred"], `${path}.source`, ctx);
  optionalBoolean(item.explicitSave, `${path}.explicitSave`, ctx);
  optionalBoolean(item.userCorrected, `${path}.userCorrected`, ctx);
  optionalEnum(item.profileLayer, ["global", "project"], `${path}.profileLayer`, ctx);
  optionalNumber(item.evidenceCount, `${path}.evidenceCount`, ctx, { min: 0, integer: true });
  optionalNumber(item.queryHits, `${path}.queryHits`, ctx, { min: 0, integer: true });
  optionalNumber(item.relevance, `${path}.relevance`, ctx, { min: 0, max: 1 });
  optionalBoolean(item.crossContextual, `${path}.crossContextual`, ctx);
  if (item.sources !== undefined) {
    arrayValue(item.sources, `${path}.sources`, ctx).forEach((sourceValue, sourceIndex) =>
      enumValue(sourceValue, ["conversation", "rule_file", "explicit_save"], `${path}.sources[${sourceIndex}]`, ctx));
  }
  optionalStringArray(item.contradicts, `${path}.contradicts`, ctx);
  optionalString(item.updatedBy, `${path}.updatedBy`, ctx);
  optionalStringArray(item.mergedFrom, `${path}.mergedFrom`, ctx);
}

function validateRecall(value: UnknownRecord, ctx: ValidationContext): RecallExplainCase {
  baseCase(value, "mengshu-recall-explain", ["id", "suite", "task", "query", "scope", "memories", "expected", "notes"], ["id", "suite", "task", "query", "scope", "memories", "expected"], ctx);
  stringValue(value.query, "query", ctx);
  scope(value.scope, ["userId", "projectId", "sessionId"], "scope", ctx, ["userId"]);
  const memories = arrayValue(value.memories, "memories", ctx);
  if (memories.length === 0) fail(ctx, "memories", "不得为空数组");
  memories.forEach((memory, index) => validateRecallMemory(memory, index, ctx));

  const expected = record(value.expected, "expected", ctx);
  exactKeys(expected, ["recalled", "filtered", "breakdown_visible", "slot_order"], [], "expected", ctx);
  if (Object.keys(expected).length === 0) fail(ctx, "expected", "不得为空对象");
  if (expected.recalled !== undefined) {
    arrayValue(expected.recalled, "expected.recalled", ctx).forEach((raw, index) => {
      const path = `expected.recalled[${index}]`;
      const hit = record(raw, path, ctx);
      exactKeys(hit, ["id", "importance", "breakdown_visible", "slot", "overridden", "confidence", "hotness", "recencyDecay", "breakdown_complete"], ["id"], path, ctx);
      stringValue(hit.id, `${path}.id`, ctx);
      if (hit.importance !== undefined) {
        const importance = record(hit.importance, `${path}.importance`, ctx);
        exactKeys(importance, ["salience_llm", "sourceAuthority", "explicitnessBonus", "typePrior"], ["salience_llm", "sourceAuthority", "explicitnessBonus", "typePrior"], `${path}.importance`, ctx);
        for (const key of ["salience_llm", "sourceAuthority", "explicitnessBonus", "typePrior"] as const) {
          numberValue(importance[key], `${path}.importance.${key}`, ctx, { min: 0, max: 1 });
        }
      }
      optionalBoolean(hit.breakdown_visible, `${path}.breakdown_visible`, ctx);
      optionalEnum(hit.slot, SEMANTIC_TYPES, `${path}.slot`, ctx);
      optionalStringArray(hit.overridden, `${path}.overridden`, ctx);
      optionalNumber(hit.confidence, `${path}.confidence`, ctx, { min: 0, max: 1 });
      optionalNumber(hit.hotness, `${path}.hotness`, ctx, { min: 0, max: 1 });
      optionalNumber(hit.recencyDecay, `${path}.recencyDecay`, ctx, { min: 0, max: 1 });
      if (hit.breakdown_complete !== undefined) {
        arrayValue(hit.breakdown_complete, `${path}.breakdown_complete`, ctx).forEach((field, fieldIndex) =>
          enumValue(field, ["salience_llm", "sourceAuthority", "explicitnessBonus", "typePrior"], `${path}.breakdown_complete[${fieldIndex}]`, ctx));
      }
    });
  }
  if (expected.filtered !== undefined) {
    arrayValue(expected.filtered, "expected.filtered", ctx).forEach((raw, index) => {
      const path = `expected.filtered[${index}]`;
      const item = record(raw, path, ctx);
      exactKeys(item, ["id", "reason", "threshold", "query_scope", "memory_scope", "age_days", "slot_limit", "contradicts"], ["id", "reason"], path, ctx);
      stringValue(item.id, `${path}.id`, ctx);
      enumValue(item.reason, RECALL_FILTER_REASONS, `${path}.reason`, ctx);
      optionalNumber(item.threshold, `${path}.threshold`, ctx, { min: 0, max: 1 });
      optionalString(item.query_scope, `${path}.query_scope`, ctx);
      optionalString(item.memory_scope, `${path}.memory_scope`, ctx);
      optionalNumber(item.age_days, `${path}.age_days`, ctx, { min: 0 });
      optionalNumber(item.slot_limit, `${path}.slot_limit`, ctx, { min: 0, integer: true });
      optionalString(item.contradicts, `${path}.contradicts`, ctx);
    });
  }
  optionalBoolean(expected.breakdown_visible, "expected.breakdown_visible", ctx);
  if (expected.slot_order !== undefined) {
    arrayValue(expected.slot_order, "expected.slot_order", ctx).forEach((slotValue, index) =>
      enumValue(slotValue, SEMANTIC_TYPES, `expected.slot_order[${index}]`, ctx));
  }
  return value as unknown as RecallExplainCase;
}

function validateConflictMemory(value: unknown, path: string, ctx: ValidationContext): void {
  const item = record(value, path, ctx);
  exactKeys(item, ["body", "type", "scope", "createdAt", "lifecycleStatus", "userCorrected"], ["body", "type"], path, ctx);
  stringValue(item.body, `${path}.body`, ctx);
  enumValue(item.type, ["profile", "rules", "resource"], `${path}.type`, ctx);
  if (item.scope !== undefined) scope(item.scope, ["projectId"], `${path}.scope`, ctx, ["projectId"]);
  if (item.createdAt !== undefined) isoDate(item.createdAt, `${path}.createdAt`, ctx);
  optionalEnum(item.lifecycleStatus, ["active"], `${path}.lifecycleStatus`, ctx);
  optionalBoolean(item.userCorrected, `${path}.userCorrected`, ctx);
}

function validateConflict(value: UnknownRecord, ctx: ValidationContext): ConflictDetectionCase {
  baseCase(value, "mengshu-conflict", ["id", "suite", "task", "memoryA", "memoryB", "expected", "notes"], ["id", "suite", "task", "memoryA", "memoryB", "expected"], ctx);
  validateConflictMemory(value.memoryA, "memoryA", ctx);
  validateConflictMemory(value.memoryB, "memoryB", ctx);
  const expected = record(value.expected, "expected", ctx);
  exactKeys(expected, ["conflict_detected", "conflict_type", "false_merge", "resolved_by", "winner", "action", "rollback_available", "reason", "relation"], ["conflict_detected"], "expected", ctx);
  booleanValue(expected.conflict_detected, "expected.conflict_detected", ctx);
  optionalEnum(expected.conflict_type, ["rules_mutually_exclusive", "conditional_compatible", "profile_priority_conflict", "resource_mutually_exclusive"], "expected.conflict_type", ctx);
  optionalNumber(expected.false_merge, "expected.false_merge", ctx, { min: 0, max: 1 });
  optionalEnum(expected.resolved_by, ["user_correction"], "expected.resolved_by", ctx);
  optionalEnum(expected.winner, ["memoryA", "memoryB"], "expected.winner", ctx);
  optionalEnum(expected.action, ["downgrade_to_candidate"], "expected.action", ctx);
  optionalBoolean(expected.rollback_available, "expected.rollback_available", ctx);
  optionalEnum(expected.reason, ["different_scope"], "expected.reason", ctx);
  optionalEnum(expected.relation, ["related"], "expected.relation", ctx);
  return value as unknown as ConflictDetectionCase;
}

function validateTreeTextLeaf(value: unknown, path: string, ctx: ValidationContext): void {
  const leaf = record(value, path, ctx);
  exactKeys(leaf, ["id", "body"], ["id", "body"], path, ctx);
  stringValue(leaf.id, `${path}.id`, ctx);
  stringValue(leaf.body, `${path}.body`, ctx);
}

function validateTree(value: UnknownRecord, ctx: ValidationContext): TreeSummaryCase {
  baseCase(value, "mengshu-tree-summary", ["id", "suite", "task", "treeType", "leaves", "llm_summary", "level", "buffer_size", "seal_threshold", "existing_summary", "new_leaves", "expected", "notes"], ["id", "suite", "task", "treeType", "expected"], ctx);
  enumValue(value.treeType, ["source", "topic", "global"], "treeType", ctx);
  if (value.leaves !== undefined) {
    const leaves = arrayValue(value.leaves, "leaves", ctx);
    if (leaves.length === 0) fail(ctx, "leaves", "不得为空数组");
    leaves.forEach((raw, index) => {
      const path = `leaves[${index}]`;
      const leaf = record(raw, path, ctx);
      if ("id" in leaf || "body" in leaf) {
        validateTreeTextLeaf(leaf, path, ctx);
      } else {
        exactKeys(leaf, ["L0", "L1", "L2"], [], path, ctx);
        if (Object.keys(leaf).length !== 1) fail(ctx, path, "fold leaf 必须且只能包含一个层级");
        for (const [key, entry] of Object.entries(leaf)) {
          enumValue(key, ["L0", "L1", "L2"], `${path}.level`, ctx);
          stringValue(entry, `${path}.${key}`, ctx);
        }
      }
    });
  }
  optionalString(value.llm_summary, "llm_summary", ctx);
  optionalEnum(value.level, ["L0", "L1", "L2", "L3"], "level", ctx);
  optionalNumber(value.buffer_size, "buffer_size", ctx, { min: 1, integer: true });
  optionalNumber(value.seal_threshold, "seal_threshold", ctx, { min: 1, integer: true });
  optionalString(value.existing_summary, "existing_summary", ctx);
  if (value.new_leaves !== undefined) {
    const leaves = arrayValue(value.new_leaves, "new_leaves", ctx);
    if (leaves.length === 0) fail(ctx, "new_leaves", "不得为空数组");
    leaves.forEach((leaf, index) => validateTreeTextLeaf(leaf, `new_leaves[${index}]`, ctx));
  }
  if (value.buffer_size !== undefined && value.seal_threshold === undefined) fail(ctx, "seal_threshold", "buffer case 必须提供");
  if (value.existing_summary !== undefined && value.new_leaves === undefined) fail(ctx, "new_leaves", "incremental case 必须提供");
  if (value.leaves === undefined && value.buffer_size === undefined && value.existing_summary === undefined) fail(ctx, "顶层", "缺少可识别 tree 输入变体");

  const expected = record(value.expected, "expected", ctx);
  exactKeys(expected, ["summary", "keyFacts", "faithfulness", "evidence_rate", "rejected", "reason", "keyFacts_missing_evidence", "folding_correct", "seal_triggered", "summary_generated", "summary_updated", "incremental"], [], "expected", ctx);
  if (Object.keys(expected).length === 0) fail(ctx, "expected", "不得为空对象");
  optionalString(expected.summary, "expected.summary", ctx);
  if (expected.keyFacts !== undefined) {
    arrayValue(expected.keyFacts, "expected.keyFacts", ctx).forEach((raw, index) => {
      const path = `expected.keyFacts[${index}]`;
      const fact = record(raw, path, ctx);
      exactKeys(fact, ["fact", "evidence"], ["fact", "evidence"], path, ctx);
      stringValue(fact.fact, `${path}.fact`, ctx);
      stringArray(fact.evidence, `${path}.evidence`, ctx, { nonEmpty: true });
    });
  }
  optionalNumber(expected.faithfulness, "expected.faithfulness", ctx, { min: 0, max: 1 });
  optionalNumber(expected.evidence_rate, "expected.evidence_rate", ctx, { min: 0, max: 1 });
  optionalBoolean(expected.rejected, "expected.rejected", ctx);
  optionalEnum(expected.reason, ["llm_hallucination"], "expected.reason", ctx);
  optionalStringArray(expected.keyFacts_missing_evidence, "expected.keyFacts_missing_evidence", ctx);
  optionalBoolean(expected.folding_correct, "expected.folding_correct", ctx);
  optionalBoolean(expected.seal_triggered, "expected.seal_triggered", ctx);
  optionalBoolean(expected.summary_generated, "expected.summary_generated", ctx);
  optionalString(expected.summary_updated, "expected.summary_updated", ctx);
  optionalBoolean(expected.incremental, "expected.incremental", ctx);
  return value as unknown as TreeSummaryCase;
}

function validateSkill(value: UnknownRecord, ctx: ValidationContext): SkillCandidateCase {
  baseCase(value, "mengshu-skill-candidate", ["id", "suite", "task", "experiences", "expected", "notes"], ["id", "suite", "task", "experiences", "expected"], ctx);
  const experiences = arrayValue(value.experiences, "experiences", ctx);
  if (experiences.length === 0) fail(ctx, "experiences", "不得为空数组");
  experiences.forEach((raw, index) => {
    const path = `experiences[${index}]`;
    const experience = record(raw, path, ctx);
    exactKeys(experience, ["id", "body", "createdAt"], ["id", "body"], path, ctx);
    stringValue(experience.id, `${path}.id`, ctx);
    stringValue(experience.body, `${path}.body`, ctx);
    if (experience.createdAt !== undefined) isoDate(experience.createdAt, `${path}.createdAt`, ctx);
  });
  const expected = record(value.expected, "expected", ctx);
  exactKeys(expected, ["skill_candidate_generated", "skill_candidate", "executable_skill_generated", "threshold_met", "observation_window", "reason", "min_required", "not_skill_object", "llm_role", "user_approval_required", "auto_execute", "observation_window_met", "window_days", "downgrade_to_candidate"], [], "expected", ctx);
  if (Object.keys(expected).length === 0) fail(ctx, "expected", "不得为空对象");
  optionalBoolean(expected.skill_candidate_generated, "expected.skill_candidate_generated", ctx);
  if (expected.skill_candidate !== undefined) {
    const candidate = record(expected.skill_candidate, "expected.skill_candidate", ctx);
    exactKeys(candidate, ["title", "pattern", "evidence", "confidence", "schema", "status", "not_executable", "domain", "aggregated_count"], ["title"], "expected.skill_candidate", ctx);
    stringValue(candidate.title, "expected.skill_candidate.title", ctx);
    optionalString(candidate.pattern, "expected.skill_candidate.pattern", ctx);
    optionalStringArray(candidate.evidence, "expected.skill_candidate.evidence", ctx);
    optionalNumber(candidate.confidence, "expected.skill_candidate.confidence", ctx, { min: 0, max: 1 });
    optionalEnum(candidate.schema, ["skill_candidate"], "expected.skill_candidate.schema", ctx);
    optionalEnum(candidate.status, ["candidate"], "expected.skill_candidate.status", ctx);
    optionalBoolean(candidate.not_executable, "expected.skill_candidate.not_executable", ctx);
    optionalEnum(candidate.domain, ["frontend"], "expected.skill_candidate.domain", ctx);
    optionalNumber(candidate.aggregated_count, "expected.skill_candidate.aggregated_count", ctx, { min: 1, integer: true });
  }
  optionalBoolean(expected.executable_skill_generated, "expected.executable_skill_generated", ctx);
  optionalEnum(expected.threshold_met, ["5_evidence"], "expected.threshold_met", ctx);
  optionalEnum(expected.observation_window, ["3_days"], "expected.observation_window", ctx);
  optionalEnum(expected.reason, ["insufficient_evidence", "conflicting_experiences"], "expected.reason", ctx);
  optionalNumber(expected.min_required, "expected.min_required", ctx, { min: 1, integer: true });
  optionalBoolean(expected.not_skill_object, "expected.not_skill_object", ctx);
  optionalEnum(expected.llm_role, ["suggest_only"], "expected.llm_role", ctx);
  optionalBoolean(expected.user_approval_required, "expected.user_approval_required", ctx);
  optionalBoolean(expected.auto_execute, "expected.auto_execute", ctx);
  optionalBoolean(expected.observation_window_met, "expected.observation_window_met", ctx);
  optionalNumber(expected.window_days, "expected.window_days", ctx, { min: 0 });
  optionalBoolean(expected.downgrade_to_candidate, "expected.downgrade_to_candidate", ctx);
  return value as unknown as SkillCandidateCase;
}

function suiteName(value: unknown, expectedSuite: ExtensionSuiteName, line: number): ExtensionSuiteName {
  const rawSuite = isRecord(value) && typeof value.suite === "string" ? value.suite : expectedSuite;
  const ctx = { suite: rawSuite, line };
  if (!SUITES.has(rawSuite as ExtensionSuiteName)) fail(ctx, "suite", "不支持");
  if (rawSuite !== expectedSuite) fail(ctx, "suite", "与请求 suite 不一致");
  return rawSuite as ExtensionSuiteName;
}

function validateCase(
  value: unknown,
  expectedSuite: ExtensionSuiteName,
  line: number,
): ExtensionCase {
  const suite = suiteName(value, expectedSuite, line);
  const ctx = { suite, line };
  const item = record(value, "顶层", ctx);
  switch (suite) {
    case "mengshu-extraction": return validateExtraction(item, ctx);
    case "mengshu-dedup": return validateDedup(item, ctx);
    case "mengshu-recall-explain": return validateRecall(item, ctx);
    case "mengshu-conflict": return validateConflict(item, ctx);
    case "mengshu-tree-summary": return validateTree(item, ctx);
    case "mengshu-skill-candidate": return validateSkill(item, ctx);
  }
}

function collectIssues(cases: ExtensionCase[]): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (cases[0]?.suite === "mengshu-recall-explain") {
    const recallCases = cases as RecallExplainCase[];
    if (recallCases.some((item) => item.expected.recalled?.some((hit) => hit.importance))) {
      issues.push({
        suite: "mengshu-recall-explain",
        severity: "warning",
        code: "recall_breakdown_semantics_ambiguous",
        path: "expected.recalled[].importance",
        message: "breakdown 字段未声明是原始信号、归一化值还是加权贡献",
      });
    }
    for (const item of recallCases) {
      const expectedIds = item.expected.recalled
        ?.filter((hit) => hit.importance !== undefined)
        .map((hit) => hit.id) ?? [];
      const underspecified = expectedIds.some((id) => {
        const memory = item.memories.find((candidate) => candidate.id === id);
        return memory?.salience_llm === undefined;
      });
      if (underspecified) {
        issues.push({
          suite: "mengshu-recall-explain",
          caseId: item.id,
          severity: "warning",
          code: "recall_breakdown_input_underspecified",
          path: "memories[].salience_llm",
          message: "期望完整 breakdown，但输入缺少可推导该 breakdown 的 salience 信号",
        });
      }
    }
  }
  if (cases[0]?.suite === "mengshu-skill-candidate") {
    for (const item of cases as SkillCandidateCase[]) {
      const expectsGeneration =
        item.expected.skill_candidate_generated === true ||
        item.expected.skill_candidate !== undefined;
      if (!expectsGeneration) continue;
      if (item.experiences.length < 5) {
        issues.push({
          suite: "mengshu-skill-candidate",
          caseId: item.id,
          severity: "warning",
          code: "skill_generation_below_min_evidence",
          path: "experiences",
          message: "期望生成 skill candidate，但证据数低于 fixture 声明的 5 条阈值",
        });
      }
      if (item.experiences.some((experience) => experience.createdAt === undefined)) {
        issues.push({
          suite: "mengshu-skill-candidate",
          caseId: item.id,
          severity: "warning",
          code: "skill_observation_window_missing_timestamps",
          path: "experiences[].createdAt",
          message: "期望生成 skill candidate，但观察窗口输入缺少时间戳",
        });
      }
    }
  }
  if (cases[0]?.suite === "mengshu-tree-summary") {
    for (const item of cases as TreeSummaryCase[]) {
      if (item.buffer_size !== undefined && item.expected.summary_generated === true && item.leaves === undefined) {
        issues.push({
          suite: "mengshu-tree-summary",
          caseId: item.id,
          severity: "warning",
          code: "tree_seal_input_missing_leaves",
          path: "leaves",
          message: "seal case 期望生成摘要，但没有提供可摘要 leaves",
        });
      }
    }
  }
  return issues;
}

export function loadExtensionSuite<S extends ExtensionSuiteName>(
  filePath: string,
  expectedSuite: S,
): ExtensionLoadResult<S> {
  const raw = readFileSync(filePath, "utf8");
  const cases: ExtensionCase[] = [];
  const seenIds = new Set<string>();
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      fail({ suite: expectedSuite, line: lineNumber }, "JSON", "解析失败");
    }
    const item = validateCase(parsed, expectedSuite, lineNumber);
    if (seenIds.has(item.id)) {
      fail({ suite: expectedSuite, line: lineNumber }, "id", "重复 case id");
    }
    seenIds.add(item.id);
    cases.push(item);
  }

  if (cases.length === 0) {
    fail({ suite: expectedSuite, line: 1 }, "fixture", "没有可加载 case");
  }

  return {
    suite: expectedSuite,
    cases: cases as Array<ExtensionCaseBySuite[S]>,
    contractIssues: collectIssues(cases),
  };
}
