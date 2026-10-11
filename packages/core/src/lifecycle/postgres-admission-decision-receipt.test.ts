import { describe, expect, it, vi } from "vitest";
import { createAdmissionDecisionReceipt } from "./admission-decision-receipt.js";
import { PostgresAdmissionDecisionReceiptRepository } from "./postgres-admission-decision-receipt.js";
import type { MemoryScope } from "../domain/types.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "t1",
  userId: "u1",
  appId: "app",
  projectId: "proj",
  agentId: "agent",
  namespace: "default",
  visibility: "private",
});

describe("PostgresAdmissionDecisionReceiptRepository", () => {
  it("appends and reads latest / by candidate hash", async () => {
    const receipt = createAdmissionDecisionReceipt({
      scope,
      text: "发布前必须通过 doctor。",
      semanticType: "rules",
      decision: "accepted",
      reasonCodes: ["route:active"],
      source: "write_kernel",
      route: "active",
      now: 1_700_000_000_000,
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("admission-decision-receipt:append")) {
        return { rows: [{ receipt }] };
      }
      if (sql.includes("get-latest") || sql.includes("get-by-candidate")) {
        return { rows: [{ receipt_id: receipt.id, receipt, created_at: 1_700_000_000_000 }] };
      }
      return { rows: [] };
    });
    const repo = new PostgresAdmissionDecisionReceiptRepository({ query });
    await expect(repo.append(scope, receipt)).resolves.toEqual(receipt);
    await expect(repo.getLatest(scope)).resolves.toEqual(receipt);
    await expect(repo.getByCandidateHash(scope, receipt.candidateHash)).resolves.toEqual(receipt);
    expect(query).toHaveBeenCalled();
  });
});
