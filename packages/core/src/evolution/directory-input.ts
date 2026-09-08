import { randomUUID } from "node:crypto";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { DirectorySourceScanner } from "./sources/index.js";
import type { DirectorySourceScannerOptions, SourceRecord, SourceScanReport, SourceSnapshot } from "./sources/types.js";
import { snapshotHash } from "./sources/shared.js";
import { BoundedEvolutionProposalSource } from "./proposal-source.js";
import { evolutionHash, evolutionInputFingerprint } from "./fingerprints.js";
import { EVOLUTION_POLICY_VERSION, EvolutionError } from "./schema.js";
import type { EvolutionCursor, EvolutionInputContext, EvolutionInputPort, EvolutionInputSnapshot, EvolutionInputUnit, EvolutionPage, EvolutionProposal, EvolutionProposalSourcePort, EvolutionRelatedTargetsPort, EvolutionRepository, EvolutionTargetRef } from "./types.js";

const DIRECTORY_PARSING_LIMITS = { maxRecordBytes: 64 * 1024, maxSnippetChars: 4096, maxContextChars: 1024 };

export interface DirectoryEvolutionInputOptions {
  sources: readonly DirectorySourceScannerOptions[];
  repository: EvolutionRepository;
  configFingerprint: string;
  policyVersion?: string;
  readTargets?: EvolutionInputPort["readTargets"];
  resolveTargets?: EvolutionRelatedTargetsPort["resolve"];
}
interface Session {
  scanner: DirectorySourceScanner;
  sourceId: string;
  pending?: { inputCursor: string; report: SourceScanReport; page: EvolutionPage };
  exact?: { unit: EvolutionInputUnit; snapshot: SourceSnapshot };
}
function recordUnit(record: SourceRecord, snapshot: SourceSnapshot): EvolutionInputUnit {
  const prefix = [record.context.heading, record.context.before].filter(Boolean).join("\n");
  const text = `${prefix ? `${prefix}\n` : ""}${record.quote}${record.context.after ? `\n${record.context.after}` : ""}`;
  return {
    id: record.id, scope: record.scope, snapshotHash: snapshot.hash, targets: [],
    ...(record.locator ? { directoryLocator: structuredClone(record.locator) } : {}),
    verificationBudget: { records: 1, files: snapshot.files.length, bytes: snapshot.files.reduce((n, file) => n + file.hashBytes, 0) },
    evidence: [{ id: record.id, sourceId: record.sourceId, revision: record.revisionId, snapshotHash: computeCanonicalContentHash(text), text, scope: record.scope,
      rootEvidenceId: record.independenceGroupId, origin: "external", trust: "untrusted", occurredAt: record.occurredAt,
      contextIncomplete: record.context.incomplete,
      locator: `${record.pathId}:${record.byteStart}-${record.byteEnd}:${record.spanOrEventId}` }],
  };
}
function unitSnapshot(recordId: string, scan: SourceScanReport): SourceSnapshot {
  const record = scan.records.find(r => r.id === recordId);
  const files = scan.snapshot.files.filter(file => file.pathId === record?.pathId);
  if (files.length !== 1) throw new EvolutionError("source_snapshot_missing");
  return { ...scan.snapshot, files, hash: snapshotHash(scan.sourceId, scan.configFingerprint, files) };
}

/** Transient scanner sessions only; durable progress/proposals/receipts belong to the repository. */
export class DirectoryEvolutionInput implements EvolutionInputPort {
  readonly mode = "directory" as const;
  private readonly sessions = new Map<string, Session>();
  private readonly options: DirectoryEvolutionInputOptions;
  constructor(options: DirectoryEvolutionInputOptions) {
    if (new Set(options.sources.map(s => s.binding.sourceId)).size !== options.sources.length) throw new EvolutionError("source_binding_ambiguous");
    this.options = { ...options, sources: structuredClone(options.sources) };
  }
  private binding(context: EvolutionInputContext): DirectorySourceScannerOptions {
    if (context.input.mode !== "directory") throw new EvolutionError("input_mode_invalid");
    const sourceId = context.input.sourceId;
    const binding = this.options.sources.find(source => source.binding.sourceId === sourceId);
    if (!binding) throw new EvolutionError("source_binding_unavailable");
    if (authorityScopeFingerprint(binding.binding.scope) !== authorityScopeFingerprint(context.scope)) throw new EvolutionError("scope_mismatch");
    return binding;
  }
  private async createSession(id: string, context: EvolutionInputContext): Promise<Session> {
    const binding = this.binding(context);
    if (this.sessions.size >= 16) {
      const oldest = this.sessions.keys().next().value!;
      await this.sessions.get(oldest)!.scanner.close();
      this.sessions.delete(oldest);
    }
    const scanner = await DirectorySourceScanner.create(binding);
    const session = { scanner, sourceId: binding.binding.sourceId };
    this.sessions.set(id, session);
    return session;
  }
  async open(context: EvolutionInputContext): Promise<EvolutionInputSnapshot> {
    context.signal?.throwIfAborted();
    const sessionId = randomUUID();
    const session = await this.createSession(sessionId, context);
    return { selectionEpoch: Date.now(), state: { sourceId: session.sourceId, sessionId, scannerFingerprint: session.scanner.configFingerprint } };
  }
  async readPage(context: EvolutionInputContext & { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor; limit: number }): Promise<EvolutionPage> {
    const started = performance.now();
    this.binding(context);
    const state = context.snapshot.state;
    if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.sessionId !== "string" || context.input.mode !== "directory" || state.sourceId !== context.input.sourceId) throw new EvolutionError("source_snapshot_invalid");
    const existing = this.sessions.get(state.sessionId);
    const session = existing ?? await this.createSession(state.sessionId, context);
    if (state.scannerFingerprint !== session.scanner.configFingerprint) throw new EvolutionError("source_config_changed");
    const cursorKey = evolutionHash(context.cursor);
    if (session.pending?.inputCursor === cursorKey) return { ...structuredClone(session.pending.page), bytesRead: 0, filesRead: 0 };
    let cursor: string | undefined;
    if (existing && context.cursor !== null) {
      if (typeof context.cursor !== "object" || Array.isArray(context.cursor) || context.cursor.sessionId !== state.sessionId || typeof context.cursor.scanId !== "string") throw new EvolutionError("source_cursor_invalid");
      cursor = typeof context.cursor.cursor === "string" ? context.cursor.cursor : undefined;
    }
    if (context.limits.maxRecords <= 0 || context.limits.maxFiles <= 0 || context.limits.maxBytes <= 0 || context.limits.maxDurationMs <= 0) return { units: [], nextCursor: context.cursor, complete: false, bytesRead: 0, filesRead: 0, reasons: ["source_budget_exhausted"] };
    const scan = await session.scanner.scan({ cursor, signal: context.signal, limits: { maxRecords: Math.min(1, context.limit, context.limits.maxRecords), maxFiles: context.limits.maxFiles, maxBytes: context.limits.maxBytes, maxDurationMs: Math.max(0, Math.floor(context.limits.maxDurationMs - (performance.now() - started))), ...DIRECTORY_PARSING_LIMITS } });
    const issues = scan.issues.filter(issue => issue.code !== "output_rejected" && !(scan.cursor && issue.code === "max_records"));
    const units = scan.records.map(record => {
      if (!record.locator) throw new EvolutionError("source_locator_unavailable");
      return recordUnit(record, unitSnapshot(record.id, scan));
    });
    const relatedUsage = await this.resolveRelated(units, context, scan.usage.records, scan.usage.bytes, started);
    const page: EvolutionPage = {
      units,
      nextCursor: { sessionId: state.sessionId, scanId: scan.scanId, ...(scan.cursor ? { cursor: scan.cursor } : {}) },
      complete: scan.status === "complete", bytesRead: scan.usage.bytes + relatedUsage.bytes, filesRead: scan.usage.files, recordsRead: scan.usage.records + relatedUsage.records,
      ...(issues.length ? { reasons: [...new Set(issues.map(issue => issue.code))] } : scan.status === "partial" && !scan.cursor ? { reasons: ["source_scan_partial"] } : {}),
    };
    session.pending = { inputCursor: cursorKey, report: scan, page: structuredClone(page) };
    return page;
  }
  private async resolveRelated(units: EvolutionInputUnit[], context: EvolutionInputContext, records: number, bytes: number, started: number): Promise<{ records: number; bytes: number }> {
    let targetRecords = 0;
    let targetBytes = 0;
    for (const unit of units) {
      if (!this.options.resolveTargets) continue;
      context.signal?.throwIfAborted();
      if (performance.now() - started >= context.limits.maxDurationMs) throw new EvolutionError("review_source_budget_exceeded");
      const limit = Math.min(8, context.limits.maxRecords - records - targetRecords);
      const maxBytes = context.limits.maxBytes - bytes - targetBytes;
      if (limit <= 0 || maxBytes <= 0) throw new EvolutionError("related_targets_budget_unavailable");
      const related = await this.options.resolveTargets({ scope: context.scope, evidence: unit.evidence, limit, maxBytes, signal: context.signal });
      context.signal?.throwIfAborted();
      if (performance.now() - started >= context.limits.maxDurationMs) throw new EvolutionError("review_source_budget_exceeded");
      if (!Number.isSafeInteger(related.recordsRead) || related.recordsRead < related.targets.length || related.recordsRead > limit || !Number.isSafeInteger(related.bytesRead) || related.bytesRead < 0 || related.bytesRead > maxBytes) throw new EvolutionError("related_targets_budget_invalid");
      if (related.targets.some(target => authorityScopeFingerprint(target.scope) !== authorityScopeFingerprint(context.scope))) throw new EvolutionError("scope_mismatch");
      unit.targets = related.targets;
      targetRecords += related.recordsRead;
      targetBytes += related.bytesRead;
    }
    return { records: targetRecords, bytes: targetBytes };
  }
  async readProposal(proposal: EvolutionProposal, context: EvolutionInputContext): ReturnType<EvolutionProposalSourcePort["read"]> {
    this.binding(context);
    context.signal?.throwIfAborted();
    if (proposal.scopeFingerprint !== authorityScopeFingerprint(context.scope)) throw new EvolutionError("scope_mismatch");
    if (proposal.configFingerprint !== this.options.configFingerprint || proposal.policyVersion !== (this.options.policyVersion ?? EVOLUTION_POLICY_VERSION)) throw new EvolutionError("config_changed");
    if (proposal.directoryLocator === undefined) {
      const legacy: EvolutionInputPort = { mode: this.mode, open: c => this.open(c), readPage: c => this.readPage(c), verifyUnit: (u, c) => this.verifyUnit(u, c), readTargets: (r, c) => this.readTargets(r, c) };
      return new BoundedEvolutionProposalSource([legacy]).read(proposal, context);
    }
    const locator = proposal.directoryLocator;
    if (!locator || locator.snapshotHash !== proposal.sourceSnapshotHash || locator.record?.id !== proposal.inputUnitId || evolutionHash(locator.parsing) !== evolutionHash(DIRECTORY_PARSING_LIMITS)) throw new EvolutionError("review_source_changed");
    if (context.limits.maxFiles <= 0 || context.limits.maxBytes <= 0 || context.limits.maxRecords <= 0 || context.limits.maxDurationMs <= 0) throw new EvolutionError("review_source_budget_exceeded");
    const started = performance.now();
    const sessionId = randomUUID();
    const session = await this.createSession(sessionId, context);
    try {
      const read = await session.scanner.readRecord(locator, { signal: context.signal, limits: { ...DIRECTORY_PARSING_LIMITS,
        maxRecords: context.limits.maxRecords, maxFiles: context.limits.maxFiles, maxBytes: context.limits.maxBytes,
        maxDurationMs: Math.max(0, Math.floor(context.limits.maxDurationMs - (performance.now() - started))) } });
      if (!read.valid || !read.record) throw new EvolutionError(read.reason?.startsWith("max_") ? "review_source_budget_exceeded" : read.reason === "cancelled" ? "cancelled" : "review_source_changed");
      const snapshot = { sourceId: locator.sourceId, configFingerprint: locator.configFingerprint, hash: locator.snapshotHash, files: [locator.snapshot] };
      const unit = recordUnit(read.record, snapshot);
      const related = await this.resolveRelated([unit], context, read.usage.records, read.usage.bytes, started);
      context.signal?.throwIfAborted();
      if (performance.now() - started >= context.limits.maxDurationMs) throw new EvolutionError("review_source_budget_exceeded");
      session.exact = { unit: structuredClone(unit), snapshot: structuredClone(snapshot) };
      // Exact record verification cannot prove all earlier pages have committed receipts.
      return { unit, filesRead: read.usage.files, recordsRead: read.usage.records + related.records, bytesRead: read.usage.bytes + related.bytes };
    } catch (error) {
      await session.scanner.close();
      this.sessions.delete(sessionId);
      throw error;
    }
  }
  async verifyUnit(unit: EvolutionInputUnit, context: EvolutionInputContext): Promise<{ valid: boolean; reason?: string; bytesRead?: number }> {
    this.binding(context);
    const session = [...this.sessions.values()].reverse().find(s => s.exact?.unit.id === unit.id && s.exact.unit.snapshotHash === unit.snapshotHash || s.pending?.page.units.some(u => u.id === unit.id && u.snapshotHash === unit.snapshotHash));
    if (!session) return { valid: false, reason: "source_snapshot_expired" };
    const expected = session.exact?.unit ?? session.pending!.page.units.find(u => u.id === unit.id)!;
    if (evolutionHash(expected) !== evolutionHash(unit)) return { valid: false, reason: "source_snapshot_changed" };
    if (context.limits.maxFiles < 1 || context.limits.maxRecords < 1) return { valid: false, reason: "source_budget_exhausted", bytesRead: 0 };
    return session.scanner.verifySnapshot(session.exact?.snapshot ?? unitSnapshot(unit.id, session.pending!.report), { maxBytes: context.limits.maxBytes, maxDurationMs: context.limits.maxDurationMs, signal: context.signal });
  }
  async readTargets(refs: EvolutionTargetRef[], context: EvolutionInputContext) {
    this.binding(context);
    if (!refs.length) return [];
    if (!this.options.readTargets) throw new EvolutionError("directory_target_lookup_unsupported");
    return this.options.readTargets(refs, context);
  }
  async acknowledge(context: EvolutionInputContext & { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor; action?: "preview" | "propose" | "apply_allowed"; proposalId?: string }): Promise<void> {
    this.binding(context);
    if (context.action && context.action !== "apply_allowed") return;
    const state = context.snapshot.state;
    if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.sessionId !== "string") return;
    const session = this.sessions.get(state.sessionId);
    if (!session?.pending || evolutionHash(context.cursor) !== evolutionHash(session.pending.page.nextCursor)) return;
    const pending = session.pending;
    // Proposals must not advance the canonical manifest: apply must still see their source input.
    if (pending.page.units.length !== 1) return;
    const unit = pending.page.units[0];
    const fingerprint = evolutionInputFingerprint(unit, this.options.configFingerprint, this.options.policyVersion ?? EVOLUTION_POLICY_VERSION);
    const scope = authorityScopeFingerprint(context.scope);
    const processed = context.proposalId ? undefined : await this.options.repository.findProcessed(scope, fingerprint, "apply_allowed");
    const proposalId = context.proposalId ?? processed?.proposalId;
    if (!proposalId) return;
    const proposal = await this.options.repository.getProposal(proposalId, scope);
    if (!proposal || proposal.inputFingerprint !== fingerprint || proposal.sourceSnapshotHash !== unit.snapshotHash) return;
    if (!proposal.inputPosition || evolutionHash(proposal.inputPosition.snapshot) !== evolutionHash(context.snapshot) || evolutionHash(proposal.inputPosition.cursor) !== pending.inputCursor) return;
    if (proposal.directoryLocator && evolutionHash(proposal.directoryLocator) !== evolutionHash(unit.directoryLocator)) return;
    const receipt = await this.options.repository.getReceipt(proposalId, scope);
    if (!receipt || receipt.proposalId !== proposalId || receipt.batchId !== proposal.batchId || receipt.scopeFingerprint !== scope || receipt.operation !== proposal.operation) return;
    await session.scanner.confirm(pending.report, { receiptId: receipt.id, sourceSnapshotHash: pending.report.sourceSnapshotHash, recordIds: pending.report.records.map(record => record.id) });
  }
  async close(): Promise<void> {
    for (const session of this.sessions.values()) await session.scanner.close();
    this.sessions.clear();
  }
}
