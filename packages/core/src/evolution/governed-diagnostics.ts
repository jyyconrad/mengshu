import { AuthorityScopeError } from "../domain/authority-scope.js";
import { WriteKernelError, type MemoryWriteKernelDependencies } from "../service/write-kernel.js";
import { getPostgresMemoryWriteKernelFailureDiagnostic, type PostgresMemoryWriteKernelFailureDiagnostic } from "../service/write-kernel-postgres-transaction.js";
import { PostgresEvolutionError } from "./postgres-common.js";
import { EvolutionError } from "./schema.js";

export type EvolutionApplyDiagnosticPhase =
  | "context" | "receipt_read" | "hydrate_evidence" | "target_read" | "proposal_validation"
  | "materialize_evidence" | "proposal_guard" | "source_verification" | "host_guard"
  | "target_lock" | "raw_evidence_lock" | "metadata_apply" | "apply_receipt" | "mark_origin"
  | "command" | "kernel_factory" | "kernel_authority" | "kernel_normalize" | "kernel_embedding_guard"
  | "kernel_embed" | "kernel_validate" | "kernel_admission" | "kernel_importance"
  | "kernel_exact_dedup" | "kernel_semantic_dedup" | "kernel_prepare" | "kernel_transaction"
  | "kernel_ack" | "kernel_result_guard" | "effective_evidence";

export interface EvolutionApplyDiagnostic {
  readonly phase: EvolutionApplyDiagnosticPhase;
  readonly code: PostgresMemoryWriteKernelFailureDiagnostic["code"] | "UNEXPECTED_FAILURE" | "SQL_ERROR"
    | "AUTHORITY_REJECTED" | "INVALID_COMMAND" | "IDEMPOTENCY_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "EVOLUTION_GUARD_REJECTED";
  readonly transactionPhase?: PostgresMemoryWriteKernelFailureDiagnostic["phase"];
  readonly sqlState?: string;
}

/** Host constructor only. Never install from request/config JSON or forward to a public result. */
export type EvolutionApplyDiagnosticObserver = (event: Readonly<EvolutionApplyDiagnostic>) => void;

function classify(error: unknown): Omit<EvolutionApplyDiagnostic, "phase"> {
  const transaction = getPostgresMemoryWriteKernelFailureDiagnostic(error);
  if (transaction) return { code: transaction.code, transactionPhase: transaction.phase, ...(transaction.sqlState ? { sqlState: transaction.sqlState } : {}) };
  if (error instanceof AuthorityScopeError) return { code: "AUTHORITY_REJECTED" };
  if (error instanceof WriteKernelError) {
    switch (error.code) {
      case "AUTHORITY_REJECTED": case "INVALID_COMMAND": case "IDEMPOTENCY_REQUIRED": case "IDEMPOTENCY_CONFLICT": return { code: error.code };
    }
  }
  if (error instanceof PostgresEvolutionError) {
    switch (error.code) {
      case "TRANSACTION_FAILED": case "LOCK_BUSY": case "QUERY_TIMEOUT": return { code: "TRANSACTION_FAILED" };
      case "ROLLBACK_FAILED": return { code: "ROLLBACK_FAILED" };
      case "COMMITTED_CLEANUP_FAILED": return { code: "CLEANUP_FAILED" };
    }
  }
  if (error instanceof EvolutionError || error instanceof PostgresEvolutionError) return { code: "EVOLUTION_GUARD_REJECTED" };
  try {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) return { code: "SQL_ERROR", sqlState: code };
  } catch { /* Provider error accessors must not interfere with receipt recovery. */ }
  return { code: "UNEXPECTED_FAILURE" };
}

/** One instance per apply; concurrent applies never share mutable diagnostic state. */
export class EvolutionApplyDiagnostics {
  phase: EvolutionApplyDiagnosticPhase = "context";
  #reported = false;
  constructor(private readonly observer?: EvolutionApplyDiagnosticObserver) {}

  reportFailure(error: unknown): void {
    if (!this.observer || this.#reported) return;
    this.#reported = true;
    try {
      const event = Object.freeze({ phase: this.phase, ...classify(error) });
      // Do not await host observers, including accidental async implementations.
      void Promise.resolve(this.observer(event)).catch(() => {});
    } catch { /* Diagnostics cannot change transaction or public result semantics. */ }
  }

  async #at<T>(phase: EvolutionApplyDiagnosticPhase, work: () => T): Promise<Awaited<T>> {
    this.phase = phase;
    const result = await work();
    this.phase = "kernel_prepare";
    return result;
  }

  wrapKernel(dependencies: MemoryWriteKernelDependencies): MemoryWriteKernelDependencies {
    if (!this.observer) return dependencies;
    return {
      ...dependencies,
      resolveAuthority: input => this.#at("kernel_authority", () => dependencies.resolveAuthority(input)),
      normalize: input => this.#at("kernel_normalize", () => dependencies.normalize(input)),
      embeddingGuard: input => this.#at("kernel_embedding_guard", () => dependencies.embeddingGuard(input)),
      embed: input => this.#at("kernel_embed", () => dependencies.embed(input)),
      validate: input => this.#at("kernel_validate", () => dependencies.validate(input)),
      scoreAdmission: input => this.#at("kernel_admission", () => dependencies.scoreAdmission(input)),
      scoreImportance: input => this.#at("kernel_importance", () => dependencies.scoreImportance(input)),
      exactDedup: input => this.#at("kernel_exact_dedup", () => dependencies.exactDedup(input)),
      semanticDedup: input => this.#at("kernel_semantic_dedup", () => dependencies.semanticDedup(input)),
      transaction: work => this.#at("kernel_transaction", () => dependencies.transaction(work)),
      ack: input => this.#at("kernel_ack", () => dependencies.ack(input)),
      createId: () => { this.phase = "kernel_prepare"; return dependencies.createId(); },
      now: () => { this.phase = "kernel_prepare"; return dependencies.now(); },
    };
  }
}
