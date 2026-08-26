import { isDeepStrictEqual } from "node:util";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  type ContextAssemblyReceipt,
  type ContextAssemblyReceiptRepository,
  validatePersistedContextAssemblyReceipt,
} from "./assembly-receipt.js";

export interface PostgresContextAssemblyReceiptQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<{
    readonly rows?: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}

function exactScope(scope: MemoryScope): { fingerprint: string; sessionId: string } {
  if (scope.visibility !== "private" || typeof scope.sessionId !== "string" ||
      scope.sessionId.trim().length === 0) {
    throw new Error("Context assembly receipt requires exact private session scope");
  }
  return { fingerprint: authorityScopeFingerprint(scope), sessionId: scope.sessionId };
}

function decoded(
  row: Record<string, unknown> | undefined,
  fingerprint: string,
  sessionId: string,
): ContextAssemblyReceipt | undefined {
  if (!row) return undefined;
  const receipt = validatePersistedContextAssemblyReceipt(row.receipt);
  if (receipt.scopeFingerprint !== fingerprint || receipt.sessionId !== sessionId) {
    throw new Error("Context assembly receipt relational identity mismatch");
  }
  return receipt;
}

export class PostgresContextAssemblyReceiptRepository
implements ContextAssemblyReceiptRepository {
  constructor(private readonly client: PostgresContextAssemblyReceiptQueryClient) {}

  async append(scope: MemoryScope, value: ContextAssemblyReceipt): Promise<ContextAssemblyReceipt> {
    const { fingerprint, sessionId } = exactScope(scope);
    const receipt = validatePersistedContextAssemblyReceipt(value);
    if (receipt.scopeFingerprint !== fingerprint || receipt.sessionId !== sessionId) {
      throw new Error("Context assembly receipt scope mismatch");
    }
    const result = await this.client.query(
      `/* context-assembly-receipt:append */
WITH inserted AS (
  INSERT INTO mengshu_context_assembly_receipts (
    receipt_id, scope_fingerprint, session_id, stable_content_hash,
    dynamic_content_hash, receipt, created_at, expires_at
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
  ON CONFLICT (receipt_id) DO NOTHING
  RETURNING receipt
), existing AS (
  SELECT receipt FROM mengshu_context_assembly_receipts
  WHERE receipt_id = $1 AND scope_fingerprint = $2 AND session_id = $3
)
SELECT receipt FROM inserted
UNION ALL
SELECT receipt FROM existing
LIMIT 2`,
      [receipt.id, fingerprint, sessionId, receipt.stableContentHash,
        receipt.dynamicContentHash, JSON.stringify(receipt), Date.parse(receipt.createdAt),
        Date.parse(receipt.expiresAt)],
    );
    const persisted = decoded(result.rows?.[0], fingerprint, sessionId);
    if (!persisted || !isDeepStrictEqual(persisted, receipt)) {
      throw new Error("Context assembly receipt idempotency conflict");
    }
    return persisted;
  }

  async getLatest(scope: MemoryScope, sessionIdInput: string): Promise<ContextAssemblyReceipt | undefined> {
    const { fingerprint, sessionId } = exactScope(scope);
    if (sessionIdInput !== sessionId) throw new Error("Context assembly receipt session mismatch");
    const result = await this.client.query(
      `/* context-assembly-receipt:get-latest */
SELECT receipt_id, receipt, created_at
FROM mengshu_context_assembly_receipts
WHERE scope_fingerprint = $1 AND session_id = $2
ORDER BY created_at DESC, receipt_id DESC
LIMIT 2`,
      [fingerprint, sessionId],
    );
    if ((result.rows?.length ?? 0) > 1) {
      const first = result.rows?.[0];
      const second = result.rows?.[1];
      if (first?.created_at === second?.created_at && first?.receipt_id === second?.receipt_id) {
        throw new Error("Context assembly receipt duplicate rows");
      }
    }
    return decoded(result.rows?.[0], fingerprint, sessionId);
  }
}
