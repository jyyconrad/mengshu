import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { validateHistoryBinding, validateHistorySource, validateHistoryTarget } from "./audit.js";
import { exactObject, historyHash, isCount, isHash, isRef, parseHistoryInput, rejectHistory, verifyHistoryHash } from "./schema.js";
import type { HistoryAuthorization, HistoryNativePort, HistoryNativeSession, HistoryOperationReceipt, HistoryPlan, HistoryPlanUnit, HistoryReadVerification } from "./types.js";
import { HistoryNativeReadVerificationError, reportHistoryDiagnostic, type HistoryDiagnosticObserver } from "./diagnostics.js";

export interface HistoryExecutionPage {
  schema: "mengshu.history-p16-execution/v1";
  action: "apply" | "archive" | "verify" | "rollback";
  runId: string;
  planHash: string;
  receipts: HistoryOperationReceipt[];
  verifications: HistoryReadVerification[];
  visited: number;
  complete: boolean;
  next?: string;
  hash: string;
}
export interface HistoryExecutionOptions {
  includeArchive?: boolean;
  afterUnitId?: string;
  limit?: number;
  signal?: AbortSignal;
  now?: () => number;
  onDiagnostic?: HistoryDiagnosticObserver;
}

export function validateHistoryPlan(plan: HistoryPlan): void {
  verifyHistoryHash(plan);
  exactObject(plan, ["schema", "input", "inputHash", "auditHash", "witnessHash", "units", "sourceDispositions", "unresolvedCount", "held", "outsideCohortRows", "outsideCohortHash", "unrelatedQueueHash", "counts", "hash"], ["knowledgeReviewPlan"]);
  const input = parseHistoryInput(plan.input);
  if (plan.schema !== "mengshu.history-p16-plan/v1" || plan.inputHash !== historyHash(input) || !isHash(plan.auditHash) || !isHash(plan.witnessHash) || !isHash(plan.outsideCohortHash) || !isHash(plan.unrelatedQueueHash) ||
      !isCount(plan.unresolvedCount, Number.MAX_SAFE_INTEGER) || !isCount(plan.outsideCohortRows, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(plan.units) || plan.units.length > input.limits.maxSources * 2 + input.limits.maxTargets * 2 || !Array.isArray(plan.sourceDispositions) || plan.sourceDispositions.length !== input.expected.sources ||
      new Set(plan.sourceDispositions.map(row => row.sourceRef)).size !== plan.sourceDispositions.length) rejectHistory("HISTORY_PLAN_INVALID");
  const declared = new Set(plan.sourceDispositions.map(row => row.sourceRef)), units = new Map<string, HistoryPlanUnit>();
  for (const unit of plan.units) {
    exactObject(unit, ["id", "phase", "scopeFingerprint", "sources", "bindings", "dependencies"], ["target", "canonicalSourceRef", "confidenceCeiling"]);
    const { id, ...body } = unit;
    if (historyHash({ runId: input.runId, parentRunId: input.parentRunId, ...body }) !== id || units.has(id) || !isHash(unit.scopeFingerprint) || !["evidence", "activate", "knowledge", "archive"].includes(unit.phase) ||
        !Array.isArray(unit.sources) || !unit.sources.length || unit.sources.length > input.limits.maxSources || !Array.isArray(unit.bindings) || unit.bindings.length > input.limits.maxBindings || !Array.isArray(unit.dependencies) ||
        unit.dependencies.some(dependency => !units.has(dependency)) || new Set(unit.dependencies).size !== unit.dependencies.length) rejectHistory("HISTORY_PLAN_INVALID");
    for (const source of unit.sources) {
      validateHistorySource(source);
      if (!declared.has(source.sourceRef) || source.scopeFingerprint !== unit.scopeFingerprint || source.currentSemanticHash !== source.beforeSemanticHash || !source.currentRevision) rejectHistory("HISTORY_PLAN_SOURCE_INVALID");
    }
    for (const binding of unit.bindings) {
      validateHistoryBinding(binding);
      if (binding.scopeFingerprint !== unit.scopeFingerprint || !unit.sources.some(source => source.sourceRef === binding.sourceRef && source.sourceHash === binding.sourceHash)) rejectHistory("HISTORY_PLAN_BINDING_INVALID");
    }
    if (unit.target) {
      validateHistoryTarget(unit.target);
      if (authorityScopeFingerprint(unit.target.scope) !== unit.scopeFingerprint || unit.target.pinned || unit.target.tombstoned || !unit.target.current || unit.target.lifecycle !== "pending" || !unit.target.documentMatchesProjection ||
          unit.target.expectedSemanticHash !== unit.target.currentSemanticHash || unit.confidenceCeiling !== unit.target.confidence) rejectHistory("HISTORY_PLAN_TARGET_INVALID");
    }
    if (["evidence", "activate"].includes(unit.phase) && (!unit.target || !unit.bindings.length || unit.bindings.some(binding => !unit.target!.claimIds.includes(binding.claimId) || binding.targetMemoryId !== unit.target!.memoryId))) rejectHistory("HISTORY_PLAN_BINDING_INVALID");
    if (unit.phase === "evidence" && (unit.sources.length !== 1 || new Set(unit.bindings.map(binding => binding.rootEvidenceId)).size !== 1)) rejectHistory("HISTORY_PLAN_BINDING_INVALID");
    if (unit.phase === "activate" && (!unit.dependencies.length || unit.dependencies.some(id => units.get(id)?.phase !== "evidence") || !unit.target!.claimIds.every(claim => unit.bindings.some(binding => binding.claimId === claim)))) rejectHistory("HISTORY_PLAN_DEPENDENCY_INVALID");
    if (unit.phase === "archive" && (!unit.dependencies.length || unit.sources.length !== 1 || unit.dependencies.some(id => !["activate", "knowledge"].includes(units.get(id)!.phase)))) rejectHistory("HISTORY_PLAN_DEPENDENCY_INVALID");
    if (unit.phase === "knowledge" && (unit.sources.length < 2 || !unit.sources.some(source => source.sourceRef === unit.canonicalSourceRef) || unit.sources.some(source => !source.knowledgeIdentity ||
        source.knowledgeIdentity.canonicalSourceRef !== unit.canonicalSourceRef || historyHash(source.knowledgeIdentity) !== historyHash(unit.sources[0].knowledgeIdentity) ||
        source.knowledgeIdentity.sourceSetHash !== historyHash(unit.sources.map(source => ({ sourceRef: source.sourceRef, sourceHash: source.sourceHash })).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)))))) rejectHistory("HISTORY_PLAN_KNOWLEDGE_INVALID");
    units.set(id, unit);
  }
}

function validateAuthorization(plan: HistoryPlan, action: "apply" | "archive" | "rollback", authorization: HistoryAuthorization): void {
  exactObject(authorization, ["token", "reviewReceiptId", "backupReceiptHash", "restoreReceiptHash", "rehearsalReceiptHash", "maintenanceReceiptId", "quiescenceReceiptId"]);
  if (authorization.token !== `P16_${action.toUpperCase()}:${plan.input.runId}:${plan.hash}` ||
      [authorization.reviewReceiptId, authorization.maintenanceReceiptId, authorization.quiescenceReceiptId].some(value => !isRef(value)) ||
      [authorization.backupReceiptHash, authorization.restoreReceiptHash, authorization.rehearsalReceiptHash].some(value => !isHash(value))) rejectHistory("HISTORY_AUTHORIZATION_REQUIRED");
}

export function validateHistoryReceipt(plan: HistoryPlan, unit: HistoryPlanUnit, receipt: HistoryOperationReceipt, status: "committed" | "rolled_back" = "committed"): void {
  verifyHistoryHash(receipt);
  exactObject(receipt, ["id", "runId", "parentRunId", "planHash", "unitId", "phase", "status", "sourceWitnessHash", "affectedRefs", "evidenceMemoryIds", "evidenceRootIds", "beforeStateHash", "afterStateHash", "rollbackRef", "hash"], ["targetRevision"]);
  if (receipt.runId !== plan.input.runId || receipt.parentRunId !== plan.input.parentRunId || receipt.planHash !== plan.hash || receipt.unitId !== unit.id || receipt.phase !== unit.phase || receipt.status !== status ||
      receipt.sourceWitnessHash !== historyHash(unit.sources) || !isRef(receipt.id) || !isRef(receipt.rollbackRef) || !isHash(receipt.beforeStateHash) || !isHash(receipt.afterStateHash) ||
      (receipt.targetRevision !== undefined && !isRef(receipt.targetRevision)) ||
      [receipt.affectedRefs, receipt.evidenceMemoryIds, receipt.evidenceRootIds].some(values => !Array.isArray(values) || values.length > plan.input.limits.maxBindings || values.some(value => !isRef(value)))) rejectHistory("HISTORY_RECEIPT_INVALID");
  const allowed = new Set([...unit.sources.map(source => source.sourceRef), ...(unit.target ? [`memories:${unit.target.memoryId}`, `asset:${unit.target.assetId}`] : []), ...receipt.evidenceMemoryIds.map(id => `memories:${id}`)]);
  if (receipt.affectedRefs.some(ref => !allowed.has(ref))) rejectHistory("HISTORY_RECEIPT_OUTSIDE_COHORT");
  if (unit.bindings.length && (historyHash([...new Set(receipt.evidenceRootIds)].sort()) !== historyHash([...new Set(unit.bindings.map(binding => binding.rootEvidenceId))].sort()) || !receipt.evidenceMemoryIds.length)) rejectHistory("HISTORY_RECEIPT_EVIDENCE_MISSING");
}

async function verifyUnit(session: HistoryNativeSession, plan: HistoryPlan, unit: HistoryPlanUnit, receipt: HistoryOperationReceipt, onDiagnostic?: HistoryDiagnosticObserver): Promise<HistoryReadVerification> {
  const verification = await session.verifyUnit({ plan: structuredClone(plan), unit: structuredClone(unit), receipt: structuredClone(receipt) });
  exactObject(verification, ["unitId", "currentRead", "evidenceRead", "lookupRead", "contextRead", "exactScope", "confidenceNotIncreased", "canonicalIdentityPreserved", "evidenceRootIds", "receiptHash"]);
  const checks = {
    unitIdentity: verification.unitId === unit.id, receiptIdentity: verification.receiptHash === receipt.hash,
    exactScope: verification.exactScope === true, confidenceNotIncreased: verification.confidenceNotIncreased === true, canonicalIdentityPreserved: verification.canonicalIdentityPreserved === true, evidenceRead: verification.evidenceRead === true,
    currentRead: unit.phase === "evidence" || verification.currentRead === true, lookupRead: unit.phase === "evidence" || verification.lookupRead === true, contextRead: unit.phase === "evidence" || verification.contextRead === true,
    evidenceRoots: Array.isArray(verification.evidenceRootIds) && historyHash([...new Set(verification.evidenceRootIds)].sort()) === historyHash([...new Set(receipt.evidenceRootIds)].sort()),
  };
  if (Object.values(checks).some(passed => !passed)) {
    const error = new HistoryNativeReadVerificationError(unit.phase, checks);
    reportHistoryDiagnostic(onDiagnostic, unit.phase, "native-read-verification", error);
    throw error;
  }
  return structuredClone(verification);
}
async function conservation(session: HistoryNativeSession, plan: HistoryPlan): Promise<void> {
  const result = await session.verifyConservation(structuredClone(plan));
  if (result.mappingsComplete !== true || result.outsideCohortUnchanged !== true || result.unrelatedQueueUnchanged !== true) rejectHistory("HISTORY_CONSERVATION_FAILED");
}

async function execute(plan: HistoryPlan, port: HistoryNativePort, action: HistoryExecutionPage["action"], authorization: HistoryAuthorization | undefined, options: HistoryExecutionOptions): Promise<HistoryExecutionPage> {
  validateHistoryPlan(plan);
  if (action !== "verify") {
    if (plan.unresolvedCount && action !== "rollback") rejectHistory("HISTORY_UNEXPLAINED_SOURCES");
    if (!authorization) rejectHistory("HISTORY_AUTHORIZATION_REQUIRED");
    validateAuthorization(plan, action, authorization!);
  }
  const limit = options.limit ?? plan.input.limits.maxBatchUnits;
  if (!isCount(limit, plan.input.limits.maxBatchUnits, 1)) rejectHistory("HISTORY_EXECUTION_BUDGET");
  const ordered = action === "rollback" ? [...plan.units].reverse() : plan.units.filter(unit => action === "apply" ? unit.phase !== "archive" : action === "archive" ? unit.phase === "archive" : options.includeArchive === true || unit.phase !== "archive");
  const start = options.afterUnitId ? ordered.findIndex(unit => unit.id === options.afterUnitId) + 1 : 0;
  if (options.afterUnitId && !start) rejectHistory("HISTORY_CURSOR_INVALID");
  const now = options.now ?? Date.now, started = now();
  const checkBudget = () => { if (options.signal?.aborted || now() - started >= plan.input.limits.maxDurationMs) rejectHistory("HISTORY_EXECUTION_BUDGET"); };
  checkBudget();
  return port.withOperatorLock({ runId: plan.input.runId, parentRunId: plan.input.parentRunId, planHash: plan.hash }, async session => {
    if (authorization && action !== "verify") await session.assertGates({ plan: structuredClone(plan), action, authorization: structuredClone(authorization) });
    await conservation(session, plan);
    const receipts: HistoryOperationReceipt[] = [], verifications: HistoryReadVerification[] = [];
    const selected = ordered.slice(start, start + limit);
    for (const unit of selected) {
      checkBudget();
      let receipt = await session.readReceipt({ runId: plan.input.runId, unitId: unit.id });
      if (action === "verify") {
        if (!receipt) rejectHistory("HISTORY_RECEIPT_MISSING");
        validateHistoryReceipt(plan, unit, receipt!);
        verifications.push(await verifyUnit(session, plan, unit, receipt!, options.onDiagnostic)); receipts.push(receipt!); continue;
      }
      if (action === "rollback") {
        if (!receipt) continue;
        if (receipt.status === "rolled_back") { validateHistoryReceipt(plan, unit, receipt, "rolled_back"); receipts.push(receipt); continue; }
        validateHistoryReceipt(plan, unit, receipt);
        for (const dependent of plan.units.filter(candidate => candidate.dependencies.includes(unit.id))) {
          const dependentReceipt = await session.readReceipt({ runId: plan.input.runId, unitId: dependent.id });
          if (dependentReceipt && dependentReceipt.status !== "rolled_back") rejectHistory("HISTORY_ROLLBACK_DEPENDENT_COMMITTED");
        }
        const before = receipt;
        try { receipt = await session.rollbackUnit({ plan: structuredClone(plan), unit: structuredClone(unit), receipt: structuredClone(before), authorization: structuredClone(authorization!) }); }
        catch (error) {
          try { receipt = await session.readReceipt({ runId: plan.input.runId, unitId: unit.id }); }
          catch (readError) { reportHistoryDiagnostic(options.onDiagnostic, unit.phase, "receipt-recheck", readError, "unavailable"); rejectHistory("HISTORY_ROLLBACK_UNCERTAIN"); }
          reportHistoryDiagnostic(options.onDiagnostic, unit.phase, "receipt-recheck", error, receipt?.status === "rolled_back" ? "recovered" : "missing");
          if (receipt?.status !== "rolled_back") rejectHistory("HISTORY_ROLLBACK_UNCERTAIN");
        }
        validateHistoryReceipt(plan, unit, receipt!, "rolled_back");
        if (receipt!.afterStateHash !== before.beforeStateHash) rejectHistory("HISTORY_ROLLBACK_NOT_RESTORED");
        receipts.push(receipt!); continue;
      }
      if (receipt) { validateHistoryReceipt(plan, unit, receipt); receipts.push(receipt); verifications.push(await verifyUnit(session, plan, unit, receipt, options.onDiagnostic)); continue; }
      const dependencies: HistoryOperationReceipt[] = [];
      for (const id of unit.dependencies) {
        checkBudget();
        const dependency = plan.units.find(candidate => candidate.id === id)!;
        const committed = await session.readReceipt({ runId: plan.input.runId, unitId: id });
        if (!committed) rejectHistory("HISTORY_DEPENDENCY_NOT_COMMITTED");
        validateHistoryReceipt(plan, dependency, committed!);
        verifications.push(await verifyUnit(session, plan, dependency, committed!, options.onDiagnostic)); dependencies.push(committed!);
      }
      try { receipt = await session.applyUnit({ plan: structuredClone(plan), unit: structuredClone(unit), dependencies, authorization: structuredClone(authorization!) }); }
      catch (error) {
        // A lost response is not permission to replay a mutation. The durable receipt is authoritative.
        try { receipt = await session.readReceipt({ runId: plan.input.runId, unitId: unit.id }); }
        catch (readError) { reportHistoryDiagnostic(options.onDiagnostic, unit.phase, "receipt-recheck", readError, "unavailable"); rejectHistory("HISTORY_COMMIT_UNCERTAIN"); }
        reportHistoryDiagnostic(options.onDiagnostic, unit.phase, "receipt-recheck", error, receipt ? "recovered" : "missing");
        if (!receipt) rejectHistory("HISTORY_COMMIT_UNCERTAIN");
      }
      validateHistoryReceipt(plan, unit, receipt!);
      receipts.push(receipt!); verifications.push(await verifyUnit(session, plan, unit, receipt!, options.onDiagnostic));
    }
    await conservation(session, plan);
    const complete = start + selected.length >= ordered.length;
    const body = { schema: "mengshu.history-p16-execution/v1" as const, action, runId: plan.input.runId, planHash: plan.hash, receipts, verifications,
      visited: selected.length, complete, ...(!complete ? { next: selected.at(-1)!.id } : {}) };
    return { ...body, hash: historyHash(body) };
  });
}

export const applyHistory = (plan: HistoryPlan, port: HistoryNativePort, authorization: HistoryAuthorization, options: HistoryExecutionOptions = {}) => execute(structuredClone(plan), port, "apply", authorization, options);
export const archiveHistory = (plan: HistoryPlan, port: HistoryNativePort, authorization: HistoryAuthorization, options: HistoryExecutionOptions = {}) => execute(structuredClone(plan), port, "archive", authorization, options);
export const verifyHistory = (plan: HistoryPlan, port: HistoryNativePort, options: HistoryExecutionOptions = {}) => execute(structuredClone(plan), port, "verify", undefined, options);
export const rollbackHistory = (plan: HistoryPlan, port: HistoryNativePort, authorization: HistoryAuthorization, options: HistoryExecutionOptions = {}) => execute(structuredClone(plan), port, "rollback", authorization, options);
