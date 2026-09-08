import { createHash } from "node:crypto";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { resolveAuthorityScope, type AuthorityScope, type ClientAuthorityScopeRequest } from "../../domain/authority-scope.js";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import { MemoryWriteKernel, type MemoryWriteCommand, type MemoryWriteKernelDependencies, type WriteMemoryRecord } from "../../service/write-kernel.js";
import { PostgresMemoryWriteKernelTransactionPort } from "../../service/write-kernel-postgres-transaction.js";
import { writeRecordToMemoryRecord } from "../../service/write-kernel-mapping.js";
import { createWriteIdempotencyIdentity } from "../../service/write-kernel-transaction.js";
import { linkDuplicateEvidenceWithClient } from "../../service/postgres-memory-evidence-link-port.js";
import { PostgresTemporalMemoryRepository } from "../../temporal/postgres-repository.js";
import { executeAuthorityScopedForget } from "../../lifecycle/forget-transaction.js";
import { PostgresForgetTransactionPort, postgresForgetStorageIdempotencyKey } from "../../db/providers/postgres-forget-transaction.js";
import { validateCandidate, type ValidatedCandidate } from "../../lifecycle/candidate-validator.js";
import { decideAdmissionWithBreakdown } from "../../lifecycle/admission-decision.js";
import { PROMPT_INJECTION_PATTERNS } from "../../runtime/llm/extraction-rules.js";
import { PostgresEvidenceContentReadPort } from "../../graph/postgres-evidence-content-read.js";
import { PostgresGovernedRetrievalHydrator } from "../../retrieval/postgres-governed-retrieval-hydrator.js";
import { GovernedRetrievalEngine, type GovernedRetrievalCandidate } from "../../retrieval/governed-retrieval-engine.js";
import { GovernedDocumentReadService } from "../../documents/read-service.js";
import { KnowledgeResourceCapability } from "../../resources/knowledge-resource-capability.js";
import { PostgresKnowledgeResourceRepository } from "../../resources/postgres-knowledge-resource-repository.js";
import { historyHash, rejectHistory } from "./schema.js";
import { validateHistoryPlan } from "./execution.js";
import type { HistoryNativePort, HistoryNativeSession, HistoryOperationReceipt, HistoryPlan, HistoryPlanUnit, HistoryReadVerification } from "./types.js";
import { HistoryPostgresLockedStore, historyClientScope, historyReceiptKey, withHistoryPostgresLock, type HistoryPostgresStoreOptions } from "./postgres-store.js";
import { historyPgScope, type HistoryPgClient } from "./postgres-read.js";
import { HistoryPostgresJournal } from "./postgres-journal.js";
import { historyContentSha256, historyNativeEvidenceId, validateHistoryNativeMaterials, type HistoryNativeMaterials } from "./native-materials.js";
import { insertHistoryRawEvidence, readHistoryAnchoredEvidence } from "./postgres-evidence.js";
import { commitHistoryDocument, HistoryImmutableMarkdownAdapter, PostgresHistoryDocumentRepository } from "./postgres-documents.js";
import { HistoryNativeDiagnostics, type HistoryDiagnosticObserver } from "./diagnostics.js";

export interface PostgresHistoryNativeOptions extends Omit<HistoryPostgresStoreOptions, "nativeMaterialHash"> {
  plan: HistoryPlan;
  materials: HistoryNativeMaterials;
  /** Explicit owner-approved vault roots; no home/config discovery or implicit deployment. */
  vaultRoots: Readonly<Record<string, string>>;
  onDiagnostic?: HistoryDiagnosticObserver;
}
type ContentRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;
const metadata = (memory: MemoryRecord) => ({ ...memory.metadata, kind: memory.kind, ...(memory.semanticType ? { semanticType: memory.semanticType } : {}), confidence: memory.confidence ?? 0,
  memoryContainer: memory.container, sourceNodeIds: memory.sourceNodeIds ?? [], ...(memory.scope.sessionId ? { sessionId: memory.scope.sessionId } : {}) });
const jsonHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isContent = (record: WriteMemoryRecord): ContentRecord => { if (record.mutation !== "content") return rejectHistory("HISTORY_NATIVE_CONTENT_REQUIRED"); return record; };

export function historyRawEvidenceCommand(input: { sourceRef: string; text: string; serverAuthority: AuthorityScope; clientScope: ClientAuthorityScopeRequest; idempotencyKey: string }): Extract<MemoryWriteCommand, { type: "importEvidence" }> {
  return { type: "importEvidence", sourceId: input.sourceRef, kind: "observation", container: "session_candidate", text: input.text, serverAuthority: input.serverAuthority, clientScope: input.clientScope, idempotencyKey: input.idempotencyKey,
    evidenceIds: [input.sourceRef], provenance: { source: "history-curation", sourceId: input.sourceRef } };
}

/** Persist the same governed mirrors in the adopted row and its temporal snapshot. */
export function historyNativeMemoryRecord(record: WriteMemoryRecord): MemoryRecord {
  const memory = writeRecordToMemoryRecord(record);
  return { ...memory, metadata: metadata(memory) };
}

class PostgresHistoryNativeSession implements HistoryNativeSession {
  constructor(private readonly store: HistoryPostgresLockedStore, private readonly options: PostgresHistoryNativeOptions, private readonly diagnostics: HistoryNativeDiagnostics) {}
  private unit(id: string, runId = this.options.plan.input.runId): HistoryPlanUnit {
    this.store.assertOpen();
    const unit = this.options.plan.units.find(unit => unit.id === id);
    if (!unit || runId !== this.options.plan.input.runId) return rejectHistory("HISTORY_NATIVE_UNIT_MISMATCH");
    return unit;
  }
  async assertGates(input: Parameters<HistoryNativeSession["assertGates"]>[0]) {
    if (input.plan.hash !== this.options.plan.hash || input.authorization.reviewReceiptId !== this.options.materials.reviewReceiptId) rejectHistory("HISTORY_NATIVE_REVIEW_MISMATCH");
    return this.store.assertGates(input.plan, input.action, input.authorization);
  }
  async readReceipt(input: Parameters<HistoryNativeSession["readReceipt"]>[0]) { return this.store.readReceipt(this.options.plan, this.unit(input.unitId, input.runId)); }
  verifyConservation(plan: HistoryPlan) { return this.store.conservation(plan); }
  private async sourceScope(unit: HistoryPlanUnit): Promise<MemoryScope> {
    if (unit.target) return unit.target.scope;
    const source = unit.sources.find(source => source.sourceRef === unit.canonicalSourceRef) ?? unit.sources[0];
    if (!source) return rejectHistory("HISTORY_NATIVE_SOURCE_REQUIRED");
    const table = source.sourceRef.startsWith("memories:") ? "memories" : "knowledge";
    const row = (await this.store.client.query(`/* history:source-scope */ SELECT tenant_id,user_id,product_id,canonical_project_id,producer_id,namespace,visibility,workspace_id,metadata->>'sessionId' AS session_id FROM ${table} WHERE id::text=$1`, [source.sourceRef.slice(table.length + 1)])).rows[0];
    if (!row) return rejectHistory("HISTORY_NATIVE_SOURCE_MISSING");
    const scope = historyPgScope(row);
    if (authorityScopeFingerprint(scope) !== unit.scopeFingerprint) rejectHistory("HISTORY_NATIVE_SCOPE_MISMATCH");
    return scope;
  }
  private receipt(plan: HistoryPlan, unit: HistoryPlanUnit, evidenceIds: string[], state: { beforeHash: string; afterHash: string }): HistoryOperationReceipt {
    const body = { id: historyReceiptKey(plan.input.runId, unit.id), runId: plan.input.runId, parentRunId: plan.input.parentRunId, planHash: plan.hash, unitId: unit.id, phase: unit.phase, status: "committed" as const,
      sourceWitnessHash: historyHash(unit.sources), affectedRefs: unit.phase === "evidence" ? evidenceIds.map(id => `memories:${id}`) : unit.phase === "activate" ? [`memories:${unit.target!.memoryId}`, `asset:${unit.target!.assetId}`] : unit.phase === "knowledge" ? [unit.canonicalSourceRef!] : unit.sources.map(source => source.sourceRef),
      evidenceMemoryIds: evidenceIds, evidenceRootIds: [...new Set(unit.bindings.map(binding => binding.rootEvidenceId))].sort(),
      beforeStateHash: state.beforeHash, afterStateHash: state.afterHash, rollbackRef: `history:undo:${unit.id}` };
    return { ...body, hash: historyHash(body) };
  }
  private documentRepository(plan: HistoryPlan, unit: HistoryPlanUnit, journal: HistoryPostgresJournal) {
    const material = this.options.materials.documents.find(document => document.asset.assetId === unit.target?.assetId);
    if (!material) return rejectHistory("HISTORY_DOCUMENT_MATERIAL_MISSING");
    return { material, repository: new PostgresHistoryDocumentRepository(this.store.client, plan, unit, journal, material, this.options.now?.() ?? Date.now()) };
  }
  async applyUnit(input: Parameters<HistoryNativeSession["applyUnit"]>[0]): Promise<HistoryOperationReceipt> {
    return this.diagnostics.run(this.unit(input.unit.id).phase, "native-apply", () => this.applyNativeUnit(input));
  }
  private async applyNativeUnit(input: Parameters<HistoryNativeSession["applyUnit"]>[0]): Promise<HistoryOperationReceipt> {
    const plan = this.options.plan, unit = this.unit(input.unit.id);
    if (input.plan.hash !== plan.hash || historyHash(input.unit) !== historyHash(unit)) rejectHistory("HISTORY_NATIVE_UNIT_MISMATCH");
    await this.assertGates({ plan, action: unit.phase === "archive" ? "archive" : "apply", authorization: input.authorization });
    const scope = await this.sourceScope(unit), authority = this.store.authority(plan, scope);
    const clientScope = historyClientScope(scope);
    const journal = new HistoryPostgresJournal(this.store.client, plan, unit), now = this.options.now?.() ?? Date.now();
    let completed: HistoryOperationReceipt | undefined;
    const guard = async () => { await this.store.assertGates(plan, unit.phase === "archive" ? "archive" : "apply", input.authorization); await this.store.registerRun(plan); await this.store.lockSources(plan, unit); };
    const finish = async (ids: string[]) => {
      const state = await journal.finish(now); completed = this.receipt(plan, unit, ids, state); await this.store.saveReceipt(plan, unit, completed);
    };
    if (unit.phase === "archive") {
      if (unit.sources.length !== 1) rejectHistory("HISTORY_ARCHIVE_UNIT_INVALID");
      const source = unit.sources[0], table = source.sourceRef.startsWith("memories:") ? "memories" : "knowledge", id = source.sourceRef.slice(table.length + 1);
      const native = new PostgresForgetTransactionPort(this.store.borrowedPool());
      await executeAuthorityScopedForget({ transaction: work => native.transaction(async context => {
        await guard(); await journal.capture({ table, keys: { id } });
        const clientKey = historyReceiptKey(plan.input.runId, unit.id), storageKey = postgresForgetStorageIdempotencyKey(scope, clientKey);
        await journal.capture({ table: "mengshu_forget_receipts", keys: { idempotency_key: storageKey } });
        await journal.capture({ table: "mengshu_forget_outbox", keys: { event_id: historyContentSha256(`${storageKey}\0${clientKey}:${id}`) } });
        const result = await work(context); await finish([]); return result;
      }) }, { serverAuthority: authority, clientScope, action: "archive", tableName: table, ids: [id], idempotencyKey: historyReceiptKey(plan.input.runId, unit.id), actor: "history-p16", reason: `verified-reference:${plan.hash}`, now });
    } else {
      const evidenceIds = unit.phase === "evidence" ? [historyNativeEvidenceId(plan, unit)] : input.dependencies.flatMap(receipt => receipt.evidenceMemoryIds);
      const review = this.options.materials.activations.find(review => review.unitId === unit.id);
      const knowledge = this.options.materials.knowledge.find(review => review.unitId === unit.id);
      const frozen = this.options.read.bundle.memories.find(memory => memory.memoryId === unit.target?.memoryId);
      const text = unit.phase === "evidence" ? await readHistoryAnchoredEvidence(this.store, plan, unit) : unit.phase === "knowledge" ? knowledge!.text : String(frozen?.row.text ?? "");
      if (!text || Buffer.byteLength(text) > 1024 * 1024) rejectHistory("HISTORY_NATIVE_TEXT_BUDGET");
      const id = unit.phase === "evidence" ? evidenceIds[0] : unit.phase === "knowledge" ? unit.canonicalSourceRef!.slice("knowledge:".length) : unit.target!.memoryId;
      const beforeMutation = async (_client: HistoryPgClient, inputRecord: WriteMemoryRecord) => {
        const record = isContent(inputRecord); await guard();
        if (record.id !== id || record.text !== text || authorityScopeFingerprint(record.scope) !== unit.scopeFingerprint) rejectHistory("HISTORY_NATIVE_WRITE_MISMATCH");
        await journal.capture({ table: unit.phase === "knowledge" ? "knowledge" : "memories", keys: { id } });
        const identity = createWriteIdempotencyIdentity(scope, historyReceiptKey(plan.input.runId, unit.id));
        await journal.capture({ table: "mengshu_write_receipts", keys: { storage_key: identity.storageKey } });
        await journal.capture({ table: "mengshu_write_outbox", keys: { event_id: historyContentSha256(`memory.written.v1\0${identity.storageKey}\0${id}`) } });
        if (unit.phase === "evidence" && await readHistoryAnchoredEvidence(this.store, plan, unit) !== text) rejectHistory("HISTORY_EVIDENCE_ANCHOR_DRIFT");
        if (unit.phase === "activate") {
          const row = (await this.store.client.query(`/* history:pending-adoption-lock */ SELECT xmin::text AS revision,text,lifecycle_status,temporal_invalidated,temporal_purge_pending,lineage_id,metadata->>'pinned' AS pinned,
            evolution_disputed,evolution_review_due_at FROM memories WHERE id::text=$1 FOR UPDATE`, [id])).rows[0];
          if (!row || row.revision !== unit.target!.revision || row.text !== text || row.lifecycle_status !== "pending" || row.pinned === "true" || row.temporal_invalidated === true || row.temporal_purge_pending === true || row.lineage_id != null || row.evolution_disputed === true || Number(row.evolution_review_due_at) !== 0) rejectHistory("HISTORY_PENDING_ADOPTION_CAS_FAILED");
        }
      };
      const transaction = new PostgresMemoryWriteKernelTransactionPort(this.store.borrowedPool(), async (client, inputRecord) => {
        const record = isContent(inputRecord), memory = historyNativeMemoryRecord(record), storedMetadata = memory.metadata;
        if (unit.phase === "evidence") {
          await insertHistoryRawEvidence(client, memory, unit.sources[0], storedMetadata, now);
          const linkId = jsonHash(["mengshu.memory-evidence-link/v1", unit.scopeFingerprint, unit.target!.memoryId, id, "duplicate_evidence", "write_kernel_dedup"]);
          await journal.capture({ table: "mengshu_memory_evidence_links", keys: { link_id: linkId } });
          const link = await linkDuplicateEvidenceWithClient(client, { scope, targetMemoryId: unit.target!.memoryId, evidenceMemoryId: id, createdAt: now });
          if (link.linkId !== linkId) rejectHistory("HISTORY_EVIDENCE_LINK_CONFLICT");
          await client.query(`/* history:reviewed-reference-provenance */ UPDATE mengshu_memory_evidence_links SET relation_state='reviewed_reference',root_evidence_id=$2,source_id=$3,source_revision=$4,source_current_revision=$4,source_hash=$5,source_kind='historical_observation',source_record_id=$3,independence_group_id=$6 WHERE link_id=$1`,
          [linkId, unit.bindings[0].rootEvidenceId, unit.sources[0].sourceRef, unit.sources[0].currentRevision, unit.sources[0].sourceHash, unit.bindings[0].independenceGroupId]);
        } else if (unit.phase === "knowledge") {
          const identity = unit.sources[0].knowledgeIdentity!;
          if (!knowledge || historyContentSha256(record.text) !== identity.contentHash || record.tableName !== "knowledge" || record.route !== "lookup_only") rejectHistory("HISTORY_KNOWLEDGE_NATIVE_MISMATCH");
          const updated = await client.query(`/* history:native-knowledge-write */ UPDATE knowledge SET text=$2,content_hash=$3,metadata=$4::jsonb,embedding_space_id=NULL,embedding_space_state='unknown-unqueryable',lifecycle_status=$5 WHERE id::text=$1 RETURNING id::text AS id`, [id, memory.text, memory.contentHash, JSON.stringify({ ...storedMetadata, resourceIdentity: identity, embeddingSpaceId: null, embeddingSpaceState: "unknown-unqueryable" }), memory.lifecycleStatus]);
          if (updated.rows[0]?.id !== id) rejectHistory("HISTORY_KNOWLEDGE_NATIVE_FAILED");
        } else {
          if (!record.temporal) rejectHistory("HISTORY_TEMPORAL_REQUIRED");
          const temporal = record.temporal;
          await journal.capture({ table: "mengshu_memory_lineage_heads", keys: { scope_fingerprint: unit.scopeFingerprint, lineage_id: temporal.lineageId } });
          await journal.capture({ table: "mengshu_memory_version_transition_receipts", keys: { scope_fingerprint: unit.scopeFingerprint, idempotency_key: temporal.receipt.idempotencyKey } });
          await journal.capture({ table: "mengshu_memory_version_outbox", keys: { event_id: jsonHash(["mengshu.memory-version-outbox/v1", unit.scopeFingerprint, temporal.receipt.id, "memory.version.created"]) } });
          const repository = new PostgresTemporalMemoryRepository({ ...this.store.borrowedPool(), query: this.store.client.query.bind(this.store.client) }, {
            persistVersion: async (client, version) => {
              if (version.record.id !== id || version.record.text !== text || version.revision !== 1 || authorityScopeFingerprint(version.record.scope) !== unit.scopeFingerprint) rejectHistory("HISTORY_PENDING_ADOPTION_INVALID");
              const adopted = await client.query(`/* history:native-pending-adoption */ UPDATE memories SET metadata=metadata || $2::jsonb WHERE id::text=$1 AND xmin::text=$3 AND lifecycle_status='pending' AND lineage_id IS NULL RETURNING id::text AS id`, [id, JSON.stringify(storedMetadata), unit.target!.revision]);
              if (adopted.rows[0]?.id !== id) rejectHistory("HISTORY_PENDING_ADOPTION_CAS_FAILED");
              return { memoryId: id, stored: true };
            },
          });
          await repository.appendVersionWithClient(client, { scope, expectedHeadRevision: 0, version: { lineageId: temporal.lineageId, revision: 1, record: memory, validFrom: temporal.validFrom, recordedAt: now, transitionType: "created", invalidated: false, activationState: "active" }, receipt: temporal.receipt });
          const document = this.documentRepository(plan, unit, journal);
          await commitHistoryDocument(document.repository, document.material, new HistoryImmutableMarkdownAdapter(this.options.vaultRoots), historyReceiptKey(plan.input.runId, unit.id));
        }
        return { memoryId: id, stored: true };
      }, { beforeMutation: (client, record) => this.diagnostics.run(unit.phase, "native-guard", () => beforeMutation(client, record)), afterReceipt: () => this.diagnostics.run(unit.phase, "native-receipt", () => finish(evidenceIds)) });
      const command: MemoryWriteCommand = unit.phase === "evidence"
        ? historyRawEvidenceCommand({ sourceRef: unit.sources[0].sourceRef, text, serverAuthority: authority, clientScope, idempotencyKey: historyReceiptKey(plan.input.runId, unit.id) })
        : { type: "saveExplicit", kind: unit.phase === "knowledge" ? "knowledge" : unit.target!.kind!, ...(unit.target?.semanticType ? { semanticType: unit.target.semanticType } : {}), text, serverAuthority: authority, clientScope, idempotencyKey: historyReceiptKey(plan.input.runId, unit.id), evidenceIds, ...(unit.phase === "knowledge" ? { dataType: "knowledge", tableName: "knowledge" } : {}), provenance: { source: "history-curation", sourceId: unit.target?.assetId ?? unit.canonicalSourceRef } };
      const dependencies: MemoryWriteKernelDependencies = {
        temporalMemoryEnabled: unit.phase === "activate", temporalLookupOnlyEnabled: true,
        resolveAuthority: ({ serverAuthority, clientScope }) => resolveAuthorityScope(serverAuthority as AuthorityScope, clientScope),
        normalize: () => ({ text, metadata: { ...(unit.phase === "activate" ? frozen?.row.metadata as Record<string, unknown> ?? {} : {}), eventType: "observation", historyP16: { runId: plan.input.runId, unitId: unit.id, planHash: plan.hash, authorVerified: false }, ...(scope.sessionId ? { sessionId: scope.sessionId } : {}) }, promptRisk: PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(text)) }),
        // Evidence is not vector-queryable; pending adoption preserves its existing vector in SQL.
        embeddingGuard: async () => {
          if (unit.phase !== "activate") return { ok: true };
          const result = await this.store.client.query(`/* history:embedding-adoption-guard */ SELECT m.id::text AS id FROM memories m
            JOIN mengshu_active_embedding_space active ON active.singleton_key='active' AND active.embedding_space_id=m.embedding_space_id
            JOIN mengshu_embedding_spaces space ON space.embedding_space_id=active.embedding_space_id
            WHERE m.id::text=$1 AND m.xmin::text=$2 AND m.vector IS NOT NULL AND vector_dims(m.vector)=space.dimensions
              AND m.embedding_space_state IN ('known-queryable','reembedded') AND space.state IN ('known-queryable','reembedded')`, [id, unit.target!.revision]);
          return result.rows.length === 1 ? { ok: true } : { ok: false, reason: "history_embedding_space_mismatch" };
        }, embed: async () => [],
        validate: async () => {
          if (unit.phase === "evidence") return { accepted: true, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: text, sourceId: unit.sources[0].sourceRef } };
          if (PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(text)) || text.replace(/\s/g, "").length < 8) return { accepted: false, reason: "history_text_policy_rejected" };
          if (unit.phase === "knowledge" || !unit.target?.semanticType) return { accepted: true, candidate: { compatibility: "kind_only_explicit", text, rejected: false, confidence: 0, evidence: { quote: text, eventIds: evidenceIds }, targetScope: scope.sessionId ? "session" : "project", riskFlags: [], evidenceOnly: false } };
          if (!review?.candidate) return { accepted: false, reason: "history_candidate_review_required" };
          const sourceText = await readHistoryAnchoredEvidence(this.store, plan, unit);
          const verdict = validateCandidate({ ...review.candidate, evidence: { ...review.candidate.evidence, eventIds: evidenceIds } }, { text: sourceText, scope: scope.sessionId ? "session" : "project", eventIds: evidenceIds });
          if (verdict.rejected || verdict.evidenceOnly || verdict.semanticType !== unit.target.semanticType) return { accepted: false, reason: "history_native_validator_rejected" };
          // Unknown independence/authorship cannot accumulate confidence from repeated roots.
          return { accepted: true, candidate: { ...verdict, confidence: 0, historicalConfidenceCeiling: Math.min(review.confidenceCeiling, unit.target.confidence) } };
        },
        scoreAdmission: ({ candidate }) => {
          if (unit.phase === "evidence") return { route: "evidence_only", valueScore: 0, reason: "raw_evidence_before_candidate_admission" };
          if (unit.phase === "knowledge" || !unit.target?.semanticType) return { route: "lookup_only", valueScore: 0, reason: "history_reviewed_reference" };
          const verdict = decideAdmissionWithBreakdown(candidate as unknown as ValidatedCandidate, { intent: "auto", hasConflict: false });
          if (review!.route === "active" && verdict.route !== "active") return { ...verdict, route: "drop", reason: "history_native_active_admission_required" };
          return { ...verdict, route: review!.route, reason: review!.route === "lookup_only" ? "history_reviewed_reference" : verdict.reason };
        },
        scoreImportance: () => Number(frozen?.row.importance ?? 0), exactDedup: () => ({ duplicate: false }), semanticDedup: () => ({ duplicate: false }),
        transaction: transaction.transaction.bind(transaction), ack: () => {}, createId: () => id, now: () => now,
      };
      const result = await new MemoryWriteKernel(dependencies).execute(command);
      if (result.status !== "persisted" || result.memoryId !== id) rejectHistory("HISTORY_NATIVE_WRITE_REJECTED");
    }
    if (!completed) return rejectHistory("HISTORY_NATIVE_RECEIPT_MISSING");
    return completed;
  }

  async verifyUnit(input: Parameters<HistoryNativeSession["verifyUnit"]>[0]): Promise<HistoryReadVerification> {
    const unit = this.unit(input.unit.id), plan = this.options.plan, receipt = input.receipt, scope = await this.sourceScope(unit);
    const journal = new HistoryPostgresJournal(this.store.client, plan, unit);
    const stateMatches = await journal.verify(receipt);
    let evidenceRead = receipt.evidenceMemoryIds.length === 0, currentRead = false, lookupRead = false, contextRead = false, confidenceNotIncreased = true;
    if (receipt.evidenceMemoryIds.length) {
      let found = 0;
      for (let offset = 0; offset < receipt.evidenceMemoryIds.length; offset += 50) {
        const result = await new PostgresEvidenceContentReadPort(this.store.client).read(scope, receipt.evidenceMemoryIds.slice(offset, offset + 50).map(ref => ({ source: "memory" as const, ref })));
        found += result.length;
      }
      evidenceRead = found === receipt.evidenceMemoryIds.length;
    }
    if (unit.phase === "activate") {
      const candidate: GovernedRetrievalCandidate = { candidateId: unit.target!.memoryId, authoritativeRecordId: unit.target!.memoryId, scope, source: "vector", nodeType: "memory", relevance: 1, evidenceIds: receipt.evidenceMemoryIds };
      const hydrator = new PostgresGovernedRetrievalHydrator(this.store.client), engine = new GovernedRetrievalEngine(hydrator);
      const hydrated = await hydrator.hydrate({ scope, authoritativeRecordId: candidate.authoritativeRecordId, candidates: [candidate] });
      const lookup = await engine.retrieve({ intent: "lookup", scope, candidates: [candidate], minScore: 0, limit: 1 });
      const context = await engine.retrieve({ intent: "context", scope, candidates: [candidate], minScore: 0, limit: 1 });
      const route = this.options.materials.activations.find(review => review.unitId === unit.id)!.route;
      const document = this.documentRepository(plan, unit, journal);
      const read = await new GovernedDocumentReadService({ repository: document.repository }).read(scope, unit.target!.assetId);
      currentRead = !!hydrated && read.kind !== "filtered";
      lookupRead = lookup.hits.some(hit => hit.record.id === unit.target!.memoryId);
      contextRead = (context.hits.some(hit => hit.record.id === unit.target!.memoryId)) === (route === "active" && unit.target!.semanticType !== undefined);
      confidenceNotIncreased = hydrated !== undefined && (hydrated.record.confidence ?? 0) <= unit.target!.confidence;
    } else if (unit.phase === "knowledge") {
      const identity = unit.sources[0].knowledgeIdentity!;
      const id = unit.canonicalSourceRef!.slice("knowledge:".length);
      const row = (await this.store.client.query(`/* history:knowledge-authoritative-read */ SELECT content_hash AS revision,encode(sha256(convert_to(text,'UTF8')),'hex') AS content_hash,metadata->'resourceIdentity' AS identity,metadata->>'contextEligible' AS context_eligible,metadata->>'admissionRoute' AS route FROM knowledge WHERE id::text=$1`, [id])).rows[0];
      const resource = row && await new KnowledgeResourceCapability(new PostgresKnowledgeResourceRepository(this.store.client), { timeoutMs: 5000 }).read(scope, { ref: id, revision: String(row.revision), maxChars: 1 });
      const candidate: GovernedRetrievalCandidate = { candidateId: id, authoritativeRecordId: id, scope, source: "vector", nodeType: "memory", relevance: 1, evidenceIds: [] };
      const context = await new GovernedRetrievalEngine(new PostgresGovernedRetrievalHydrator(this.store.client)).retrieve({ intent: "context", scope, candidates: [candidate], minScore: 0, limit: 1 });
      currentRead = row?.content_hash === identity.contentHash && historyHash(row?.identity) === historyHash(identity);
      lookupRead = currentRead && row?.route === "lookup_only" && resource?.resource?.ref === id;
      contextRead = currentRead && row?.context_eligible === "false" && context.hits.length === 0;
    } else if (unit.phase === "archive") {
      const source = unit.sources[0], table = source.sourceRef.startsWith("memories:") ? "memories" : "knowledge";
      const id = source.sourceRef.slice(table.length + 1);
      const row = (await this.store.client.query(`/* history:archive-authoritative-read */ SELECT lifecycle_status,content_hash FROM ${table} WHERE id::text=$1`, [id])).rows[0];
      const candidate: GovernedRetrievalCandidate = { candidateId: id, authoritativeRecordId: id, scope, source: "vector", nodeType: "memory", relevance: 1, evidenceIds: [] };
      const engine = new GovernedRetrievalEngine(new PostgresGovernedRetrievalHydrator(this.store.client));
      const context = await engine.retrieve({ intent: "context", scope, candidates: [candidate], minScore: 0, limit: 1 });
      currentRead = row?.lifecycle_status === "archived";
      if (table === "knowledge" && row) {
        const resource = await new KnowledgeResourceCapability(new PostgresKnowledgeResourceRepository(this.store.client), { timeoutMs: 5000 }).read(scope, { ref: id, revision: String(row.content_hash), maxChars: 1 });
        lookupRead = resource.resource?.ref === id || resource.warnings.includes("knowledge_resource_not_found");
      } else {
        const lookup = await engine.retrieve({ intent: "lookup", scope, candidates: [candidate], minScore: 0, limit: 1 });
        // Cold references may remain readable, but never as an active canonical/context claim.
        lookupRead = lookup.hits.every(hit => hit.record.lifecycleStatus === "archived");
      }
      contextRead = currentRead && context.hits.length === 0;
    }
    const unchangedDuringRead = stateMatches && await journal.verify(receipt);
    return { unitId: unit.id, currentRead, evidenceRead, lookupRead, contextRead, exactScope: unchangedDuringRead && authorityScopeFingerprint(scope) === unit.scopeFingerprint, confidenceNotIncreased,
      canonicalIdentityPreserved: unchangedDuringRead, evidenceRootIds: [...receipt.evidenceRootIds], receiptHash: receipt.hash };
  }
  async rollbackUnit(input: Parameters<HistoryNativeSession["rollbackUnit"]>[0]): Promise<HistoryOperationReceipt> {
    return this.diagnostics.run(this.unit(input.unit.id).phase, "native-rollback", () => this.rollbackNativeUnit(input));
  }
  private async rollbackNativeUnit(input: Parameters<HistoryNativeSession["rollbackUnit"]>[0]): Promise<HistoryOperationReceipt> {
    const plan = this.options.plan, unit = this.unit(input.unit.id);
    await this.assertGates({ plan, action: "rollback", authorization: input.authorization });
    await this.store.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      await this.assertGates({ plan, action: "rollback", authorization: input.authorization });
      const journal = new HistoryPostgresJournal(this.store.client, plan, unit), afterStateHash = await journal.rollback(input.receipt);
      const { hash: _hash, ...original } = input.receipt;
      const body = { ...original, status: "rolled_back" as const, afterStateHash }, receipt = { ...body, hash: historyHash(body) };
      const saved = await this.store.client.query(`/* history:rollback-receipt-cas */ UPDATE mengshu_evolution_operation_receipts SET receipt=$4::jsonb WHERE scope_fingerprint=$1 AND idempotency_key=$2 AND receipt->>'hash'=$3 RETURNING idempotency_key`, [unit.scopeFingerprint, historyReceiptKey(plan.input.runId, unit.id), input.receipt.hash, JSON.stringify(receipt)]);
      if (saved.rows.length !== 1) rejectHistory("HISTORY_ROLLBACK_RECEIPT_CONFLICT");
      await this.store.client.query("COMMIT"); return receipt;
    } catch (error) { await this.store.client.query("ROLLBACK"); throw error; }
  }
}

export class PostgresHistoryNativePort implements HistoryNativePort {
  private readonly options: PostgresHistoryNativeOptions;
  constructor(options: PostgresHistoryNativeOptions) {
    validateHistoryPlan(options.plan);
    this.options = { ...options, plan: structuredClone(options.plan), materials: validateHistoryNativeMaterials(options.materials, options.plan, options.read.bundle), vaultRoots: { ...options.vaultRoots }, approvedOperations: structuredClone(options.approvedOperations) };
  }
  withOperatorLock<T>(input: Parameters<HistoryNativePort["withOperatorLock"]>[0], work: (session: HistoryNativeSession) => Promise<T>): Promise<T> {
    if (input.planHash !== this.options.plan.hash || input.runId !== this.options.plan.input.runId || input.parentRunId !== this.options.plan.input.parentRunId) return Promise.reject(new Error("HISTORY_NATIVE_PLAN_MISMATCH"));
    const diagnostics = new HistoryNativeDiagnostics(this.options.onDiagnostic);
    const pool = { connect: async () => diagnostics.client(await this.options.pool.connect()) };
    return withHistoryPostgresLock({ ...this.options, pool, nativeMaterialHash: this.options.materials.hash }, input, store => work(new PostgresHistoryNativeSession(store, this.options, diagnostics)));
  }
}
export const createPostgresHistoryNativePort = (options: PostgresHistoryNativeOptions): PostgresHistoryNativePort => new PostgresHistoryNativePort(options);
