import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { describe, expect, test, vi } from "vitest";

import { vectorDimsForModel } from "../../config.js";
import { CURRENT_SCHEMA_VERSION } from "../../packages/core/src/db/migrations/schema-migrations.js";
import { PostgresProvider } from "../../packages/core/src/db/providers/postgres.js";
import { recordToMemoryEntry } from "../../packages/core/src/domain/legacy-mapping.js";
import type { MemoryRecord } from "../../packages/core/src/domain/types.js";
import { MemoryEvolutionBatchService } from "../../packages/core/src/evolution/batch-service.js";
import { InventoryEvolutionInput } from "../../packages/core/src/evolution/inventory-input.js";
import { PostgresEvolutionInventoryReadPort } from "../../packages/core/src/evolution/postgres-inventory.js";
import {
  POSTGRES_EVOLUTION_SCHEMA_VERSION,
  type PostgresEvolutionPool,
} from "../../packages/core/src/evolution/postgres-common.js";
import { PostgresEvolutionRepository } from "../../packages/core/src/evolution/postgres-repository.js";
import { PostgresEvolutionGovernedWriter } from "../../packages/core/src/evolution/governed-writer.js";
import { stageEvolutionEvidence, validateEvolutionProposal } from "../../packages/core/src/evolution/proposal-validation.js";
import type { EvolutionApplyContext, EvolutionInputUnit } from "../../packages/core/src/evolution/types.js";
import { PostgresEvidenceContentReadPort } from "../../packages/core/src/graph/postgres-evidence-content-read.js";
import { GovernedRetrievalEngine } from "../../packages/core/src/retrieval/governed-retrieval-engine.js";
import { PostgresGovernedRetrievalHydrator } from "../../packages/core/src/retrieval/postgres-governed-retrieval-hydrator.js";
import { computeCanonicalContentHash } from "../../packages/core/src/scoring/hash-utils.js";
import { MemoryEvolutionService } from "../../packages/core/src/temporal/memory-evolution-service.js";
import { loadGlobalEvolutionConfig } from "../../server/evolution-config.js";
import { createEvolutionRuntime, type EvolutionRuntime } from "../../server/evolution-runtime.js";
import {
  GLOBAL_CONFIG_FINGERPRINT, SCOPE_FINGERPRINT, knownMemoryRecord, repositoryBatch, repositoryProposal,
} from "../fixtures/memory-evolution/evolution-fixtures.js";
import { controlledGlobalModel } from "../fixtures/memory-evolution/controlled-global-model.js";
import { isolatedKindOnlyPolicy } from "../fixtures/memory-evolution/factory-policy.js";
import { testHostEvidenceAttestation } from "../fixtures/memory-evolution/test-host-attestation.js";
import { provisionEvolutionVerificationSchema } from "../fixtures/memory-evolution/isolated-postgres.js";
import {
  AUTHORITY, CANONICAL_TEXT, EVIDENCE_ID, EVIDENCE_TEXT, KNOWN_AT, LINEAGE_ID, MEMORY_ID, SCOPE, SOURCE_ID,
  evidenceRow, retrievalCandidate,
} from "../fixtures/memory-evolution/known-records.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";

function queryPort(pool: pg.Pool): PostgresEvolutionPool {
  const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, params: readonly unknown[] = [],
  ) => {
    const result = await pool.query<Row>(sql, [...params]);
    return { rows: result.rows, rowCount: result.rowCount };
  };
  return {
    query,
    async connect() {
      const client = await pool.connect();
      return {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string, params: readonly unknown[] = [],
        ) {
          const result = await client.query<Row>(sql, [...params]);
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
  };
}

async function canonicalSnapshot(pool: pg.Pool) {
  const memories = await pool.query(`SELECT id::text, text, content_hash, metadata, lifecycle_status,
    lineage_id, revision, valid_from, valid_to, temporal_snapshot FROM memories ORDER BY id`);
  const heads = await pool.query("SELECT * FROM mengshu_memory_lineage_heads ORDER BY scope_fingerprint, lineage_id");
  const evidence = await pool.query("SELECT * FROM mengshu_memory_evidence_links ORDER BY link_id");
  const receipts = await pool.query("SELECT * FROM mengshu_evolution_apply_receipts ORDER BY proposal_id");
  return { memories: memories.rows, heads: heads.rows, evidence: evidence.rows, receipts: receipts.rows };
}

describe.skipIf(!liveEnabled)("memory evolution: isolated PostgreSQL acceptance, no real model", () => {
  test("migration, staged isolation, CAS/fencing and real create/lookup with a test host policy", async () => {
    const isolated = await provisionEvolutionVerificationSchema();
    const embeddingModel = isolated.config.embedding.model ?? "text-embedding-3-small";
    const provider = new PostgresProvider(isolated.postgres, embeddingModel);
    const pool = new pg.Pool({ ...isolated.postgres, options: `-c search_path=${isolated.schema},public` });
    const transport = queryPort(pool);
    try {
      expect((await pool.query("SELECT current_schema() AS schema")).rows[0]!.schema).toBe(isolated.schema);
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(POSTGRES_EVOLUTION_SCHEMA_VERSION);
      expect(await provider.getSchemaContractStatus()).toMatchObject({
        currentVersion: CURRENT_SCHEMA_VERSION, scopeContentHashDedupe: "ready",
      });
      const relations = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'mengshu_evolution_%'",
        [isolated.schema],
      );
      expect(relations.rows.map((row) => row.tablename)).toEqual(expect.arrayContaining([
        "mengshu_evolution_batches", "mengshu_evolution_apply_receipts", "mengshu_evolution_processed_inputs",
      ]));

      const vector = Array.from({ length: vectorDimsForModel(embeddingModel) }, (_, index) => index === 0 ? 1 : 0);
      const embeddingStamp = {
        embeddingSpaceId: `embedding-space:v1:${"a".repeat(64)}`,
        embeddingSpaceState: "known-queryable",
      };
      const raw: MemoryRecord = {
        id: EVIDENCE_ID, scope: SCOPE, kind: "observation", container: "session_candidate",
        lifecycleStatus: "archived", text: EVIDENCE_TEXT, contentHash: computeCanonicalContentHash(EVIDENCE_TEXT),
        importance: 0.5, category: "core", dataType: "memory",
        metadata: { ...evidenceRow().metadata as Record<string, unknown>, ...embeddingStamp },
        provenance: { source: "user", sourceId: SOURCE_ID, sessionId: SCOPE.sessionId },
        sourceNodeIds: [SOURCE_ID], createdAt: KNOWN_AT - 100, vector,
      };
      // Synthetic DB seed only; this bypass does not count as a governed evolution apply.
      await provider.store([recordToMemoryEntry(raw)]);
      const temporal = new MemoryEvolutionService(provider.createTemporalMemoryRepository());
      const canonical = knownMemoryRecord();
      await temporal.bootstrap({
        scope: SCOPE, lineageId: LINEAGE_ID,
        record: { ...canonical, metadata: { ...canonical.metadata, ...embeddingStamp }, vector },
        validFrom: KNOWN_AT, idempotencyKey: "acceptance-bootstrap",
      });
      const retrieval = new GovernedRetrievalEngine(new PostgresGovernedRetrievalHydrator(transport));
      const beforeRecall = await retrieval.retrieve({ intent: "context", scope: SCOPE, candidates: [retrievalCandidate()] });
      expect(beforeRecall.hits).toHaveLength(1);
      expect(beforeRecall.hits[0]!.record).toMatchObject({ id: MEMORY_ID, confidence: 0.72, sourceNodeIds: [EVIDENCE_ID] });
      const evidenceReader = new PostgresEvidenceContentReadPort(transport);
      await expect(evidenceReader.read(SCOPE, [{ ref: EVIDENCE_ID, source: "message" }]))
        .resolves.toEqual([{ ref: EVIDENCE_ID, source: "message", preview: EVIDENCE_TEXT }]);

      const persistence = provider.createEvolutionPersistence(SCOPE);
      await expect(persistence.assertReady()).resolves.toBeUndefined();
      const repository = persistence.repository;
      expect(repository).toBeInstanceOf(PostgresEvolutionRepository);
      expect(persistence.inventory).toBeInstanceOf(PostgresEvolutionInventoryReadPort);
      expect(persistence.writer).toBeInstanceOf(PostgresEvolutionGovernedWriter);
      const model = controlledGlobalModel();
      const service = new MemoryEvolutionBatchService({
        authority: AUTHORITY, scope: SCOPE, configFingerprint: GLOBAL_CONFIG_FINGERPRINT,
        repository, proposer: model.proposer,
        inputs: [new InventoryEvolutionInput(persistence.inventory)],
        writer: persistence.writer,
      });
      const beforeService = await canonicalSnapshot(pool);
      const input = { mode: "inventory", selection: "baseline" } as const;
      expect(await service.run({ input, action: "preview", idempotencyKey: "pg-inventory-preview" }))
        .toMatchObject({ status: "completed", counts: { proposed: 0, applied: 0 } });
      expect(model.completion).not.toHaveBeenCalled();
      expect(await service.run({ input, action: "propose", idempotencyKey: "pg-inventory-propose" }))
        .toMatchObject({ status: "completed", counts: { proposed: 1, review: 1, applied: 0 } });
      expect(await service.run({ input, action: "propose", idempotencyKey: "pg-inventory-rerun" }))
        .toMatchObject({ status: "completed", counts: { proposed: 0, skipped: 1, applied: 0 }, usage: { llmCalls: 0 } });
      expect(model.completion).toHaveBeenCalledTimes(1);
      expect(await canonicalSnapshot(pool)).toEqual(beforeService);

      const falseQuoteModel = controlledGlobalModel((draft) => ({ ...draft,
        quotes: draft.quotes.map((quote) => ({ ...quote, quote: "x".repeat(quote.quote.length) })),
      }));
      const falseQuoteService = new MemoryEvolutionBatchService({
        authority: AUTHORITY, scope: SCOPE,
        configFingerprint: computeCanonicalContentHash("acceptance-host-false-quote-model"),
        repository, proposer: falseQuoteModel.proposer,
        inputs: [new InventoryEvolutionInput(persistence.inventory)], writer: persistence.writer,
      });
      const falseQuoteReport = await falseQuoteService.run({
        input, action: "propose", idempotencyKey: "pg-false-quote",
      });
      expect.soft(falseQuoteReport).toMatchObject({
        status: "completed", counts: { proposed: 1, rejected: 1, applied: 0 },
      });
      expect(falseQuoteModel.completion).toHaveBeenCalledTimes(1);
      const rejectedProposal = await pool.query(
        "SELECT metadata FROM mengshu_candidates WHERE metadata #>> '{evolution,proposal,batchId}' = $1",
        [falseQuoteReport.batchId],
      );
      expect.soft(rejectedProposal.rows).toMatchObject([{ metadata: { evolution: {
        proposal: { validation: { outcome: "rejected", reasons: ["quote_mismatch"] }, quotes: [] }, evidence: [],
      } } }]);
      expect(await canonicalSnapshot(pool)).toEqual(beforeService);

      const batch = repositoryBatch();
      const first = await repository.createBatch(batch);
      expect(first).toEqual({ batch, created: true });
      const lease = await repository.acquireLease(batch.id, SCOPE_FINGERPRINT, "acceptance-owner-1", 60_000);
      expect(lease).toBeDefined();
      if (!lease) throw new Error("Expected exclusive database lease");
      await expect(repository.acquireLease(batch.id, SCOPE_FINGERPRINT, "acceptance-owner-2", 60_000))
        .resolves.toBeUndefined();

      const before = await canonicalSnapshot(pool);
      expect(before.memories).toHaveLength(2);
      expect(before.heads).toHaveLength(1);
      const staged = repositoryProposal(batch);
      await repository.stageProposal(staged.proposal, staged.evidence, lease);
      expect(await canonicalSnapshot(pool)).toEqual(before);
      const stored = await pool.query("SELECT status, confidence, evidence_ids, metadata FROM mengshu_candidates WHERE id = $1", [staged.proposal.id]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({
        status: "pending", confidence: 0, evidence_ids: [],
        metadata: { evolution: { relationState: "staged", evidence: [{ quote: EVIDENCE_TEXT }] } },
      });
      const afterRecall = await retrieval.retrieve({ intent: "context", scope: SCOPE, candidates: [retrievalCandidate()] });
      expect(afterRecall.hits[0]!.record).toEqual(beforeRecall.hits[0]!.record);
      await expect(temporal.current({ scope: SCOPE, lineageId: LINEAGE_ID })).resolves.toMatchObject({
        revision: 1, record: { text: CANONICAL_TEXT, confidence: 0.72, sourceNodeIds: [EVIDENCE_ID] },
      });

      await repository.recordProcessed({
        scopeFingerprint: SCOPE_FINGERPRINT, inputFingerprint: staged.proposal.inputFingerprint,
        action: "propose", proposalId: staged.proposal.id, processedAt: Date.now(),
      }, lease);
      const restarted = provider.createEvolutionPersistence(SCOPE).repository;
      await expect(restarted.getProposal(staged.proposal.id, SCOPE_FINGERPRINT)).resolves.toEqual(staged.proposal);
      await expect(restarted.findProcessed(SCOPE_FINGERPRINT, staged.proposal.inputFingerprint, "propose"))
        .resolves.toMatchObject({ proposalId: staged.proposal.id });
      await expect(restarted.getReceipt(staged.proposal.id, SCOPE_FINGERPRINT)).resolves.toBeUndefined();
      await expect(restarted.createBatch({ ...batch, id: randomUUID() })).resolves.toEqual({ batch, created: false });
      await expect(restarted.createBatch({ ...batch, requestHash: computeCanonicalContentHash("other-request") }))
        .rejects.toThrow("IDEMPOTENCY_CONFLICT");

      const saved = await repository.saveBatch({ ...batch, status: "running" }, 0, lease);
      expect(saved.version).toBe(1);
      await expect(restarted.saveBatch(batch, 0, lease)).rejects.toThrow("STALE_BATCH_OR_LEASE");
      await repository.releaseLease(lease);
      const successor = await restarted.acquireLease(batch.id, SCOPE_FINGERPRINT, "acceptance-owner-2", 60_000);
      expect(successor?.fencingToken).toBeGreaterThan(lease.fencingToken);
      if (!successor) throw new Error("Expected successor database lease");
      await expect(repository.stageProposal(repositoryProposal(batch).proposal, staged.evidence, lease))
        .rejects.toThrow("STALE_LEASE");
      await expect(repository.recordProcessed({
        scopeFingerprint: SCOPE_FINGERPRINT, inputFingerprint: staged.proposal.inputFingerprint,
        action: "propose", proposalId: staged.proposal.id, processedAt: Date.now(),
      }, lease)).rejects.toThrow("STALE_LEASE");
      expect(await canonicalSnapshot(pool)).toEqual(before);

      const writer = provider.createEvolutionPersistence(SCOPE).writer;
      expect(writer.supportedOperations).toEqual(["noop"]);
      const verifySource: EvolutionApplyContext["verifySource"] = async () => {
        const read = await evidenceReader.read(SCOPE, [{ ref: EVIDENCE_ID, source: "message" }]);
        return { valid: read.length === 1 && read[0]!.preview === EVIDENCE_TEXT };
      };
      const reviewContext: EvolutionApplyContext = {
        proposal: staged.proposal, evidence: staged.evidence, authority: AUTHORITY,
        lease: successor, verifySource,
      };
      await expect(writer.apply(reviewContext)).resolves.toMatchObject({
        outcome: "blocked", reason: "owner_review_required",
      });
      const unsupported = repositoryProposal(batch);
      unsupported.proposal = {
        ...unsupported.proposal, operation: "create", targetRefs: [], kind: "fact", status: "staged",
        validation: { outcome: "allowed", reasons: [], reviewRequirement: "none",
          independentEvidenceRootIds: [], contextEligible: false },
      };
      delete unsupported.proposal.semanticType;
      await restarted.stageProposal(unsupported.proposal, unsupported.evidence, successor);
      await expect(writer.apply({ ...reviewContext, ...unsupported })).resolves.toMatchObject({
        outcome: "blocked", reason: "source_hydration_unavailable",
      });
      await expect(restarted.getReceipt(unsupported.proposal.id, SCOPE_FINGERPRINT)).resolves.toBeUndefined();

      const noop = repositoryProposal(batch);
      noop.proposal = {
        ...noop.proposal, operation: "noop", reasonCode: "unchanged", targetRefs: [], status: "noop",
        validation: { outcome: "noop", reasons: ["unchanged"], reviewRequirement: "none",
          independentEvidenceRootIds: [], contextEligible: false },
      };
      await restarted.stageProposal(noop.proposal, noop.evidence, successor);
      const noopContext: EvolutionApplyContext = { ...reviewContext, ...noop };
      const applied = await writer.apply(noopContext);
      expect(applied).toMatchObject({ outcome: "noop", replayed: false,
        receipt: { proposalId: noop.proposal.id, memoryIds: [] } });
      if (applied.outcome !== "noop") throw new Error("Expected a committed database noop receipt");
      expect(await restarted.getReceipt(noop.proposal.id, SCOPE_FINGERPRINT)).toEqual(applied.receipt);
      const replay = await new PostgresEvolutionGovernedWriter({ repository: restarted }).apply(noopContext);
      expect(replay).toEqual({ ...applied, replayed: true });
      const afterNoop = await canonicalSnapshot(pool);
      expect(afterNoop.memories).toEqual(before.memories);
      expect(afterNoop.heads).toEqual(before.heads);
      expect(afterNoop.evidence).toEqual(before.evidence);
      expect(afterNoop.receipts).toHaveLength(1);
      expect((await pool.query("SELECT status, metadata FROM mengshu_candidates WHERE id = $1", [noop.proposal.id])).rows[0])
        .toMatchObject({ status: "approved", metadata: { evolution: { proposal: { status: "noop" } } } });

      const fact = "The audit service stores its logs in the local PostgreSQL database.";
      const factEvidenceId = randomUUID();
      const factMetadata = structuredClone(raw.metadata);
      const factGovernance = factMetadata.governance as { candidate: { quote: string } };
      factGovernance.candidate.quote = fact;
      await provider.store([recordToMemoryEntry({
        ...raw, id: factEvidenceId, text: fact, contentHash: computeCanonicalContentHash(fact), metadata: factMetadata,
      })]);
      const nativeSource = await persistence.inventory.hydrateEvidence(SCOPE, [factEvidenceId]);
      expect(nativeSource).toHaveLength(1);
      expect(nativeSource[0]).toMatchObject({ text: fact, origin: "external", trust: "untrusted" });
      const attest = testHostEvidenceAttestation({ id: factEvidenceId, sourceId: SOURCE_ID,
        revision: nativeSource[0]!.revision, snapshotHash: computeCanonicalContentHash(fact), scope: SCOPE });
      const fullSource = attest(nativeSource);
      const sourceUnit: EvolutionInputUnit = {
        id: factEvidenceId, scope: SCOPE, snapshotHash: computeCanonicalContentHash(fact), targets: [], evidence: fullSource,
      };
      const create = repositoryProposal(batch);
      create.proposal = {
        ...create.proposal, operation: "create", claimClass: "fact", reasonCode: "new_claim", kind: "fact",
        targetRefs: [], proposedText: fact,
        quotes: [{ evidenceId: factEvidenceId, quote: fact, start: 0, end: fact.length }],
        inputUnitId: factEvidenceId, inputFingerprint: computeCanonicalContentHash(`create:${factEvidenceId}`),
        sourceSnapshotHash: sourceUnit.snapshotHash, status: "staged",
      };
      delete create.proposal.semanticType;
      create.proposal.validation = validateEvolutionProposal(create.proposal, sourceUnit, SCOPE);
      create.evidence = stageEvolutionEvidence(create.proposal, sourceUnit);
      expect(create.proposal.validation).toMatchObject({ outcome: "allowed", contextEligible: false });
      const nativeUnit = { ...sourceUnit, evidence: nativeSource };
      const nativeCreate = {
        proposal: { ...create.proposal, id: randomUUID(), status: "review" as const,
          validation: validateEvolutionProposal(create.proposal, nativeUnit, SCOPE) },
        evidence: stageEvolutionEvidence(create.proposal, nativeUnit),
      };
      expect(nativeCreate.proposal.validation).toMatchObject({
        outcome: "review", reasons: ["source_authority_unverified"], reviewRequirement: "owner",
      });
      const native = provider.createEvolutionPersistence(SCOPE, {
        kernelDependencies: (verified) => isolatedKindOnlyPolicy(verified, transport, vector, embeddingStamp),
        writer: { hydrateEvidence: (context) => persistence.inventory.hydrateEvidence(SCOPE, context.evidence.map((source) => source.id)) },
      });
      await restarted.stageProposal(nativeCreate.proposal, nativeCreate.evidence, successor);
      const beforeNativeApply = await canonicalSnapshot(pool);
      await expect(native.writer.apply({ ...reviewContext, ...nativeCreate,
        verifySource: () => persistence.inventory.verifyEvidence(SCOPE, nativeSource),
      })).resolves.toMatchObject({ outcome: "blocked", reason: "owner_review_required" });
      await expect(restarted.getReceipt(nativeCreate.proposal.id, SCOPE_FINGERPRINT)).resolves.toBeUndefined();
      expect(await canonicalSnapshot(pool)).toEqual(beforeNativeApply);

      await restarted.stageProposal(create.proposal, create.evidence, successor);
      const configured = provider.createEvolutionPersistence(SCOPE, {
        kernelDependencies: (verified) => isolatedKindOnlyPolicy(verified, transport, vector, embeddingStamp),
        writer: { hydrateEvidence: async (context) => attest(await persistence.inventory.hydrateEvidence(
          SCOPE, context.evidence.map((source) => source.id),
        )) },
      });
      expect(configured.writer.supportedOperations).toContain("create");
      const createContext: EvolutionApplyContext = {
        ...reviewContext, ...create,
        verifySource: () => persistence.inventory.verifyEvidence(SCOPE, nativeSource),
      };
      const created = await configured.writer.apply(createContext);
      expect(created, JSON.stringify(created)).toMatchObject({ outcome: "applied", replayed: false });
      if (created.outcome !== "applied") throw new Error("Expected the real provider transaction to commit create");
      expect(created.receipt.memoryIds).toHaveLength(1);
      const createdId = created.receipt.memoryIds[0]!;
      expect(await restarted.getReceipt(create.proposal.id, SCOPE_FINGERPRINT)).toEqual(created.receipt);
      await expect(configured.writer.apply(createContext)).resolves.toEqual({ ...created, replayed: true });
      const candidate = { ...retrievalCandidate(), candidateId: "created-fact-candidate",
        authoritativeRecordId: createdId, evidenceIds: [factEvidenceId] };
      const lookup = await retrieval.retrieve({ scope: SCOPE, intent: "lookup", candidates: [candidate] });
      expect(lookup.hits, JSON.stringify(lookup.filtered)).toHaveLength(1);
      expect(lookup.hits[0]!.record).toMatchObject({ id: createdId, text: fact, kind: "fact",
        lifecycleStatus: "archived", sourceNodeIds: [factEvidenceId],
        metadata: { admissionRoute: "lookup_only", contextEligible: false } });
      expect(lookup.hits[0]!.record.semanticType).toBeUndefined();
      await expect(evidenceReader.read(SCOPE, [{ ref: factEvidenceId, source: "message" }]))
        .resolves.toEqual([{ ref: factEvidenceId, source: "message", preview: fact }]);
      expect((await retrieval.retrieve({ scope: SCOPE, intent: "context", candidates: [candidate] })).hits).toEqual([]);
      expect((await pool.query("SELECT count(*)::int AS count FROM memories WHERE text = $1 AND metadata->>'admissionRoute' = 'lookup_only'", [fact])).rows[0]!.count)
        .toBe(1);

      const correctedFact = "The audit service stores its logs in the local SQLite database.";
      const correctionEvidenceId = randomUUID();
      const correctionMetadata = structuredClone(raw.metadata);
      (correctionMetadata.governance as { candidate: { quote: string } }).candidate.quote = correctedFact;
      await provider.store([recordToMemoryEntry({ ...raw, id: correctionEvidenceId, text: correctedFact,
        contentHash: computeCanonicalContentHash(correctedFact), metadata: correctionMetadata })]);
      const correctionEvidence = await persistence.inventory.hydrateEvidence(SCOPE, [correctionEvidenceId]);
      expect(correctionEvidence).toHaveLength(1);
      expect(correctionEvidence[0]!.trust).toBe("untrusted");
      expect(correctionEvidence[0]!.authorizedTargetIds).toBeUndefined();
      const [target] = await persistence.inventory.readTargets(SCOPE, [{
        memoryId: createdId, expectedRevision: 0, beforeHash: computeCanonicalContentHash(fact),
      }]);
      expect(target).toBeDefined();
      if (!target) throw new Error("Expected the newly created canonical target");
      const correctionUnit: EvolutionInputUnit = {
        id: correctionEvidenceId, scope: SCOPE, snapshotHash: computeCanonicalContentHash(correctedFact),
        targets: [target], evidence: correctionEvidence,
      };
      const correction = repositoryProposal(batch);
      correction.proposal = {
        ...correction.proposal, operation: "correct", claimClass: "fact", reasonCode: "explicit_correction",
        kind: "fact", proposedText: correctedFact,
        targetRefs: [{ memoryId: target.memoryId, expectedRevision: target.expectedRevision, beforeHash: target.beforeHash }],
        quotes: [{ evidenceId: correctionEvidenceId, quote: correctedFact, start: 0, end: correctedFact.length }],
        inputUnitId: correctionUnit.id, inputFingerprint: computeCanonicalContentHash(`correct:${correctionEvidenceId}`),
        sourceSnapshotHash: correctionUnit.snapshotHash, status: "review",
      };
      delete correction.proposal.semanticType;
      correction.proposal.validation = validateEvolutionProposal(correction.proposal, correctionUnit, SCOPE);
      correction.evidence = stageEvolutionEvidence(correction.proposal, correctionUnit);
      expect(correction.proposal.validation).toMatchObject({
        outcome: "review", reasons: ["source_authority_unverified"], reviewRequirement: "owner",
      });
      await restarted.stageProposal(correction.proposal, correction.evidence, successor);
      const beforeCorrection = await canonicalSnapshot(pool);
      await expect(native.writer.apply({ ...reviewContext, ...correction,
        verifySource: () => persistence.inventory.verifyEvidence(SCOPE, correctionEvidence),
      })).resolves.toMatchObject({ outcome: "blocked", reason: "owner_review_required" });
      await expect(restarted.getReceipt(correction.proposal.id, SCOPE_FINGERPRINT)).resolves.toBeUndefined();
      expect(await canonicalSnapshot(pool)).toEqual(beforeCorrection);
      expect((await retrieval.retrieve({ scope: SCOPE, intent: "lookup", candidates: [candidate] })).hits[0]!.record.text).toBe(fact);
      await expect(evidenceReader.read(SCOPE, [{ ref: factEvidenceId, source: "message" }]))
        .resolves.toEqual([{ ref: factEvidenceId, source: "message", preview: fact }]);
      await restarted.releaseLease(successor);
    } finally {
      try { await provider.close(); }
      finally {
        try { await pool.end(); }
        finally { await isolated.dispose(); }
      }
    }
  }, 120_000);

  test("provider-owned durable runtime queues bounded proposals and deduplicates explicit resume segments", async () => {
    const isolated = await provisionEvolutionVerificationSchema();
    const root = await mkdtemp(join(tmpdir(), "mengshu-evolution-durable-"));
    const previousHome = process.env.MENGSHU_HOME;
    const embeddingModel = isolated.config.embedding.model ?? "text-embedding-3-small";
    const provider = new PostgresProvider(isolated.postgres, embeddingModel);
    const pool = new pg.Pool({ ...isolated.postgres, options: `-c search_path=${isolated.schema},public` });
    try {
      process.env.MENGSHU_HOME = join(root, "home");
      const sourceRoot = join(root, "source");
      await mkdir(sourceRoot);
      await mkdir(process.env.MENGSHU_HOME);
      await copyFile(new URL("../fixtures/memory-evolution/messages.jsonl", import.meta.url), join(sourceRoot, "messages.jsonl"));
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      const config = loadGlobalEvolutionConfig({ authority: AUTHORITY, scope: SCOPE, hostConfig: {
        ...isolated.config,
        features: { ...isolated.config.features, continuousMemoryEvolution: true },
        evolution: { sources: [{ sourceId: "acceptance-durable-source", root: sourceRoot, parser: "codex-jsonl" }] },
      } });
      const bundle = provider.createDurableJobV2RuntimeBundle({
        clock: Date.now, tokenFactory: randomUUID, backoffMs: () => 10, enableMemoryEvolution: true,
      });
      expect(bundle.handlerTypes).toEqual(["build_tree", "evolve_memory_batch", "extract_candidate", "extract_graph"]);
      const model = controlledGlobalModel();
      const onCommitted = vi.fn();
      const vector = Array.from({ length: vectorDimsForModel(embeddingModel) }, (_, index) => index === 0 ? 1 : 0);
      const createRuntime = () => createEvolutionRuntime({
        runtimeBundle: bundle, authority: AUTHORITY, scope: SCOPE, config, llmClient: model.client,
        kernelDependencies: (verified) => isolatedKindOnlyPolicy(verified, queryPort(pool), vector, {
          embeddingSpaceId: `embedding-space:v1:${"b".repeat(64)}`, embeddingSpaceState: "known-queryable",
        }),
        onCommitted,
      });
      const runtime = createRuntime();
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      const before = await canonicalSnapshot(pool);
      const request = {
        input: { mode: "directory", sourceId: "acceptance-durable-source" }, action: "propose",
        idempotencyKey: "durable-bounded-propose", limits: { maxLlmCalls: 1 },
      } as const;
      const queued = await runtime.capability.run(request);
      expect(queued).toMatchObject({ status: "queued", counts: { proposed: 0, applied: 0 },
        usage: { llmCalls: 0 }, segment: { attempt: 1, usage: { llmCalls: 0 } } });
      await expect(runtime.capability.run(request)).resolves.toEqual(queued);
      expect(model.completion).not.toHaveBeenCalled();
      const jobs = async (batchId: string) => (await pool.query<{ id: string; status: string; payload: { batchId: string; segmentAttempt: number } }>(
        `SELECT id, status, payload FROM mengshu_jobs_v2
         WHERE type = 'evolve_memory_batch' AND payload->>'batchId' = $1
         ORDER BY (payload->>'segmentAttempt')::int`, [batchId],
      )).rows;
      const staged = async () => (await pool.query(
        "SELECT status, confidence, evidence_ids, metadata FROM mengshu_candidates ORDER BY id",
      )).rows;
      const firstJobs = await jobs(queued.batchId);
      expect(firstJobs).toEqual([{ id: expect.any(String), status: "queued",
        payload: { batchId: queued.batchId, segmentAttempt: 1 } }]);
      expect(await staged()).toEqual([]);
      expect(await canonicalSnapshot(pool)).toEqual(before);

      const jobScope = {
        tenantId: SCOPE.tenantId, userId: SCOPE.userId, appId: SCOPE.appId,
        projectId: SCOPE.projectId, agentId: SCOPE.agentId, namespace: SCOPE.namespace, visibility: SCOPE.visibility!,
      };
      const execute = async (current: EvolutionRuntime, id: string) => {
        const lease = await bundle.repository.lease({
          scope: jobScope, owner: "acceptance-durable-worker", leaseMs: 60_000, idAllowlist: [id],
        });
        expect(lease.applied).toBe(1);
        expect(lease.job).toMatchObject({ id, type: "evolve_memory_batch", status: "running", attempts: 1 });
        if (!lease.job?.leaseToken || !lease.job.leaseOwner) throw new Error("Expected a real database job lease");
        const job = lease.job;
        const report = await current.handler(job, { signal: new AbortController().signal, workerId: job.leaseOwner! });
        const completed = await bundle.repository.complete({
          id: job.id, scope: job.scope, owner: job.leaseOwner!, leaseToken: job.leaseToken!, leaseGeneration: job.leaseGeneration,
        });
        expect(completed).toMatchObject({ applied: 1, job: { id, status: "completed" } });
        return { report, job };
      };
      const first = await execute(runtime, firstJobs[0]!.id);
      expect(first.report).toMatchObject({ status: "partial", reasons: expect.arrayContaining(["max_llm_calls"]),
        counts: { proposed: 1, review: 1, applied: 0 }, usage: { llmCalls: 1 }, segment: { attempt: 1 } });
      await expect(runtime.capability.status(queued.batchId)).resolves.toEqual(first.report);
      expect(await staged()).toHaveLength(1);
      expect(model.completion).toHaveBeenCalledTimes(1);
      await expect(runtime.capability.run(request)).resolves.toEqual(first.report);
      expect(await jobs(queued.batchId)).toHaveLength(1);

      const restarted = createRuntime();
      const resumed = await restarted.capability.resume(queued.batchId);
      expect(resumed).toMatchObject({ status: "queued", usage: { llmCalls: 1 },
        segment: { attempt: 2, usage: { llmCalls: 0 } } });
      await expect(restarted.capability.resume(queued.batchId)).resolves.toEqual(resumed);
      expect(model.completion).toHaveBeenCalledTimes(1);
      const resumedJobs = await jobs(queued.batchId);
      expect(resumedJobs).toHaveLength(2);
      expect(resumedJobs[1]).toMatchObject({ status: "queued", payload: { segmentAttempt: 2 } });
      expect(resumedJobs[1]!.id).not.toBe(first.job.id);
      await expect(restarted.handler(first.job, { signal: new AbortController().signal, workerId: "acceptance-durable-worker" }))
        .rejects.toMatchObject({ code: "EVOLUTION_JOB_LEASE_LOST" });
      expect(model.completion).toHaveBeenCalledTimes(1);
      await expect(restarted.capability.status(queued.batchId)).resolves.toEqual(resumed);

      const second = await execute(restarted, resumedJobs[1]!.id);
      expect(second.report).toMatchObject({ status: "completed", usage: { llmCalls: 2 },
        segment: { attempt: 2, usage: { llmCalls: 1 } }, counts: { proposed: 2, review: 2, applied: 0 } });
      await expect(restarted.capability.status(queued.batchId)).resolves.toEqual(second.report);
      await expect(restarted.capability.run(request)).resolves.toEqual(second.report);
      await expect(restarted.capability.resume(queued.batchId)).resolves.toEqual(second.report);
      expect(await jobs(queued.batchId)).toHaveLength(2);
      expect(model.completion).toHaveBeenCalledTimes(2);
      const candidates = await staged();
      expect(candidates).toHaveLength(2);
      for (const candidate of candidates) {
        expect(candidate).toMatchObject({ status: "pending", confidence: 0, evidence_ids: [], metadata: {
          evolution: { relationState: "staged", proposal: { status: "review", validation: { reviewRequirement: "owner" } } },
        } });
        const evidence = candidate.metadata.evolution.evidence as Array<Record<string, unknown>>;
        expect(evidence.length).toBeGreaterThan(0);
        expect(evidence.every(span => typeof span.quote === "string" && !Object.hasOwn(span, "text") && span.trust === "untrusted")).toBe(true);
      }

      const fresh = await restarted.capability.run({ ...request, idempotencyKey: "durable-unchanged-rerun" });
      expect(fresh.status).toBe("queued");
      const freshJobs = await jobs(fresh.batchId);
      expect(freshJobs).toHaveLength(1);
      const third = await execute(restarted, freshJobs[0]!.id);
      expect(third.report).toMatchObject({ status: "completed", usage: { llmCalls: 0 },
        counts: { proposed: 0, skipped: 2, applied: 0 } });
      expect(model.completion).toHaveBeenCalledTimes(2);
      expect(await staged()).toEqual(candidates);
      expect(await canonicalSnapshot(pool)).toEqual(before);
      const applyQueued = await restarted.capability.run({
        ...request, action: "apply_allowed", idempotencyKey: "durable-untrusted-apply",
      });
      expect(applyQueued.status).toBe("queued");
      const applyJobs = await jobs(applyQueued.batchId);
      expect(applyJobs).toHaveLength(1);
      const refused = await execute(restarted, applyJobs[0]!.id);
      expect(refused.report).toMatchObject({ status: "blocked", reasons: ["source_authority_unverified", "owner_review_required"],
        usage: { llmCalls: 0 }, counts: { review: 2, applied: 0 } });
      await expect(restarted.capability.status(applyQueued.batchId)).resolves.toEqual(refused.report);
      expect(model.completion).toHaveBeenCalledTimes(2);
      expect(await canonicalSnapshot(pool)).toEqual(before);
      expect(onCommitted).not.toHaveBeenCalled();
      await expect(readFile(join(process.env.MENGSHU_HOME, "evolution", "sources", SCOPE_FINGERPRINT,
        "acceptance-durable-source", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousHome === undefined) delete process.env.MENGSHU_HOME;
      else process.env.MENGSHU_HOME = previousHome;
      try { await provider.close(); }
      finally {
        try { await pool.end(); }
        finally {
          try { await isolated.dispose(); }
          finally { await rm(root, { recursive: true, force: true }); }
        }
      }
    }
  }, 120_000);
});
