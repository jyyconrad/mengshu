import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { sha256, stableJson } from "../sources/shared.js";
import type { EvolutionLease } from "../types.js";
import type { EquivalentClaim, EquivalentMergePlan, EquivalentMergePort } from "./types.js";

function exactClaim(claim: EquivalentClaim) {
  const normalize = (value: string) => value.normalize("NFC").trim();
  if (!claim.memoryId || !Number.isSafeInteger(claim.revision) || claim.revision < 1 || !/^[a-f0-9]{64}$/.test(claim.contentHash) ||
      !claim.verificationReceiptId || claim.blocked || claim.evidenceRootIds.length === 0 || claim.evidenceRootIds.length > 100 ||
      !Number.isFinite(claim.confidence) || claim.confidence < 0 || claim.confidence > 1 ||
      ![claim.subject, claim.predicate, claim.object].every(value => value.trim() && value.length <= 2048) ||
      claim.applicability.length === 0 || claim.applicability.length > 32 || claim.applicability.some(value => !value.trim() || value.length > 2048) ||
      !["positive", "negative"].includes(claim.polarity) || [claim.validFrom, claim.validTo].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
      (claim.validFrom !== undefined && claim.validTo !== undefined && claim.validFrom > claim.validTo)) throw new Error("unproven_equivalence");
  return { scope: authorityScopeFingerprint(claim.scope), subject: normalize(claim.subject), predicate: normalize(claim.predicate),
    object: normalize(claim.object), applicability: [...new Set(claim.applicability.map(normalize))].sort(),
    validFrom: claim.validFrom ?? null, validTo: claim.validTo ?? null, polarity: claim.polarity };
}

export function planEquivalentMerge(left: EquivalentClaim, right: EquivalentClaim):
  | { status: "allowed"; plan: EquivalentMergePlan }
  | { status: "review"; reason: string } {
  try {
    const a = exactClaim(left);
    const b = exactClaim(right);
    if (left.memoryId === right.memoryId || stableJson(a) !== stableJson(b)) return { status: "review", reason: "equivalence_not_proven" };
    const [canonical, alias] = [left, right].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
    const proofHash = sha256(stableJson(a));
    const id = sha256(stableJson({ proofHash, targets: [canonical, alias].map(c => [c.memoryId, c.revision, c.contentHash, c.verificationReceiptId]) }));
    return { status: "allowed", plan: { id, canonical: structuredClone(canonical), alias: structuredClone(alias), proofHash,
      confidenceCeiling: Math.min(left.confidence, right.confidence), preserveAliases: true } };
  } catch { return { status: "review", reason: "equivalence_not_proven" }; }
}

export async function applyEquivalentMerge(input: { left: EquivalentClaim; right: EquivalentClaim; lease: EvolutionLease; port: EquivalentMergePort }):
Promise<{ status: "review"; reason: string } | { status: "applied"; receiptId: string; planId: string }> {
  const result = planEquivalentMerge(input.left, input.right);
  if (result.status === "review") return result;
  if (authorityScopeFingerprint(result.plan.canonical.scope) !== input.lease.scopeFingerprint) throw new Error("maintenance_scope_mismatch");
  const receipt = await input.port.mergeEquivalent({ plan: result.plan, lease: input.lease });
  if (!receipt.receiptId) throw new Error("merge_receipt_required");
  return { status: "applied", receiptId: receipt.receiptId, planId: result.plan.id };
}
