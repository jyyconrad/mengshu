import { describe, expect, it } from "vitest";

import {
  MemoryViewAssetError,
  validateMemoryProjectionContentRef,
} from "./content-ref.js";

const VALID_REF = {
  type: "memory_projection",
  recordIds: ["memory-1", "memory-2"],
  treeNodeIds: ["tree-1"],
  evidenceIds: ["evidence-1", "evidence-2"],
  semanticTypes: ["rules", "experience"],
  resolutionHash: "a".repeat(64),
} as const;

describe("validateMemoryProjectionContentRef", () => {
  it("返回去重语义稳定且不可被调用方修改的 memory projection 引用", () => {
    const input = {
      ...VALID_REF,
      recordIds: [...VALID_REF.recordIds] as string[],
      treeNodeIds: [...VALID_REF.treeNodeIds],
      evidenceIds: [...VALID_REF.evidenceIds],
      semanticTypes: [...VALID_REF.semanticTypes],
    };

    const result = validateMemoryProjectionContentRef(input);
    input.recordIds[0] = "memory-mutated";

    expect(result).toEqual(VALID_REF);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.recordIds)).toBe(true);
    expect(() => (result.recordIds as string[]).push("memory-3")).toThrow();
  });

  it.each([
    ["unsupported type", { ...VALID_REF, type: "knowledge_collection" }],
    ["extra property", { ...VALID_REF, url: "https://example.com" }],
    ["empty record refs", { ...VALID_REF, recordIds: [] }],
    ["empty evidence refs", { ...VALID_REF, evidenceIds: [] }],
    ["duplicate refs", { ...VALID_REF, recordIds: ["memory-1", "memory-1"] }],
    ["duplicate semantic types", { ...VALID_REF, semanticTypes: ["rules", "rules"] }],
    ["url", { ...VALID_REF, evidenceIds: ["https://example.com/evidence"] }],
    ["absolute path", { ...VALID_REF, treeNodeIds: ["/tmp/tree"] }],
    ["relative path", { ...VALID_REF, recordIds: ["../memory"] }],
    ["shell", { ...VALID_REF, recordIds: ["memory;rm"] }],
    ["sql", { ...VALID_REF, recordIds: ["SELECT * FROM memories"] }],
    ["control character", { ...VALID_REF, evidenceIds: ["evidence\u0000id"] }],
    ["unknown semantic type", { ...VALID_REF, semanticTypes: ["workflow_policy"] }],
    ["invalid hash", { ...VALID_REF, resolutionHash: "not-a-sha256" }],
  ])("拒绝 %s", (_label, input) => {
    expect(() => validateMemoryProjectionContentRef(input)).toThrow(MemoryViewAssetError);
  });
});
