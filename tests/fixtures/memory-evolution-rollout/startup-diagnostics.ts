const STATES = new Set(["created", "starting", "ready", "degraded", "stopping", "stopped", "failed"]);
const COMPONENTS = new Set(["host", "runtime", "postgres_durable_bundle", "worker", "database", "embedding-registry",
  "continuous-memory-evolution", "tree", "slot-invalidation-outbox", "temporal-activation", "working-set-retention",
  "skill-candidate-aggregation", "active-derivation-outbox"]);
const CODES = new Set([
  "HOST_INVALID_CONFIG", "HOST_START_FAILED", "HOST_STOP_FAILED", "HOST_STOPPING", "RUNTIME_STOPPED", "RUNTIME_STOPPING",
  "DEPENDENCY_DEGRADED", "DEPENDENCIES_NOT_READY", "WORKER_NOT_READY", "WORKER_PROBE_FAILED", "WORKER_PROBE_TIMEOUT",
  "WORKER_RUNTIME_DEGRADED", "RUNTIME_NOT_READY", "DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED",
  "DURABLE_RUNTIME_BUNDLE_INVALID", "DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING", "DURABLE_RUNTIME_SCHEMA_V10_REQUIRED",
  "DURABLE_RUNTIME_SCHEMA_INVALID", "DURABLE_RUNTIME_READINESS_UNAVAILABLE", "SCHEMA_CONTRACT_INVALID",
  "SCHEMA_CONTRACT_PENDING", "EVOLUTION_SCHEMA_CAPABILITY_UNAVAILABLE", "EVOLUTION_PROVIDER_CAPABILITY_UNAVAILABLE",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "08001", "08006", "28P01", "3D000", "42P01", "42703", "23505", "23514",
]);
const BATCH_STATES = new Set(["queued", "running", "completed", "partial", "blocked", "cancelled", "failed"]);
const BATCH_REASONS = new Set([
  "attestation_transaction_budget_exhausted", "attestation_budget_exceeded", "attestation_snapshot_expired",
  "attestation_revoked_or_changed", "attestation_required", "attestation_apply_binding_mismatch",
  "attestation_transaction_guard_unavailable", "verification_budget_exhausted", "verification_budget_exceeded",
  "verification_budget_invalid", "input_verification_failed", "input_contract_invalid", "transaction_failed",
  "source_changed", "source_snapshot_changed", "source_snapshot_expired", "source_authority_unverified",
  "owner_review_required", "owner_reviewed_reference", "approval_binding_mismatch", "approval_expired",
  "review_source_changed", "review_source_budget_exceeded", "target_cas_conflict", "target_authorization_required",
  "kernel_result_contract_mismatch", "kernel_write_rejected", "source_context_incomplete", "kind_only_lookup_only",
  "model_unavailable", "model_output_invalid", "schema_invalid", "scope_mismatch", "cancelled", "batch_leased",
  "max_records", "max_files", "max_bytes", "max_duration", "max_llm_calls", "max_input_tokens", "max_output_tokens",
  "ambiguous_input_identity", "candidate_evidence_only", "classification_review_required", "evaluation_evidence_forbidden",
  "evidence_context_requires_review", "evidence_hash_mismatch", "evidence_semantics_unverified", "high_impact_owner_review",
  "kind_only_invalid", "merge_equivalence_unverified", "no_independent_evidence", "operation_requires_owner_review",
  "prompt_injection", "quote_context_clipped", "quote_mismatch", "semantic_rewrite_unverified", "sensitive_content",
  "source_revoked", "target_classification_changed", "target_tombstoned", "unchanged", "unrelated_evidence_requires_review",
  "user_statement_required", "valid_time_unverified", "verified_outcome_required",
  "candidate_schema_invalid", "candidate_evidence_not_in_source", "candidate_event_id_not_in_source", "candidate_text_too_short",
  "candidate_salience_below_min", "candidate_unknown_semantic_type", "candidate_profile_dimension_not_whitelisted",
  "ambiguous_input_port", "approval_not_granted", "batch_not_found", "cancel_capability_unavailable", "config_changed",
  "control_capability_unavailable", "control_request_invalid", "control_request_changed", "control_input_forbidden",
  "config_fingerprint_invalid", "idempotency_conflict", "input_redaction_required", "input_unit_invalid", "proposal_not_found",
  "validation_changed", "model_budget_invalid", "batch_operation_failed", "processed_proposal_missing", "apply_receipt_missing",
  "operation_capability_unavailable", "input_budget_exceeded", "input_gap", "input_capability_unavailable",
  "atomic_kernel_unavailable", "canonical_evidence_binding_mismatch", "canonical_evidence_invalid",
  "canonical_evidence_materialization_required", "canonical_evidence_missing", "canonical_evidence_revoked",
  "canonical_evidence_source_mismatch", "canonical_write_not_created", "confidence_increase_without_fresh_evidence",
  "create_has_target", "effective_evidence_write_failed", "effective_support_changed", "effective_support_not_validated",
  "governance_state_changed", "invalid_receipt", "kind_only_context_forbidden", "kind_only_temporal_read_unavailable",
  "multi_target_transaction_unavailable", "operation_atomic_apply_unavailable", "proposal_apply_conflict", "proposal_conflict",
  "proposal_content_missing", "proposal_expired", "provider_owned_transaction_required", "receipt_write_failed",
  "source_hydration_invalid", "source_hydration_mismatch", "source_hydration_unavailable", "target_tombstoned_or_missing",
  "temporal_lineage_required", "temporal_write_required", "validation_rejected", "verified_current_valid_time_required",
  "raw_evidence_not_persisted", "raw_evidence_span_binding_unavailable", "atomic_apply_failed", "atomic_receipt_missing",
  "duplicate_requires_evidence_review", "review_authority_mismatch", "review_evidence_missing", "review_target_missing",
  "review_source_gap", "review_source_reader_unavailable", "directory_target_lookup_unsupported", "input_mode_invalid",
  "related_targets_budget_invalid", "related_targets_budget_unavailable", "related_targets_evidence_limit",
  "related_targets_record_limit", "related_targets_byte_limit", "source_binding_ambiguous", "source_binding_unavailable",
  "source_budget_exhausted", "source_config_changed", "source_cursor_invalid", "source_scan_partial", "source_snapshot_invalid",
  "source_snapshot_missing", "source_record_locator_invalid", "source_record_unavailable", "source_record_changed",
  "attestation_author_required", "attestation_binding_mismatch", "attestation_expired", "attestation_target_mismatch",
  "attestation_clock_invalid", "attestation_input_invalid", "attestation_issuer_invalid", "attestation_schema_invalid",
  "attestation_scope_mismatch", "attestation_signature_invalid", "attestation_state_changed", "attestation_state_invalid",
  "attestation_verifier_unavailable", "attestation_revoked", "trusted_evidence_unavailable",
  "schema_invalid", "evidence_not_in_source", "event_id_not_in_source", "text_too_short", "salience_below_min",
  "unknown_semantic_type", "profile_dimension_not_whitelisted", "memory_text_required", "runtime_correction_requires_forget_capability",
  "semantic_type_recalibration_required", "confidence_evidence_unavailable", "unsupported_runtime_command",
  "value_score_signal_invalid", "temporal_transition_requires_active", "admission_drop", "prompt_injection_detected",
  "evidence_only_by_validator", "value_score_below_threshold", "explicit_save_fast_track", "rule_file_fast_track",
  "high_value_score_auto_promote", "medium_value_score", "low_priority_value_score", "raw_evidence_before_candidate_admission",
  "governed_kind_only_lookup", "kind_only_explicit_lookup",
  "checkpoint_content_forbidden", "checkpoint_too_large", "apply_capability_unavailable", "input_accounting_invalid",
  "source_locator_unavailable", "evidence_unavailable",
]);
const PROPOSAL_OPERATIONS = new Set(["create", "add_evidence", "merge_equivalent", "split_conditions", "evolve", "correct",
  "mark_disputed", "deprecate", "expire", "revalidate", "compile_pattern", "propose_skill", "noop"]);
const SEMANTIC_TYPES = new Set(["profile", "task_context", "rules", "experience", "resource"]);
const PROPOSAL_STATES = new Set(["staged", "rejected", "review", "applied", "noop"]);
const VALIDATION_OUTCOMES = new Set(["allowed", "rejected", "review", "noop"]);

// Only own data fields from snapshots/errors are inspected. No message/stack/config serialization or getters.
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}

function token(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function safeReasons(value: unknown): string[] {
  return Array.isArray(value) ? Array.from({ length: Math.min(value.length, 8) }, (_, index) =>
    token(data(value, String(index)), BATCH_REASONS, "unclassified_reason")) : [];
}

/** A fixed report/proposal projection: no checkpoint, scope, config, quote, signature, or provider message. */
export function safeNativeBatchDiagnostic(value: unknown, proposals?: unknown): string {
  const numeric = (object: unknown, keys: readonly string[]) => Object.fromEntries(keys.flatMap(key => {
    const number = data(object, key);
    return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? [[key, number]] : [];
  }));
  return JSON.stringify({ status: token(data(value, "status"), BATCH_STATES, "unknown_status"),
    reasons: safeReasons(data(value, "reasons")),
    counts: numeric(data(value, "counts"), ["proposed", "applied", "rejected", "review", "noop", "skipped"]),
    usage: numeric(data(value, "usage"), ["records", "files", "bytes", "llmCalls", "inputTokens", "outputTokens", "durationMs"]),
    resumable: data(value, "resumable") === true,
    ...(Array.isArray(proposals) ? { proposals: Array.from({ length: Math.min(proposals.length, 8) }, (_, index) => {
      const proposal = data(proposals, String(index)), validation = data(proposal, "validation");
      return { operation: token(data(proposal, "operation"), PROPOSAL_OPERATIONS, "unknown_operation"),
        semanticType: data(proposal, "semanticType") === undefined ? "absent" : token(data(proposal, "semanticType"), SEMANTIC_TYPES, "unknown_semantic_type"),
        status: token(data(proposal, "status"), PROPOSAL_STATES, "unknown_status"),
        validation: { outcome: token(data(validation, "outcome"), VALIDATION_OUTCOMES, "unknown_outcome"),
          reasons: safeReasons(data(validation, "reasons")), contextEligible: data(validation, "contextEligible") === true } };
    }) } : {}),
  });
}

interface SafeFailure { code: string; component: string; causes?: SafeFailure[] }
function failure(error: unknown, component: string, depth = 0): SafeFailure {
  const code = data(error, "code");
  const result: SafeFailure = { code: token(code, CODES, "unclassified_error"),
    component: token(data(error, "component"), COMPONENTS, component) };
  // A few production errors encode a stable enum as the entire message, never a raw provider message.
  if (result.code === "unclassified_error") result.code = token(data(error, "message"), CODES, "unclassified_error");
  if (depth < 2) {
    const errors = data(error, "errors"), cause = data(error, "cause");
    const causes = Array.isArray(errors) ? errors.slice(0, 3) : cause === undefined ? [] : [cause];
    if (causes.length) result.causes = causes.map(item => failure(item, result.component, depth + 1));
  }
  return result;
}

export function safeNativeStartupSnapshot(value: unknown, component: "host" | "runtime") {
  const result: Record<string, unknown> = { state: token(data(value, "state"), STATES, "snapshot_unavailable") };
  for (const key of ["ready", "accepting"]) if (typeof data(value, key) === "boolean") result[key] = data(value, key);
  const generation = data(value, "generation");
  if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) result.generation = generation;
  const failureCode = data(value, "failureCode");
  if (failureCode !== undefined) result.failureCode = token(failureCode, CODES, "unclassified_error");
  const original = data(value, "failure");
  if (original !== undefined) result.failure = failure(original, component);
  const issues = data(value, "issues");
  if (Array.isArray(issues)) result.issues = issues.slice(0, 8).map(issue => ({
    component: token(data(issue, "component"), COMPONENTS, "unknown_component"), code: token(data(issue, "code"), CODES, "unclassified_error"),
  }));
  const degraded = data(value, "degradedSteps");
  if (Array.isArray(degraded)) result.degradedSteps = degraded.slice(0, 8).map(step => ({
    component: token(data(step, "name"), COMPONENTS, "unknown_component"), code: token(data(step, "reason"), CODES, "unclassified_error"),
  }));
  return result;
}

export function nativeStartupError(component: "host" | "postgres_durable_bundle", error: unknown, host: unknown, runtime: unknown): Error {
  const diagnostic = { ...failure(error, component), snapshots: {
    host: safeNativeStartupSnapshot(host, "host"), runtime: safeNativeStartupSnapshot(runtime, "runtime"),
  } };
  const result = new Error(`native_rollout_startup_failed:${JSON.stringify(diagnostic)}`);
  result.name = "NativeRolloutStartupError";
  return result;
}

interface StartupRuntime {
  readonly durableJobV2RuntimeBundle?: { assertReady(): Promise<unknown> };
  readonly lifecycle: { snapshot(): unknown };
}
interface StartupHost { start(): Promise<void>; snapshot(): unknown }
function snapshot(source: { snapshot(): unknown }): unknown {
  try { return source.snapshot(); } catch { return undefined; }
}

/** Diagnostic preflight calls the same real, read-only provider readiness; the default host still checks it itself. */
export async function startNativeHostWithDiagnostics(host: StartupHost, runtime: StartupRuntime): Promise<void> {
  try {
    if (!runtime.durableJobV2RuntimeBundle) throw new Error("DURABLE_JOB_V2_RUNTIME_BUNDLE_REQUIRED");
    await runtime.durableJobV2RuntimeBundle.assertReady();
  } catch (error) {
    throw nativeStartupError("postgres_durable_bundle", error, snapshot(host), snapshot(runtime.lifecycle));
  }
  try { await host.start(); }
  catch (error) { throw nativeStartupError("host", error, snapshot(host), snapshot(runtime.lifecycle)); }
}
