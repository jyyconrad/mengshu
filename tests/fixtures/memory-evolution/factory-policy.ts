import { randomUUID } from "node:crypto";

import { resolveAuthorityScope, type AuthorityScope } from "../../../packages/core/src/domain/authority-scope.js";
import type { PostgresEvolutionVerifiedInput } from "../../../packages/core/src/evolution/governed-writer.js";
import type { PostgresEvolutionQueryClient } from "../../../packages/core/src/evolution/postgres-common.js";
import type { MemoryWriteKernelDependencies } from "../../../packages/core/src/service/write-kernel.js";

/** Test host policy for the live persistence contract, not RuntimeHost or semantic-dedup acceptance. */
export function isolatedKindOnlyPolicy(
  verified: PostgresEvolutionVerifiedInput | undefined,
  client: PostgresEvolutionQueryClient,
  vector: number[],
  embeddingStamp: Record<string, string>,
): Omit<MemoryWriteKernelDependencies, "transaction"> {
  return {
    resolveAuthority: ({ serverAuthority, clientScope }) => resolveAuthorityScope(
      serverAuthority as AuthorityScope, clientScope,
    ),
    normalize: ({ command, scope }) => ({
      text: "text" in command ? command.text : "",
      metadata: { ...command.metadata, ...embeddingStamp, sessionId: scope.sessionId }, promptRisk: false,
    }),
    embeddingGuard: () => ({ ok: true }),
    embed: async () => [...vector],
    validate: ({ normalized, command }) => {
      if (!verified || verified.validation.outcome !== "allowed" || verified.validation.contextEligible ||
          !("text" in command) || command.kind !== "fact" || command.semanticType !== undefined ||
          normalized.text !== verified.context.proposal.proposedText) {
        return { accepted: false, reason: "acceptance_policy_requires_verified_kind_only_fact" };
      }
      return { accepted: true, candidate: {
        compatibility: "kind_only_explicit", text: normalized.text, kind: "fact", confidence: 0.5,
        riskFlags: [], targetScope: "session",
        evidence: { quote: normalized.text, eventIds: verified.context.evidence.map((source) => source.id) },
      } };
    },
    scoreAdmission: () => ({ route: "lookup_only", valueScore: 0.5, reason: "acceptance_kind_only_lookup" }),
    scoreImportance: () => 0.5,
    exactDedup: async ({ scope, normalized }) => {
      const result = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM memories WHERE tenant_id = $1 AND user_id = $2
         AND canonical_project_id = $3 AND product_id = $4 AND producer_id = $5
         AND namespace = $6 AND visibility = $7 AND COALESCE(workspace_id, '') = $8
         AND metadata->>'sessionId' = $9 AND text = $10
         AND metadata->>'admissionRoute' IN ('active', 'lookup_only') LIMIT 1`,
        [scope.tenantId, scope.userId, scope.projectId, scope.appId, scope.agentId, scope.namespace,
          scope.visibility, scope.workspaceId ?? "", scope.sessionId ?? "", normalized.text],
      );
      return result.rows[0] ? { duplicate: true, duplicateOf: result.rows[0].id } : { duplicate: false };
    },
    semanticDedup: async () => ({ duplicate: false }),
    ack: () => undefined,
    createId: randomUUID,
    now: Date.now,
  };
}
