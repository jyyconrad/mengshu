import { describe, expect, test } from "vitest";
import type { WriteMemoryRecord, WriteAdmissionRoute } from "./write-kernel.js";
import {
  writeRecordToMemoryRecord,
  writeRecordToPostgresPendingCandidate,
} from "./write-kernel-mapping.js";

const scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  visibility: "private" as const,
});

function content(
  route: WriteAdmissionRoute,
): Extract<WriteMemoryRecord, { mutation: "content" }> {
  return {
    id: "record-a",
    commandType: "saveExplicit",
    mutation: "content",
    scope,
    text: "User explicitly prefers concise answers",
    metadata: { source: "user" },
    vector: [0.1, 0.2],
    route,
    valueScore: 0.74,
    importance: 0.36,
    kind: "preference",
    semanticType: "profile",
    container: "personal",
    confidence: 0.81,
    category: "preference",
    dataType: "memory",
    tableName: "memories",
    provenance: { source: "user", messageId: "message-a" },
    evidenceIds: ["evidence-a"],
    governance: {
      candidate: { confidence: 0.81, extractor: "deterministic-v1" },
      admissionReason: "pending_review",
    },
    createdAt: 1_000,
  };
}

describe("write kernel persistence mapping", () => {
  test("active route maps to a governed active MemoryRecord without reusing valueScore as importance", () => {
    const mapped = writeRecordToMemoryRecord(content("active"));

    expect(mapped).toMatchObject({
      id: "record-a",
      scope,
      kind: "preference",
      semanticType: "profile",
      lifecycleStatus: "active",
      importance: 0.36,
      confidence: 0.81,
      category: "preference",
      dataType: "memory",
      tableName: "memories",
      sourceNodeIds: ["evidence-a"],
      metadata: {
        source: "user",
        admissionRoute: "active",
        valueScore: 0.74,
        governance: {
          provenance: {
            source: "user",
            messageId: "message-a",
            sessionId: "session-a",
          },
        },
      },
      provenance: {
        source: "user",
        messageId: "message-a",
        sessionId: "session-a",
      },
    });
    expect(mapped.importance).not.toBe(0.74);
    expect(mapped.contentHash).toMatch(/^[a-f0-9]{32}$/);
  });

  test("server authority scope overwrites a conflicting provenance session", () => {
    const mapped = writeRecordToMemoryRecord({
      ...content("active"),
      provenance: { source: "user", sessionId: "client-spoofed-session" },
    });

    expect(mapped.provenance.sessionId).toBe("session-a");
    expect((mapped.metadata.governance as { provenance: { sessionId: string } })
      .provenance.sessionId).toBe("session-a");
  });

  test.each(["candidate_low_priority", "candidate"] as const)(
    "%s route maps only to Postgres pending candidate input",
    (route) => {
      const mapped = writeRecordToPostgresPendingCandidate(content(route));
      expect(mapped).toMatchObject({
        id: "record-a",
        text: "User explicitly prefers concise answers",
        semanticType: "profile",
        kind: "preference",
        confidence: 0.81,
        reason: "pending_review",
        evidenceIds: ["evidence-a"],
        extractor: "deterministic-v1",
        metadata: {
          admissionRoute: route,
          valueScore: 0.74,
          importance: 0.36,
        },
        createdAt: 1_000,
      });
      expect(() => writeRecordToMemoryRecord(content(route))).toThrow(/route/i);
    },
  );

  test.each(["lookup_only", "evidence_only"] as const)(
    "%s route remains a governed memory but is ineligible for fast context injection",
    (route) => {
      const mapped = writeRecordToMemoryRecord(content(route));
      expect(mapped).toMatchObject({
        lifecycleStatus: "archived",
        container: "session_candidate",
        semanticType: "profile",
        metadata: {
          admissionRoute: route,
          contextEligible: false,
        },
      });
      expect(() => writeRecordToPostgresPendingCandidate(content(route))).toThrow(/route/i);
    },
  );

  test("raw evidence-only record does not fabricate semantic confidence", () => {
    const rawEvidence: Extract<WriteMemoryRecord, { mutation: "content" }> = {
      ...content("evidence_only"),
      confidence: undefined,
      semanticType: undefined,
      kind: "observation",
      governance: {
        candidate: { phase: "raw_evidence", evidenceOnly: true },
        admissionReason: "raw_evidence_before_candidate_admission",
      },
    };

    const mapped = writeRecordToMemoryRecord(rawEvidence);

    expect(mapped).toMatchObject({
      kind: "observation",
      lifecycleStatus: "archived",
      container: "session_candidate",
      metadata: {
        admissionRoute: "evidence_only",
        contextEligible: false,
      },
    });
    expect(mapped.semanticType).toBeUndefined();
    expect(mapped.confidence).toBeUndefined();
  });

  test("active, lookup/evidence, drop and lifecycle records fail closed at the candidate mapper", () => {
    expect(() => writeRecordToPostgresPendingCandidate(content("active"))).toThrow(/route/i);
    expect(() => writeRecordToPostgresPendingCandidate(content("lookup_only"))).toThrow(/route/i);
    expect(() => writeRecordToPostgresPendingCandidate(content("evidence_only"))).toThrow(/route/i);
    expect(() => writeRecordToPostgresPendingCandidate(content("drop"))).toThrow(/route/i);
    expect(() => writeRecordToPostgresPendingCandidate({
      id: "record-a",
      commandType: "correctMemory",
      mutation: "lifecycle",
      targetId: "record-a",
      lifecycleAction: "archive",
      scope,
      metadata: {},
      createdAt: 1_000,
    })).toThrow(/content/i);
  });

  test("candidate confidence never falls back to valueScore", () => {
    const record = content("candidate") as Extract<WriteMemoryRecord, { mutation: "content" }>;
    expect(() => writeRecordToPostgresPendingCandidate({
      ...record,
      confidence: undefined,
      valueScore: 0.99,
      governance: { ...record.governance, candidate: {} },
    })).toThrow(/confidence/i);
  });

  test("non-JSON metadata fails at the pure mapping boundary", () => {
    const record = content("candidate") as Extract<WriteMemoryRecord, { mutation: "content" }>;
    expect(() => writeRecordToPostgresPendingCandidate({
      ...record,
      metadata: { when: new Date(0) },
    })).toThrow(/plain JSON/i);

    const sparse = new Array(2);
    sparse[1] = "evidence-a";
    expect(() => writeRecordToPostgresPendingCandidate({
      ...record,
      evidenceIds: sparse,
    })).toThrow(/JSON|dense/i);
  });
});
