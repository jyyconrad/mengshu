import { describe, expect, test } from "vitest";

import { PostgresSkillArtifactRepository } from "./postgres-repository.js";
import type { SkillArtifactReceipt, SkillArtifactVersion } from "./types.js";

const artifact: SkillArtifactVersion = {
  skillId: "skill-1", version: 1, isHead: true, ownerUserId: "user-1",
  scope: {
    tenantId: "tenant-1", userId: "user-1", appId: "codex", projectId: "project-1",
    agentId: "agent-1", namespace: "memories", visibility: "private",
  },
  title: "Release", description: "Release safely", triggerConditions: ["publish"],
  preconditions: ["green"], steps: ["approve"], successSignals: ["healthy"],
  antiPatterns: ["manual"], riskBoundaries: ["no bypass"],
  evidenceMemoryIds: ["memory-1"], evidenceChunkIds: ["evidence-1"],
  manifest: [{ path: "ref.md", contentHash: "a".repeat(64), sizeBytes: 1,
    mimeType: "text/markdown", executable: false }],
  contentHash: "b".repeat(64), status: "draft", executionMode: "suggest_only",
  expectedOutcomePolicyVersion: "outcome-v1", createdAt: new Date(1_000).toISOString(),
};
const receipt: SkillArtifactReceipt = {
  id: "receipt-1", scopeFingerprint: "c".repeat(64), idempotencyKey: "key-1",
  requestHash: "d".repeat(64), skillId: "skill-1", artifactVersion: 1,
  operation: "propose", occurredAt: new Date(1_000).toISOString(),
};

describe("PostgresSkillArtifactRepository", () => {
  test("resource staging completes before CAS advances the readable head", async () => {
    const calls: string[] = [];
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: Row[]; rowCount: number | null }> => {
      const tag = sql.trim().split("\n")[0]!;
      calls.push(tag);
      if (sql.includes("get-receipt")) return { rows: [], rowCount: 0 };
      if (sql.includes("lock-head")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert-version")) return { rows: [{ version: 1 } as unknown as Row], rowCount: 1 };
      if (sql.includes("insert-resource")) return { rows: [{ path: "ref.md" } as unknown as Row], rowCount: 1 };
      if (sql.includes("complete-version")) return { rows: [{ version: 1 } as unknown as Row], rowCount: 1 };
      if (sql.includes("advance-head")) return { rows: [{ latest_version: 1 } as unknown as Row], rowCount: 1 };
      if (sql.includes("insert-receipt")) return { rows: [{ receipt_id: "receipt-1" } as unknown as Row], rowCount: 1 };
      return { rows: [], rowCount: null };
    };
    const client = { query, release: () => { calls.push("RELEASE"); } };
    const repository = new PostgresSkillArtifactRepository({ query, connect: async () => client });
    await repository.appendVersion({
      scopeFingerprint: receipt.scopeFingerprint,
      artifact,
      receipt,
      expectedLatestVersion: 0,
    });

    expect(calls.indexOf("/* skill-artifact:complete-version */"))
      .toBeLessThan(calls.indexOf("/* skill-artifact:advance-head */"));
    expect(calls.at(-2)).toBe("COMMIT");
    expect(calls.at(-1)).toBe("RELEASE");
  });

  test("unchanged append locks the complete head and writes only an idempotency receipt", async () => {
    const calls: string[] = [];
    const unchangedReceipt: SkillArtifactReceipt = {
      ...receipt,
      id: "receipt-unchanged",
      idempotencyKey: "key-unchanged",
      operation: "append",
      reason: "content_unchanged",
    };
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: Row[]; rowCount: number | null }> => {
      calls.push(sql.trim().split("\n")[0]!);
      if (sql.includes("get-receipt")) return { rows: [], rowCount: 0 };
      if (sql.includes("lock-unchanged-head")) {
        return { rows: [{ artifact, latest_version: 1 } as unknown as Row], rowCount: 1 };
      }
      if (sql.includes("insert-unchanged-receipt")) {
        return { rows: [{ receipt_id: unchangedReceipt.id } as unknown as Row], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    };
    const repository = new PostgresSkillArtifactRepository({
      query,
      connect: async () => ({ query, release: () => { calls.push("RELEASE"); } }),
    });

    await expect(repository.recordUnchangedAppend({
      scopeFingerprint: receipt.scopeFingerprint,
      artifact,
      receipt: unchangedReceipt,
      expectedLatestVersion: 1,
    })).resolves.toEqual({ artifact, receipt: unchangedReceipt, replayed: false });
    expect(calls).toContain("/* skill-artifact:lock-unchanged-head */");
    expect(calls).toContain("/* skill-artifact:insert-unchanged-receipt */");
    expect(calls.some((call) => call.includes("insert-version"))).toBe(false);
    expect(calls.at(-2)).toBe("COMMIT");
  });
});
