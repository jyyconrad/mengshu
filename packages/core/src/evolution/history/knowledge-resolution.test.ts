import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { legacyKnowledgeFixture } from "../../../../../tests/fixtures/evolution-history/knowledge-resolution.js";
import { attachLegacyKnowledgeResolution, parseLegacyKnowledgeResolution } from "./knowledge-resolution.js";
import { auditHistory } from "./audit.js";
import { planHistory } from "./plan.js";
import { historyContentSha256 } from "./native-materials.js";

const roots: string[] = [];
const fixture = async () => { const value = await legacyKnowledgeFixture(); roots.push(value.root); return value; };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("actual legacy knowledge-resolution schema", () => {
  it("parses artifacts produced by the existing resolver without inventing canonical/version decisions", async () => {
    const value = await fixture(), resolution = parseLegacyKnowledgeResolution(value.input);
    expect(resolution.counts.sources).toBe(3); expect(resolution.counts.quarantineSources).toBe(1);
    expect(resolution.canonicalTargetsSelected).toBe(false); expect(resolution.formalAssetsWritten).toBe(false); expect(resolution.supersedeAllowed).toBe(false);
    const audit = attachLegacyKnowledgeResolution(await auditHistory(value.history.input, value.history.port), resolution);
    expect(audit.sources.filter(source => source.knowledgeBinding)).toHaveLength(3);
    expect(audit.sources.some(source => source.knowledgeIdentity !== undefined)).toBe(false);
    const plan = planHistory(value.history.input, audit);
    expect(plan.units.some(unit => unit.phase === "knowledge")).toBe(false);
    expect(plan.knowledgeReviewPlan?.canonicalTargetsSelected).toBe(false);
  });
  it("rejects drift in output bytes, pinned receipt, and plan file", async () => {
    const { input } = await fixture();
    for (const field of ["bindings", "receipt", "plan"] as const) expect(() => parseLegacyKnowledgeResolution({ ...input, [field]: `${input[field]} ` })).toThrow("HISTORY_KNOWLEDGE_ARTIFACT_DRIFT");
  });
  it("does not treat a source-level receipt as authority for formal assets", async () => {
    const { input } = await fixture(), receipt = JSON.parse(input.receipt);
    receipt.guards.canonicalTargetsSelected = true;
    const text = JSON.stringify(receipt);
    expect(() => parseLegacyKnowledgeResolution({ ...input, receipt: text, receiptSha256: historyContentSha256(text) })).toThrow("HISTORY_KNOWLEDGE_LEGACY_AUTHORITY_INVALID");
  });
  it("rejects incomplete source coverage and unparsed fabricated resolution objects", async () => {
    const value = await fixture(), resolution = parseLegacyKnowledgeResolution(value.input);
    const audit = await auditHistory(value.history.input, value.history.port);
    expect(() => attachLegacyKnowledgeResolution(audit, structuredClone(resolution))).toThrow("HISTORY_KNOWLEDGE_UNVERIFIED_RESOLUTION");
    audit.sources[1].sourceHash = historyContentSha256("changed");
    const { hash: _hash, ...body } = audit;
    const { historyHash } = await import("./schema.js");
    expect(() => attachLegacyKnowledgeResolution({ ...body, hash: historyHash(body) }, resolution)).toThrow("HISTORY_KNOWLEDGE_SOURCE_DRIFT");
  });
});
