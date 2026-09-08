import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { vectorDimsForModel } from "../../../config.js";
import { PostgresProvider } from "../../../packages/core/src/db/providers/postgres.js";
import { recordToMemoryEntry } from "../../../packages/core/src/domain/legacy-mapping.js";
import type { MemoryRecord, MemoryScope } from "../../../packages/core/src/domain/types.js";
import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { createEmbeddingSpace } from "../../../packages/core/src/domain/embedding-space.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { evolutionHash, evolutionInputFingerprint } from "../../../packages/core/src/evolution/fingerprints.js";
import { MemoryEvolutionBatchService } from "../../../packages/core/src/evolution/batch-service.js";
import { MemoryEvolutionReviewService } from "../../../packages/core/src/evolution/review-service.js";
import { stageEvolutionEvidence, validateEvolutionProposal } from "../../../packages/core/src/evolution/proposal-validation.js";
import { EVOLUTION_POLICY_VERSION, parseEvolutionProposal } from "../../../packages/core/src/evolution/schema.js";
import type { EvolutionInputUnit, EvolutionProposal, EvolutionProposalDraft, EvolutionProposalSourcePort } from "../../../packages/core/src/evolution/types.js";
import { GovernedRetrievalEngine } from "../../../packages/core/src/retrieval/governed-retrieval-engine.js";
import { PostgresEvidenceContentReadPort } from "../../../packages/core/src/graph/postgres-evidence-content-read.js";
import { assertEvolutionOwnerRequest, EVOLUTION_OWNER_HEADER, withAuthenticatedEvolutionOwner } from "../../../packages/api/src/evolution-owner-auth.js";
import { createPostgresEvolutionHostState } from "../../../server/evolution-host-state.js";
import { createEvolutionAttestation } from "../../../server/evolution-attestation.js";
import { provisionEvolutionVerificationSchema } from "../memory-evolution/isolated-postgres.js";
import { ROLLOUT_AUTHORITY, ROLLOUT_SCOPE } from "./source-corpus.js";

export const PG_ROLLOUT_CONFIG = evolutionHash("rollout-pg-metadata-no-model/v1");

interface PgSeedOptions {
  scope?: MemoryScope;
  id?: string;
  sourceId?: string;
  at?: number;
  rawOnly?: boolean;
  expiresAt?: number;
}

/** Shared by live storage and offline native decoder checks; no author attestation. */
export function createPostgresRolloutSeed(text: string, embedding: { embeddingSpaceId: string; vector: number[] }, options: PgSeedOptions = {}) {
  const scope = options.scope ?? ROLLOUT_SCOPE, at = options.at ?? Date.now() - 10_000;
  const rawId = randomUUID(), sourceId = options.sourceId ?? `synthetic-source-${rawId}`;
  const stamp = { embeddingSpaceId: embedding.embeddingSpaceId, embeddingSpaceState: "known-queryable" };
  const raw: MemoryRecord = { id: rawId, scope, text, kind: "observation", container: "session_candidate",
    lifecycleStatus: "archived", contentHash: computeCanonicalContentHash(text), importance: 0.5,
    category: "core", dataType: "memory", sourceNodeIds: [sourceId], createdAt: at - 1, vector: embedding.vector,
    provenance: { source: "synthetic-pg-fixture", sourceId, sessionId: scope.sessionId },
    metadata: { ...stamp, admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate", eventType: "observation",
      ...(options.expiresAt === undefined ? {} : { evolutionEvidence: { sourceEvidenceId: rawId, sourceId, expiresAt: options.expiresAt } }),
      governance: { commandType: "importEvidence", evidenceIds: [sourceId],
        native: { dataType: "memory", kind: "observation", category: "core", container: "session_candidate" },
        provenance: { source: "synthetic-pg-fixture", sourceId, sessionId: scope.sessionId },
        candidate: { phase: "raw_evidence", evidenceOnly: true, sourceId, quote: text } } } };
  const id = options.id ?? randomUUID();
  const canonical: MemoryRecord = { id, scope, text, kind: "fact", container: "session_candidate", lifecycleStatus: "archived",
    contentHash: computeCanonicalContentHash(text), importance: 0.75, confidence: 0.61, category: "fact", dataType: "memory", createdAt: at,
    provenance: { source: "synthetic-pg-fixture", sourceId, sessionId: scope.sessionId }, sourceNodeIds: [rawId], vector: embedding.vector,
    metadata: { ...stamp, admissionRoute: "lookup_only", contextEligible: false, valueScore: 0.65, confidence: 0.61, memoryContainer: "session_candidate",
      governance: { commandType: "observeAuto", evidenceIds: [rawId], native: { dataType: "memory", kind: "fact", category: "fact", container: "session_candidate" },
        candidate: { evidence: { eventIds: [rawId] }, riskFlags: [], targetScope: "project" },
        provenance: { source: "synthetic-pg-fixture", sourceId, sessionId: scope.sessionId } } } };
  return { raw, canonical, rawId, id, sourceId, at, text };
}

/** Actual PG/provider repositories. Seeds/vectors are synthetic, not LLM extraction or content apply. */
export async function openPostgresRollout() {
  if (process.env.MENGSHU_RUN_LIVE_TESTS !== "1") throw new Error("rollout_postgres_requires_explicit_live_opt_in");
  const isolated = await provisionEvolutionVerificationSchema();
  const model = isolated.config.embedding.model ?? "text-embedding-3-small";
  const provider = new PostgresProvider(isolated.postgres, model);
  const pool = new pg.Pool({ ...isolated.postgres, max: 6, options: `-c search_path=${isolated.schema},public` });
  let root: string | undefined;
  const close = async () => {
    try { await provider.close(); }
    finally { try { await pool.end(); } finally { try { await isolated.dispose(); } finally { if (root) await rm(root, { recursive: true, force: true }); } } }
  };
  try {
    root = await mkdtemp(join(tmpdir(), "rollout-native-pg-"));
    await provider.initialize();
    await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
    const space = createEmbeddingSpace({ provider: isolated.config.embedding.provider,
      baseURL: isolated.config.embedding.baseURL ?? "", model, dim: vectorDimsForModel(model), normalization: "none" });
    await provider.registerActiveEmbeddingSpace(space);
    const persistence = provider.createEvolutionPersistence(ROLLOUT_SCOPE);
    await persistence.assertReady();
    if ((await persistence.repository.pool.query("SELECT current_schema() AS schema")).rows[0]?.schema !== isolated.schema) {
      throw new Error("provider_schema_isolation_failed");
    }
    const vector = Array.from({ length: vectorDimsForModel(model) }, (_, index) => index === 0 ? 1 : 0);
    const service = new MemoryEvolutionBatchService({ authority: ROLLOUT_AUTHORITY, scope: ROLLOUT_SCOPE,
      repository: persistence.repository, inputs: [], configFingerprint: PG_ROLLOUT_CONFIG });
    const ownerSecret = randomUUID() + randomUUID();
    const ownerActor = () => ({ ...assertEvolutionOwnerRequest(ROLLOUT_SCOPE), actorId: ROLLOUT_SCOPE.userId,
      authentication: "authenticated_owner" as const });
    const hostState = createPostgresEvolutionHostState({ pool: persistence.repository.pool,
      authority: ROLLOUT_AUTHORITY, scope: ROLLOUT_SCOPE, authorizeOwner: ownerActor });
    const attestation = createEvolutionAttestation({ state: hostState, trustedIssuers: [] });
    return {
      root, provider, pool, persistence, hostState, attestation, scope: ROLLOUT_SCOPE,
      scopeFingerprint: authorityScopeFingerprint(ROLLOUT_SCOPE), close,
      async lease(action: "propose" | "apply_allowed" = "propose") {
        const report = await service.prepare({ input: { mode: "inventory", selection: "baseline" }, action, idempotencyKey: randomUUID() });
        const batch = await persistence.repository.getBatch(report.batchId, authorityScopeFingerprint(ROLLOUT_SCOPE));
        const lease = await persistence.repository.acquireLease(report.batchId, authorityScopeFingerprint(ROLLOUT_SCOPE), "rollout-pg-worker", 120_000);
        if (!lease || !batch) throw new Error("real_pg_lease_required");
        return { lease, batch };
      },
      async seed(text: string, options: PgSeedOptions = {}) {
        const seed = createPostgresRolloutSeed(text, { embeddingSpaceId: space.embeddingSpaceId, vector }, options);
        await provider.store([recordToMemoryEntry(seed.raw)]);
        if (!options.rawOnly) await provider.store([recordToMemoryEntry(seed.canonical)]);
        return seed;
      },
      async lookup(query = "synthetic") {
        const candidates = await provider.createGovernedRetrievalCandidateSource().search({ scope: ROLLOUT_SCOPE, query, limit: 20 });
        return new GovernedRetrievalEngine(provider.createGovernedRetrievalHydrator()).retrieve({ scope: ROLLOUT_SCOPE, intent: "lookup", candidates, minScore: 0 });
      },
      evidenceReader: new PostgresEvidenceContentReadPort(persistence.repository.pool),
      owner<T>(work: () => Promise<T>, authorized = true) {
        return withAuthenticatedEvolutionOwner({ owner: ROLLOUT_SCOPE, secret: ownerSecret,
          headers: authorized ? { [EVOLUTION_OWNER_HEADER]: ownerSecret } : {} }, work);
      },
    };
  } catch (error) { await close(); throw error; }
}

export type PostgresRollout = Awaited<ReturnType<typeof openPostgresRollout>>;
export type PgSeed = Awaited<ReturnType<PostgresRollout["seed"]>>;

export function pgMetadataDraft(unit: EvolutionInputUnit, operation: EvolutionProposalDraft["operation"], now: number): EvolutionProposalDraft {
  return parseEvolutionProposal({ operation, claimClass: "fact", reasonCode: operation === "expire" ? "applicability_ended" : "unchanged",
    targetRefs: unit.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })),
    quotes: unit.evidence.map(evidence => ({ evidenceId: evidence.id, quote: evidence.text, start: 0, end: evidence.text.length })),
    ...(operation === "expire" ? { validTo: now - 1 } : {}),
    ...(["merge_equivalent", "add_evidence"].includes(operation) ? { proposedText: unit.targets[0]?.text, kind: "fact" } : {}) });
}

/** Re-reads original PG rows for every review; no staged quote or mock source reader. Not a RuntimeHost proof. */
export async function prepareMetadataReview(h: PostgresRollout, seeds: PgSeed[], operation: EvolutionProposalDraft["operation"]) {
  const { lease, batch } = await h.lease();
  const original = h.persistence;
  const read = async (): Promise<EvolutionInputUnit> => {
    const units: EvolutionInputUnit[] = [];
    for (const seed of seeds) {
      const page = await original.inventory.readPage(h.scope, { selectionEpoch: Date.now(),
        upperKey: { createdAt: seed.at, memoryId: seed.id }, state: { selectedMemoryId: seed.id } }, undefined, 1, { maxRecords: 30, maxBytes: 131_072 });
      if (page.units.length !== 1) throw new Error("metadata_target_not_readable");
      units.push(page.units[0]);
    }
    const targets = units.flatMap(unit => unit.targets);
    const evidence = [...new Map(units.flatMap(unit => unit.evidence.filter(item => item.origin === "external")).map(item => [item.id, item])).values()];
    const id = `pg-metadata:${seeds.map(seed => seed.id).join(":")}`;
    return { id, scope: h.scope, targets, evidence, snapshotHash: evolutionHash({ targets, evidence }) };
  };
  const unit = await read();
  const source: EvolutionProposalSourcePort = { read: async () => {
    const current = await read();
    return { unit: current, recordsRead: current.targets.length + current.evidence.length, filesRead: 0,
      bytesRead: Buffer.byteLength(JSON.stringify(current)) };
  } };
  const draft = pgMetadataDraft(unit, operation, Date.now());
  const validation = validateEvolutionProposal(draft, unit, h.scope);
  const proposal: EvolutionProposal = { ...draft, id: randomUUID(), batchId: batch.id, scope: h.scope, scopeFingerprint: h.scopeFingerprint,
    inputUnitId: unit.id, sourceSnapshotHash: unit.snapshotHash, inputFingerprint: evolutionInputFingerprint(unit, PG_ROLLOUT_CONFIG, EVOLUTION_POLICY_VERSION),
    configFingerprint: PG_ROLLOUT_CONFIG, policyVersion: EVOLUTION_POLICY_VERSION, validation,
    status: validation.outcome === "allowed" ? "staged" : validation.outcome, createdAt: Date.now() };
  await original.repository.stageProposal(proposal, stageEvolutionEvidence(proposal, unit), lease);
  await original.repository.releaseLease(lease);
  const persistence = h.provider.createEvolutionPersistence(h.scope, { writer: {
    hydrateEvidence: context => original.inventory.hydrateEvidence(h.scope, context.evidence.map(evidence => evidence.id)),
  } });
  const reviews = new MemoryEvolutionReviewService({ authority: ROLLOUT_AUTHORITY, scope: h.scope,
    actor: { ...assertEvolutionOwnerRequest(h.scope), actorId: h.scope.userId, authentication: "authenticated_owner" },
    configFingerprint: PG_ROLLOUT_CONFIG, repository: original.repository, source });
  const service = new MemoryEvolutionBatchService({ authority: ROLLOUT_AUTHORITY, scope: h.scope, repository: original.repository,
    configFingerprint: PG_ROLLOUT_CONFIG, reviews: original.repository, proposalSource: source,
    inputs: [{ mode: "inventory", open: async () => ({ selectionEpoch: Date.now() }),
      readPage: async () => { throw new Error("reviewed_sql_test_must_not_start_a_new_scan"); },
      readTargets: (refs) => original.inventory.readTargets(h.scope, refs),
      verifyUnit: current => original.inventory.verifyEvidence(h.scope, current.evidence) }], writer: persistence.writer });
  const preview = await reviews.preview(proposal.id);
  const approval = await reviews.decide({ reviewId: preview.id, expectedBindingHash: preview.bindingHash, decision: "approve", idempotencyKey: randomUUID() });
  return { proposal, preview, approval, service, persistence };
}
