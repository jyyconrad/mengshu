import type { HistoryPhase } from "./types.js";
import type { HistoryPgClient } from "./postgres-read.js";
import { HistoryError } from "./schema.js";

const READ_CHECKS = ["unitIdentity", "receiptIdentity", "exactScope", "confidenceNotIncreased", "canonicalIdentityPreserved", "evidenceRead", "currentRead", "lookupRead", "contextRead", "evidenceRoots"] as const;
type HistoryReadCheck = typeof READ_CHECKS[number];
const PHASES = ["operator", "evidence", "activate", "knowledge", "archive"] as const;

/** Fixed check names make the failure useful in JSON test reports without row data. */
export class HistoryNativeReadVerificationError extends HistoryError {
  readonly phase: HistoryPhase | "operator";
  readonly failedChecks: readonly HistoryReadCheck[];
  constructor(phase: HistoryPhase, checks: Readonly<Record<HistoryReadCheck, boolean>>) {
    super("HISTORY_NATIVE_READ_VERIFICATION_FAILED");
    this.phase = PHASES.includes(phase) ? phase : "operator";
    this.failedChecks = Object.freeze(READ_CHECKS.filter(check => ownValue(checks, check) !== true));
    this.message = `${this.code} phase=${this.phase} failed=${this.failedChecks.join(",") || "unknown"}`;
  }
}

const SQL_STATES = new Set(["08003", "08006", "22001", "22003", "22023", "22P02", "23502", "23503", "23505", "23514", "25006", "25P02", "40001", "40P01", "42501", "42601", "42703", "42804", "42883", "42P01", "53300", "57014"]);
const CODES = new Set([
  "HISTORY_COMMIT_UNCERTAIN", "HISTORY_ROLLBACK_UNCERTAIN", "HISTORY_CONSERVATION_FAILED", "HISTORY_APPROVED_OPERATION_REQUIRED", "HISTORY_OPERATOR_SCOPE_DENIED", "HISTORY_QUIESCENCE_REQUIRED", "HISTORY_RUN_CONFLICT",
  "HISTORY_SOURCE_CAS_FAILED", "HISTORY_PARENT_MAPPING_DRIFT", "HISTORY_NATIVE_UNIT_MISMATCH", "HISTORY_NATIVE_REVIEW_MISMATCH", "HISTORY_NATIVE_SCOPE_MISMATCH", "HISTORY_NATIVE_SOURCE_MISSING", "HISTORY_NATIVE_CONTENT_REQUIRED",
  "HISTORY_NATIVE_WRITE_MISMATCH", "HISTORY_NATIVE_WRITE_REJECTED", "HISTORY_NATIVE_RECEIPT_MISSING", "HISTORY_NATIVE_READ_VERIFICATION_FAILED", "HISTORY_PENDING_ADOPTION_CAS_FAILED", "HISTORY_PENDING_ADOPTION_INVALID", "HISTORY_TEMPORAL_REQUIRED",
  "HISTORY_RAW_INSERT_FAILED", "HISTORY_RAW_RECORD_INVALID", "HISTORY_EVIDENCE_LINK_CONFLICT", "HISTORY_ANCHOR_REQUIRED", "HISTORY_EVIDENCE_ANCHOR_DRIFT", "HISTORY_EVIDENCE_UTF8_INVALID", "HISTORY_EVIDENCE_BYTE_BUDGET", "HISTORY_EVIDENCE_UNIT_INVALID", "HISTORY_EVIDENCE_SOURCE_MISMATCH",
  "HISTORY_KNOWLEDGE_NATIVE_MISMATCH", "HISTORY_KNOWLEDGE_NATIVE_FAILED", "HISTORY_DOCUMENT_CAS_FAILED", "HISTORY_DOCUMENT_ADOPTION_INVALID", "HISTORY_DOCUMENT_COMPLETION_INVALID", "HISTORY_DOCUMENT_ASSET_CAS_FAILED", "HISTORY_DOCUMENT_INCOMPLETE", "HISTORY_DOCUMENT_READ_REJECTED",
  "HISTORY_JOURNAL_BUDGET", "HISTORY_JOURNAL_CONFLICT", "HISTORY_JOURNAL_CORRUPT", "HISTORY_ROLLBACK_CAS_FAILED", "HISTORY_ROLLBACK_SCHEMA_CHANGED", "HISTORY_ROLLBACK_NOT_RESTORED", "HISTORY_ROLLBACK_RECEIPT_CONFLICT", "HISTORY_RECEIPT_BUDGET", "HISTORY_RECEIPT_CONFLICT",
  "INVALID_COMMAND", "IDEMPOTENCY_REQUIRED", "MEMORY_WRITE_TX_ROLLBACK_FAILED", "MEMORY_WRITE_TX_CLEANUP_FAILED",
  "AUTHORITY_FIELD_MISSING", "AUTHORITY_FIELD_INVALID", "AUTHORITY_ALLOWLIST_MISSING", "AUTHORITY_ALLOWLIST_EMPTY", "AUTHORITY_ALLOWLIST_AMBIGUOUS", "CLIENT_SCOPE_INVALID", "CLIENT_FIELD_FORBIDDEN", "CLIENT_FIELD_MISSING", "CLIENT_FIELD_INVALID", "CLIENT_VALUE_NOT_ALLOWED", "CLIENT_VALUE_AMBIGUOUS",
]);
for (const stage of ["BEGIN", "CALLBACK", "RECEIPT_READ", "MUTATION", "AUDIT", "OUTBOX", "RECEIPT_WRITE", "COMMIT"]) {
  CODES.add(`MEMORY_WRITE_TX_${stage}_FAILED`);
  for (const state of SQL_STATES) CODES.add(`MEMORY_WRITE_TX_${stage}_FAILED_${state}`);
}
const COLUMNS = new Set(["id", "text", "content_hash", "vector", "metadata", "category", "lifecycle_status", "scope_key", "embedding_space_id", "embedding_space_state", "request_hash", "receipt"]);
const QUERIES = ["database-identity", "quiescence", "source-scope", "source-lock", "source-parent-mapping", "anchored-evidence", "receipt-read", "receipt-write", "register-run", "journal-row", "journal-save", "journal-load", "native-raw-insert", "reviewed-reference-provenance", "native-knowledge-write", "pending-adoption-lock", "native-pending-adoption", "embedding-adoption-guard", "document-pending-lock", "document-native-complete", "document-native-asset", "document-native-asset-head", "document-native-receipt", "document-native-head", "undo-insert", "undo-columns", "undo-update", "rollback-receipt-cas"] as const;
const STAGES = [...QUERIES, "database-query", "transaction-begin", "transaction-commit", "transaction-rollback", "native-apply", "native-rollback", "native-guard", "native-mutation", "native-receipt", "native-read-verification", "receipt-recheck"] as const;
export type HistoryDiagnosticStage = typeof STAGES[number];
export interface HistoryDiagnostic {
  readonly schema: "mengshu.history-p16-diagnostic/v1";
  readonly phase: HistoryPhase | "operator";
  readonly stage: HistoryDiagnosticStage;
  readonly code: string;
  readonly sqlState?: string;
  readonly column?: string;
  readonly receiptState?: "recovered" | "missing" | "unavailable";
  readonly failedChecks?: readonly HistoryReadCheck[];
}
export type HistoryDiagnosticObserver = (diagnostic: Readonly<HistoryDiagnostic>) => void | Promise<void>;
function ownValue(value: unknown, key: string): unknown {
  try { const descriptor = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key) : undefined; return descriptor && "value" in descriptor ? descriptor.value : undefined; } catch { return undefined; }
}
function ownString(value: unknown, key: string): string | undefined {
  const result = ownValue(value, key); return typeof result === "string" ? result : undefined;
}
function failedReadChecks(error: unknown): readonly HistoryReadCheck[] | undefined {
  if (ownString(error, "code") !== "HISTORY_NATIVE_READ_VERIFICATION_FAILED") return undefined;
  const values = ownValue(error, "failedChecks");
  if (!Array.isArray(values)) return undefined;
  const supplied = new Set(Array.from({ length: READ_CHECKS.length }, (_, index) => ownString(values, String(index))));
  return Object.freeze(READ_CHECKS.filter(check => supplied.has(check)));
}
export function historyDiagnosticCode(error: unknown): string {
  const code = ownString(error, "code");
  return code && CODES.has(code) ? code : code && SQL_STATES.has(code) ? "HISTORY_DATABASE_ERROR" : "HISTORY_DIAGNOSTIC_REDACTED";
}
/** Never reads error.message/detail/query/parameters/stack; callbacks cannot affect the operation. */
export function reportHistoryDiagnostic(observer: HistoryDiagnosticObserver | undefined, phase: HistoryDiagnostic["phase"], stage: HistoryDiagnosticStage, error: unknown, receiptState?: HistoryDiagnostic["receiptState"]): void {
  if (!observer) return;
  const rawCode = ownString(error, "code"), column = ownString(error, "column"), failedChecks = failedReadChecks(error);
  const diagnostic: HistoryDiagnostic = Object.freeze({ schema: "mengshu.history-p16-diagnostic/v1", phase: PHASES.includes(phase) ? phase : "operator", stage: STAGES.includes(stage) ? stage : "database-query", code: historyDiagnosticCode(error),
    ...(rawCode && SQL_STATES.has(rawCode) ? { sqlState: rawCode } : {}), ...(column && COLUMNS.has(column) ? { column } : {}), ...(receiptState && ["recovered", "missing", "unavailable"].includes(receiptState) ? { receiptState } : {}), ...(failedChecks ? { failedChecks } : {}) });
  try { const result = observer(diagnostic); if (result instanceof Promise) void result.catch(() => {}); } catch { /* Observability must not change receipt or transaction behavior. */ }
}
export class HistoryNativeDiagnostics {
  private phase: HistoryDiagnostic["phase"] = "operator";
  constructor(private readonly observer?: HistoryDiagnosticObserver) {}
  async run<T>(phase: HistoryDiagnostic["phase"], stage: HistoryDiagnosticStage, work: () => Promise<T>): Promise<T> {
    const previous = this.phase; this.phase = phase;
    try { return await work(); } catch (error) { reportHistoryDiagnostic(this.observer, phase, stage, error); throw error; } finally { this.phase = previous; }
  }
  client(client: HistoryPgClient): HistoryPgClient {
    return { query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      try { return await client.query<Row>(sql, values); } catch (error) {
        const statement = sql.trimStart();
        const stage = QUERIES.find(query => statement.startsWith(`/* history:${query} */`)) ?? (statement.startsWith("BEGIN") ? "transaction-begin" : statement === "COMMIT" ? "transaction-commit" : statement === "ROLLBACK" ? "transaction-rollback" : "database-query");
        reportHistoryDiagnostic(this.observer, this.phase, stage, error); throw error;
      }
    }, release: () => client.release() };
  }
}
