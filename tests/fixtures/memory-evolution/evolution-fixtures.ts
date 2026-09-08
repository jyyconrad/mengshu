import { randomUUID } from "node:crypto";

import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryRecord } from "../../../packages/core/src/domain/types.js";
import type {
  EvolutionBatch,
  EvolutionInputUnit,
  EvolutionProposal,
  EvolutionProposalDraft,
  EvolutionStagedEvidence,
} from "../../../packages/core/src/evolution/types.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import {
  CANONICAL_TEXT, EVIDENCE_ID, EVIDENCE_TEXT, KNOWN_AT, MEMORY_ID, SCOPE, SOURCE_ID, memoryRow,
} from "./known-records.js";

export const SCOPE_FINGERPRINT = authorityScopeFingerprint(SCOPE);
export const GLOBAL_CONFIG_FINGERPRINT = computeCanonicalContentHash("acceptance-host-global-model-v1");

export function knownMemoryRecord(): MemoryRecord {
  return {
    id: MEMORY_ID, scope: SCOPE, kind: "decision", semanticType: "rules", container: "project",
    lifecycleStatus: "active", text: CANONICAL_TEXT,
    contentHash: computeCanonicalContentHash(CANONICAL_TEXT), importance: 0.81, confidence: 0.72,
    category: "decision", dataType: "memory",
    metadata: memoryRow().metadata as Record<string, unknown>,
    provenance: { source: "user", sourceId: SOURCE_ID, sessionId: SCOPE.sessionId, createdAt: KNOWN_AT },
    sourceNodeIds: [EVIDENCE_ID], createdAt: KNOWN_AT,
  };
}

export function knownInventoryUnit(): EvolutionInputUnit {
  return {
    id: MEMORY_ID, scope: SCOPE, snapshotHash: computeCanonicalContentHash(CANONICAL_TEXT),
    targets: [{
      memoryId: MEMORY_ID, expectedRevision: 1, beforeHash: computeCanonicalContentHash(CANONICAL_TEXT),
      text: CANONICAL_TEXT, scope: SCOPE, kind: "decision", semanticType: "rules",
      createdAt: KNOWN_AT, evidenceRootIds: [SOURCE_ID],
    }],
    evidence: [{
      id: EVIDENCE_ID, sourceId: SOURCE_ID, revision: "1",
      snapshotHash: computeCanonicalContentHash(EVIDENCE_TEXT), text: EVIDENCE_TEXT,
      scope: SCOPE, rootEvidenceId: SOURCE_ID, origin: "canonical", trust: "untrusted",
      authorizedTargetIds: [MEMORY_ID], occurredAt: KNOWN_AT - 100,
    }],
  };
}

export function exactQuoteDraft(unit: EvolutionInputUnit): EvolutionProposalDraft {
  const source = unit.evidence[0]!;
  return {
    operation: unit.targets.length ? "evolve" : "create",
    claimClass: unit.targets.length ? "constraint" : "fact",
    reasonCode: unit.targets.length ? "attribute_changed" : "new_claim",
    targetRefs: unit.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({
      memoryId, expectedRevision, beforeHash,
    })),
    quotes: [{ evidenceId: source.id, quote: source.text, start: 0, end: source.text.length }],
    proposedText: source.text,
    kind: unit.targets.length ? "decision" : "fact",
    ...(unit.targets.length ? { semanticType: "rules" as const } : {}),
  };
}

export function repositoryBatch(): EvolutionBatch {
  const now = Date.now();
  return {
    id: randomUUID(), scope: SCOPE, scopeFingerprint: SCOPE_FINGERPRINT,
    request: {
      input: { mode: "inventory", selection: "baseline" }, action: "apply_allowed", idempotencyKey: randomUUID(),
      limits: { maxRecords: 5, maxFiles: 5, maxBytes: 10_000, maxLlmCalls: 5,
        maxInputTokens: 10_000, maxOutputTokens: 1_000, maxDurationMs: 30_000 },
    },
    requestHash: computeCanonicalContentHash(randomUUID()), configFingerprint: GLOBAL_CONFIG_FINGERPRINT,
    policyVersion: "acceptance-v1", status: "queued", reasons: [], cursor: null,
    usage: { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
    counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
    createdAt: now, updatedAt: now, version: 0,
  };
}

export function repositoryProposal(batch: EvolutionBatch): {
  proposal: EvolutionProposal;
  evidence: EvolutionStagedEvidence[];
} {
  const unit = knownInventoryUnit();
  const draft = exactQuoteDraft(unit);
  return {
    proposal: {
      ...draft, id: randomUUID(), batchId: batch.id, scope: SCOPE, scopeFingerprint: SCOPE_FINGERPRINT,
      inputUnitId: unit.id, inputFingerprint: computeCanonicalContentHash(JSON.stringify(unit)),
      sourceSnapshotHash: unit.snapshotHash, configFingerprint: GLOBAL_CONFIG_FINGERPRINT,
      policyVersion: batch.policyVersion, validation: {
        outcome: "review", reasons: ["acceptance_staged_only"], reviewRequirement: "owner",
        independentEvidenceRootIds: [], contextEligible: false,
      },
      status: "review", createdAt: Date.now(),
    },
    evidence: unit.evidence.map(({ text, ...source }) => ({ ...source, quote: text, start: 0, end: text.length })),
  };
}
