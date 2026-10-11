import { isDeepStrictEqual } from "node:util";

import type { MemoryScope } from "../domain/types.js";
import type { WriteScope } from "../service/write-kernel.js";
import {
  fingerprintAdmissionScope,
  type AdmissionDecisionReceiptRepository,
  type AdmissionDecisionReceiptV1,
  validatePersistedAdmissionDecisionReceipt,
} from "./admission-decision-receipt.js";

export interface PostgresAdmissionDecisionReceiptQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<{
    readonly rows?: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}

function decoded(
  row: Record<string, unknown> | undefined,
  fingerprint: string,
): AdmissionDecisionReceiptV1 | undefined {
  if (!row) return undefined;
  const receipt = validatePersistedAdmissionDecisionReceipt(row.receipt);
  if (receipt.scopeFingerprint !== fingerprint) {
    throw new Error("Admission decision receipt relational identity mismatch");
  }
  return receipt;
}

/**
 * Durable admission decision receipts (schema v39+).
 * LanceDB has no equivalent table — callers should keep an in-memory mirror.
 */
export class PostgresAdmissionDecisionReceiptRepository
implements AdmissionDecisionReceiptRepository {
  constructor(private readonly client: PostgresAdmissionDecisionReceiptQueryClient) {}

  async append(
    scope: MemoryScope | WriteScope,
    value: AdmissionDecisionReceiptV1,
  ): Promise<AdmissionDecisionReceiptV1> {
    const fingerprint = fingerprintAdmissionScope(scope);
    const receipt = validatePersistedAdmissionDecisionReceipt(value);
    if (receipt.scopeFingerprint !== fingerprint) {
      throw new Error("Admission decision receipt scope mismatch");
    }
    const result = await this.client.query(
      `/* admission-decision-receipt:append */
WITH inserted AS (
  INSERT INTO mengshu_admission_decision_receipts (
    receipt_id, scope_fingerprint, candidate_hash, decision, semantic_type,
    receipt, created_at, expires_at
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
  ON CONFLICT (receipt_id) DO NOTHING
  RETURNING receipt
), existing AS (
  SELECT receipt FROM mengshu_admission_decision_receipts
  WHERE receipt_id = $1 AND scope_fingerprint = $2
)
SELECT receipt FROM inserted
UNION ALL
SELECT receipt FROM existing
LIMIT 2`,
      [
        receipt.id,
        fingerprint,
        receipt.candidateHash,
        receipt.decision,
        receipt.semanticType,
        JSON.stringify(receipt),
        Date.parse(receipt.createdAt),
        Date.parse(receipt.expiresAt),
      ],
    );
    const persisted = decoded(result.rows?.[0], fingerprint);
    if (!persisted || !isDeepStrictEqual(persisted, receipt)) {
      throw new Error("Admission decision receipt idempotency conflict");
    }
    return persisted;
  }

  async getLatest(
    scope: MemoryScope | WriteScope,
  ): Promise<AdmissionDecisionReceiptV1 | undefined> {
    const fingerprint = fingerprintAdmissionScope(scope);
    const result = await this.client.query(
      `/* admission-decision-receipt:get-latest */
SELECT receipt_id, receipt, created_at
FROM mengshu_admission_decision_receipts
WHERE scope_fingerprint = $1 AND expires_at >= $2
ORDER BY created_at DESC, receipt_id DESC
LIMIT 1`,
      [fingerprint, Date.now()],
    );
    return decoded(result.rows?.[0], fingerprint);
  }

  async getByCandidateHash(
    scope: MemoryScope | WriteScope,
    candidateHash: string,
  ): Promise<AdmissionDecisionReceiptV1 | undefined> {
    const fingerprint = fingerprintAdmissionScope(scope);
    const result = await this.client.query(
      `/* admission-decision-receipt:get-by-candidate */
SELECT receipt_id, receipt, created_at
FROM mengshu_admission_decision_receipts
WHERE scope_fingerprint = $1 AND candidate_hash = $2 AND expires_at >= $3
ORDER BY created_at DESC, receipt_id DESC
LIMIT 1`,
      [fingerprint, candidateHash, Date.now()],
    );
    return decoded(result.rows?.[0], fingerprint);
  }
}
