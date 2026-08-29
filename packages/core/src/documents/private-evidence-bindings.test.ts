import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  PRIVATE_EVIDENCE_BINDINGS_SCHEMA,
  createPrivateEvidenceBindingsManifest,
  parsePrivateEvidenceBindingsManifest,
  privateEvidenceBindingsManifestSha256,
  serializePrivateEvidenceBindingsManifest,
  validatePrivateEvidenceBindingsManifest,
  type CreatePrivateEvidenceBindingsManifestInput,
} from "./private-evidence-bindings.js";

const HASH = (value: string): string => createHash("sha256").update(value).digest("hex");
const SCOPE = HASH("scope-a");

function input(): CreatePrivateEvidenceBindingsManifestInput {
  return {
    governanceRunId: "run_p5",
    createdAt: "2026-08-28T12:00:00.000Z",
    inputs: [
      { artifact: "canonical-proposals", sha256: HASH("proposals") },
      { artifact: "typed-batch-plan", sha256: HASH("batches") },
    ],
    expectedAssets: [{
      assetId: "doc_rules",
      assetVersion: 1,
      scopeFingerprint: SCOPE,
      claimIds: ["claim_a", "claim_b"],
    }],
    bindings: [
      {
        assetId: "doc_rules",
        assetVersion: 1,
        claimId: "claim_a",
        evidenceId: "evidence_a",
        sourceRef: "memories:source-a",
        sourceHash: HASH("source-a"),
        sourceContentHash: HASH("source-a-content"),
        scopeFingerprint: SCOPE,
        anchor: {
          utf8ByteStart: 0,
          utf8ByteEnd: 12,
          excerptHash: HASH("first excerpt"),
        },
        status: "active",
        resourceIdentity: null,
      },
      {
        assetId: "doc_rules",
        assetVersion: 1,
        claimId: "claim_b",
        evidenceId: "evidence_b",
        sourceRef: "knowledge:source-b",
        sourceHash: HASH("source-b"),
        sourceContentHash: HASH("source-b-content"),
        scopeFingerprint: SCOPE,
        anchor: {
          utf8ByteStart: 14,
          utf8ByteEnd: 32,
          excerptHash: HASH("second excerpt"),
        },
        status: "active",
        resourceIdentity: "resource_0123456789abcdef0123456789abcdef",
      },
      {
        assetId: "doc_rules",
        assetVersion: 1,
        claimId: "claim_b",
        evidenceId: "evidence_old",
        sourceRef: "memories:source-old",
        sourceHash: HASH("source-old"),
        sourceContentHash: HASH("source-old-content"),
        scopeFingerprint: SCOPE,
        anchor: {
          utf8ByteStart: 2,
          utf8ByteEnd: 7,
          excerptHash: HASH("old excerpt"),
        },
        status: "superseded",
        resourceIdentity: null,
      },
    ],
  };
}

describe("P5 private evidence bindings", () => {
  test("创建严格版本化私有 manifest，并冻结逐 asset/claim active evidence coverage", () => {
    const manifest = createPrivateEvidenceBindingsManifest(input());

    expect(manifest).toMatchObject({
      schema: PRIVATE_EVIDENCE_BINDINGS_SCHEMA,
      summary: {
        assetCount: 1,
        claimCount: 2,
        bindingCount: 3,
        activeBindingCount: 2,
        supersededBindingCount: 1,
        quarantinedBindingCount: 0,
        claimCoverage: 1,
      },
      guards: {
        privateOnly: true,
        publicMarkdownProjectionForbidden: true,
      },
    });
    expect(manifest.assetCoverage[0]?.claims).toEqual([
      { claimId: "claim_a", activeEvidenceCount: 1, totalEvidenceCount: 1 },
      { claimId: "claim_b", activeEvidenceCount: 1, totalEvidenceCount: 2 },
    ]);
    expect(manifest.outputs.bindingsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.outputs.assetClaimCoverageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(manifest.bindings[0]?.anchor)).toBe(true);
  });

  test("canonical JSON round-trip 保持语义 hash 和文件 hash", () => {
    const manifest = createPrivateEvidenceBindingsManifest(input());
    const serialized = serializePrivateEvidenceBindingsManifest(manifest);
    const parsed = parsePrivateEvidenceBindingsManifest(serialized, {
      expectedAssets: input().expectedAssets,
      expectedInputs: input().inputs,
    });

    expect(parsed).toEqual(manifest);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(privateEvidenceBindingsManifestSha256(parsed)).toBe(HASH(serialized));
    expect(serialized).not.toContain("first excerpt");
    expect(serialized).not.toContain("second excerpt");
  });

  test("拒绝未知 key、proxy、非 canonical JSON 和 hash 漂移", () => {
    const manifest = createPrivateEvidenceBindingsManifest(input());
    expect(() => validatePrivateEvidenceBindingsManifest({ ...manifest, injected: true }))
      .toThrow(/exact keys|shape/i);
    expect(() => validatePrivateEvidenceBindingsManifest(new Proxy(manifest, {})))
      .toThrow(/proxy|shape/i);

    const serialized = serializePrivateEvidenceBindingsManifest(manifest);
    expect(() => parsePrivateEvidenceBindingsManifest(` ${serialized}`))
      .toThrow(/canonical/i);

    const drifted = structuredClone(manifest) as any;
    drifted.outputs.bindingsSha256 = HASH("drift");
    expect(() => validatePrivateEvidenceBindingsManifest(drifted)).toThrow(/hash/i);
  });

  test("拒绝未排序、重复 binding/evidence、source 不一致和非法 UTF-8 byte anchor", () => {
    const reversed = { ...input(), bindings: [...input().bindings].reverse() };
    expect(() => createPrivateEvidenceBindingsManifest(reversed)).toThrow(/sorted/i);

    const duplicateInput = input();
    const duplicate = {
      ...duplicateInput,
      bindings: [...duplicateInput.bindings, duplicateInput.bindings[0]!],
    };
    expect(() => createPrivateEvidenceBindingsManifest(duplicate)).toThrow(/duplicate/i);

    const inconsistentInput = input();
    const inconsistent = { ...inconsistentInput, bindings: [...inconsistentInput.bindings, {
      ...inconsistentInput.bindings[0]!,
      claimId: "claim_b",
      sourceHash: HASH("different-source-row"),
    }] };
    expect(() => createPrivateEvidenceBindingsManifest(inconsistent))
      .toThrow(/evidence.*inconsistent|source.*inconsistent/i);

    const invalidAnchorInput = input();
    const invalidAnchor = {
      ...invalidAnchorInput,
      bindings: invalidAnchorInput.bindings.map((binding, index) => index === 0
        ? { ...binding, anchor: { ...binding.anchor, utf8ByteEnd: binding.anchor.utf8ByteStart } }
        : binding),
    };
    expect(() => createPrivateEvidenceBindingsManifest(invalidAnchor)).toThrow(/anchor/i);
  });

  test("拒绝跨 scope、未知 claim/asset，以及任何没有 active evidence 的 claim", () => {
    const crossScopeInput = input();
    const crossScope = {
      ...crossScopeInput,
      bindings: crossScopeInput.bindings.map((binding, index) => index === 0
        ? { ...binding, scopeFingerprint: HASH("other-scope") }
        : binding),
    };
    expect(() => createPrivateEvidenceBindingsManifest(crossScope)).toThrow(/scope/i);

    const unknownClaimInput = input();
    const unknownClaim = {
      ...unknownClaimInput,
      bindings: unknownClaimInput.bindings.map((binding) => binding.claimId === "claim_b"
        ? { ...binding, claimId: "claim_c" }
        : binding),
    };
    expect(() => createPrivateEvidenceBindingsManifest(unknownClaim)).toThrow(/claim/i);

    const noActiveInput = input();
    const noActive = {
      ...noActiveInput,
      bindings: noActiveInput.bindings.map((binding) => binding.claimId === "claim_a"
        ? { ...binding, status: "quarantined" as const }
        : binding),
    };
    expect(() => createPrivateEvidenceBindingsManifest(noActive))
      .toThrow(/active evidence|coverage/i);
  });

  test("外部 context 强制 inputs 与 canonical asset/claim 集精确覆盖", () => {
    const manifest = createPrivateEvidenceBindingsManifest(input());
    expect(() => validatePrivateEvidenceBindingsManifest(manifest, {
      expectedAssets: [{
        ...input().expectedAssets[0]!,
        claimIds: ["claim_a", "claim_b", "claim_c"],
      }],
      expectedInputs: input().inputs,
    })).toThrow(/asset.*coverage|claim/i);

    expect(() => validatePrivateEvidenceBindingsManifest(manifest, {
      expectedAssets: input().expectedAssets,
      expectedInputs: [{ artifact: "canonical-proposals", sha256: HASH("wrong") }],
    })).toThrow(/input.*coverage|input.*drift/i);
  });
});
