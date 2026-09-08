import { createHash } from "node:crypto";
import type { CanonicalProjectionBundle } from "../../db/migrations/canonical-postgres-rehydration.js";
import { validateGovernedDocumentAssetVersion, validateGovernedDocumentIndex } from "../../documents/canonical.js";
import type { GovernedDocumentAssetVersion, GovernedDocumentIndex } from "../../documents/types.js";
import type { RawCandidate } from "../../lifecycle/candidate-validator.js";
import type { HistoryPlan, HistoryPlanUnit } from "./types.js";
import { exactObject, historyHash, isHash, rejectHistory, verifyHistoryHash } from "./schema.js";

export interface HistoryNativeMaterials {
  schema: "mengshu.history-p16-native-materials/v1";
  planHash: string;
  reviewReceiptId: string;
  /** The review approves these decisions, not historical authorship. */
  historicalAuthorshipAsserted: false;
  activations: { unitId: string; candidate?: RawCandidate; route: "active" | "lookup_only"; confidenceCeiling: number }[];
  documents: { asset: GovernedDocumentAssetVersion; index?: GovernedDocumentIndex; vaultId: string; canonicalPath: string }[];
  knowledge: { unitId: string; text: string; reviewReceiptHash: string; aggregationPlanHash: string }[];
  hash: string;
}
export const historyContentSha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function historyNativeEvidenceId(plan: HistoryPlan, unit: HistoryPlanUnit): string {
  const hex = historyHash(["raw", plan.input.runId, unit.id]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function validateHistoryNativeMaterials(value: HistoryNativeMaterials, plan: HistoryPlan, projection: CanonicalProjectionBundle): HistoryNativeMaterials {
  exactObject(value, ["schema", "planHash", "reviewReceiptId", "historicalAuthorshipAsserted", "activations", "documents", "knowledge", "hash"]);
  verifyHistoryHash(value);
  if (value.schema !== "mengshu.history-p16-native-materials/v1" || value.planHash !== plan.hash || value.historicalAuthorshipAsserted !== false ||
      !Array.isArray(value.activations) || !Array.isArray(value.documents) || !Array.isArray(value.knowledge) ||
      value.activations.length !== plan.units.filter(unit => unit.phase === "activate").length || value.knowledge.length !== plan.units.filter(unit => unit.phase === "knowledge").length || value.documents.length !== value.activations.length) rejectHistory("HISTORY_NATIVE_MATERIALS_INVALID");
  const seen = new Set<string>();
  for (const review of value.activations) {
    exactObject(review, ["unitId", "route", "confidenceCeiling"], ["candidate"]);
    const unit = plan.units.find(unit => unit.id === review.unitId && unit.phase === "activate");
    const memory = projection.memories.find(row => row.memoryId === unit?.target?.memoryId);
    if (!unit?.target || !memory || seen.has(unit.id) || !["active", "lookup_only"].includes(review.route) || !Number.isFinite(review.confidenceCeiling) || review.confidenceCeiling < 0 || review.confidenceCeiling > unit.target.confidence ||
        (unit.target.semanticType ? review.candidate?.text !== memory.row.text || review.candidate?.semanticType !== unit.target.semanticType : review.route !== "lookup_only" || review.candidate !== undefined)) rejectHistory("HISTORY_NATIVE_ACTIVATION_REVIEW_INVALID");
    seen.add(unit.id);
  }
  const assets = new Set<string>();
  for (const document of value.documents) {
    exactObject(document, ["asset", "vaultId", "canonicalPath"], ["index"]);
    const asset = validateGovernedDocumentAssetVersion(document.asset);
    const frozen = projection.documents.find(row => row.assetId === asset.assetId && row.assetVersion === asset.assetVersion);
    if (!frozen || assets.has(asset.assetId) || frozen.publicContentHash !== asset.publicContentHash || frozen.governanceProjectionHash !== asset.governanceProjectionHash || frozen.scopeFingerprint !== asset.scopeFingerprint ||
        !plan.units.some(unit => unit.phase === "activate" && unit.target?.assetId === asset.assetId)) rejectHistory("HISTORY_NATIVE_DOCUMENT_MISMATCH");
    if (asset.governanceDescription.complexityClass === "complex" && !document.index) rejectHistory("HISTORY_NATIVE_DOCUMENT_INDEX_REQUIRED");
    if (document.index) validateGovernedDocumentIndex(document.index, asset);
    assets.add(asset.assetId);
  }
  for (const review of value.knowledge) {
    exactObject(review, ["unitId", "text", "reviewReceiptHash", "aggregationPlanHash"]);
    const unit = plan.units.find(unit => unit.id === review.unitId && unit.phase === "knowledge"), identity = unit?.sources[0]?.knowledgeIdentity;
    if (!unit || !identity || seen.has(unit.id) || typeof review.text !== "string" || Buffer.byteLength(review.text) > 1024 * 1024 || historyContentSha256(review.text) !== identity.contentHash ||
        review.reviewReceiptHash !== identity.reviewReceiptHash || review.aggregationPlanHash !== identity.aggregationPlanHash || !isHash(review.reviewReceiptHash)) rejectHistory("HISTORY_NATIVE_KNOWLEDGE_REVIEW_INVALID");
    seen.add(unit.id);
  }
  return structuredClone(value);
}
