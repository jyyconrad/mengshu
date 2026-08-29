import { describe, expect, test } from "vitest";

import type { GovernedDocumentAssetVersion } from
  "../packages/core/src/documents/types.js";
import {
  buildCanonicalNativeMemoryRow,
  projectClaimEvidenceBinding,
} from "./operator-markdown-p13-project.js";

const asset = {
  assetId: "doc_example",
  assetVersion: 1,
  semanticType: "rules",
  publicContentHash: "a".repeat(64),
  governanceProjectionHash: "b".repeat(64),
  scopeFingerprint: "c".repeat(64),
  scope: {
    tenantId: "local",
    userId: "user",
    appId: "codex",
    projectId: "project",
    agentId: "agent",
    namespace: "working-context",
    visibility: "private",
  },
  content: {
    title: "Use governed retrieval",
    sections: [{
      id: "section_1",
      title: "Rules",
      claims: [{ id: "claim_1", text: "Always use the authoritative native contract." }],
    }],
  },
} as unknown as GovernedDocumentAssetVersion;

const route = {
  assetId: asset.assetId,
  valueScore: 0.92,
  importance: 0.81,
  sourceTreeEligible: false,
  topicTreeKeys: [],
  globalTreeEligible: false,
  materializedTreeTypes: [],
} as const;

describe("P13 native PostgreSQL projection", () => {
  test("canonical rows satisfy governed retrieval identity and hydration metadata", () => {
    const evidenceMemoryIds = ["1d105864-64ec-4441-8434-3a72d7434cc0"];
    const projected = buildCanonicalNativeMemoryRow(
      asset,
      route,
      evidenceMemoryIds,
      "2026-08-28T09:55:10.000Z",
    );
    const row = projected.row as Record<string, unknown>;
    const metadata = row.metadata as Record<string, unknown>;
    const governance = metadata.governance as Record<string, unknown>;
    const candidate = governance.candidate as Record<string, unknown>;
    const evidence = candidate.evidence as Record<string, unknown>;
    const native = governance.native as Record<string, unknown>;

    expect(row).toMatchObject({
      data_type: "memory",
      category: "decision",
      lifecycle_status: "active",
    });
    expect(row.content_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(metadata).toMatchObject({
      admissionRoute: "active",
      contextEligible: true,
      semanticType: "rules",
      memoryContainer: "project",
      sourceNodeIds: evidenceMemoryIds,
    });
    expect(governance.evidenceIds).toEqual(evidenceMemoryIds);
    expect(evidence.eventIds).toEqual(evidenceMemoryIds);
    expect(native).toMatchObject({
      kind: "decision",
      semanticType: "rules",
      category: "decision",
      dataType: "memory",
    });
  });

  test("claim evidence keeps its binding id separate from the source memory id", () => {
    const binding = {
      evidenceId: "evidence_binding_1",
      assetId: "doc_example",
      assetVersion: 1,
      claimId: "claim_1",
      scopeFingerprint: "c".repeat(64),
      sourceRef: "memories:1d105864-64ec-4441-8434-3a72d7434cc0",
      sourceHash: "d".repeat(64),
      sourceContentHash: "e".repeat(64),
      anchor: { kind: "line", start: 1, end: 1 },
      resourceIdentity: null,
      status: "verified",
    };
    const projected = projectClaimEvidenceBinding(binding);

    expect(projected.evidenceId).toBe("evidence_binding_1");
    expect(projected.sourceMemoryId).toBe("1d105864-64ec-4441-8434-3a72d7434cc0");
    expect(projected.rowSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => projectClaimEvidenceBinding({
      ...binding,
      sourceRef: "knowledge:1d105864-64ec-4441-8434-3a72d7434cc0",
    })).toThrowError("P13_PROJECTION_EVIDENCE_SOURCE_INVALID");
  });
});
