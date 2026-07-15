import { describe, expect, test } from "vitest";

import {
  EMBEDDING_SPACE_ID_VERSION,
  UNKNOWN_EMBEDDING_SPACE_ID,
  assertAnnCompatible,
  assertRawSimilarityFusionCompatible,
  createEmbeddingSpace,
  createUnknownEmbeddingSpace,
  evaluateEmbeddingQueryCompatibility,
  evaluateEmbeddingWriteCompatibility,
  normalizeEmbeddingSpaceFingerprint,
  type EmbeddingSpaceFingerprintInput,
} from "./embedding-space.js";

function input(
  overrides: Partial<EmbeddingSpaceFingerprintInput> = {},
): EmbeddingSpaceFingerprintInput {
  return {
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dim: 1536,
    normalization: "l2",
    ...overrides,
  };
}

describe("embedding space fingerprint", () => {
  test("规范化 provider、URL 和 model 的无语义差异", () => {
    const normalized = normalizeEmbeddingSpaceFingerprint(
      input({
        provider: " OpenAI ",
        baseURL: "HTTPS://API.OPENAI.COM:443/v1/",
        model: " text-embedding-3-small ",
      }),
    );

    expect(normalized).toEqual({
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dim: 1536,
      normalization: "l2",
    });
  });

  test("ID 稳定且带版本前缀", () => {
    const first = createEmbeddingSpace(input());
    const second = createEmbeddingSpace(input());

    expect(first.embeddingSpaceId).toBe(second.embeddingSpaceId);
    expect(first.embeddingSpaceId).toMatch(
      new RegExp(`^embedding-space:${EMBEDDING_SPACE_ID_VERSION}:[a-f0-9]{64}$`),
    );
  });

  test("apiKey 轮换不改变 fingerprint 或 ID，结果也不泄露 secret", () => {
    const before = createEmbeddingSpace({
      ...input(),
      apiKey: "sk-before",
    } as EmbeddingSpaceFingerprintInput & { apiKey: string });
    const after = createEmbeddingSpace({
      ...input(),
      apiKey: "sk-after",
    } as EmbeddingSpaceFingerprintInput & { apiKey: string });

    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("sk-");
    expect(after.fingerprint).not.toHaveProperty("apiKey");
  });

  test.each([
    ["provider", { provider: "azure-openai" }],
    ["baseURL", { baseURL: "https://api.openai.com/v2" }],
    ["model", { model: "text-embedding-3-large" }],
    ["dim", { dim: 3072 }],
    ["normalization", { normalization: "none" as const }],
  ])("语义字段 %s 变化时 ID 必须变化", (_field, overrides) => {
    expect(createEmbeddingSpace(input(overrides)).embeddingSpaceId).not.toBe(
      createEmbeddingSpace(input()).embeddingSpaceId,
    );
  });

  test.each(["provider", "baseURL", "model", "dim", "normalization"])(
    "缺少 %s 时 fail-closed",
    (field) => {
      const invalid = { ...input() } as Record<string, unknown>;
      delete invalid[field];

      expect(() =>
        createEmbeddingSpace(invalid as unknown as EmbeddingSpaceFingerprintInput),
      ).toThrow(new RegExp(field));
    },
  );

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "非法 dim=%s 时 fail-closed",
    (dim) => {
      expect(() => createEmbeddingSpace(input({ dim }))).toThrow(/dim/);
    },
  );

  test.each([
    { provider: "unknown" },
    { model: "unknown" },
    { model: "legacy" },
  ])("unknown fingerprint 不能伪装成已知空间：%o", (overrides) => {
    expect(() => createEmbeddingSpace(input(overrides))).toThrow(/unknown|legacy/i);
  });
});

describe("embedding space compatibility", () => {
  test("同一已知空间允许 query ANN、raw similarity 和 write", () => {
    const querySpace = createEmbeddingSpace(input());
    const targetSpace = createEmbeddingSpace(input());

    expect(evaluateEmbeddingQueryCompatibility(querySpace, targetSpace)).toEqual({
      compatible: true,
      reason: "same-space",
      annAllowed: true,
      rawSimilarityComparable: true,
    });
    expect(evaluateEmbeddingWriteCompatibility(querySpace, targetSpace)).toEqual({
      compatible: true,
      reason: "same-space",
    });
  });

  test("reembedded 状态在相同 canonical ID 下保持兼容", () => {
    const active = createEmbeddingSpace(input());
    const migrated = createEmbeddingSpace(input(), "reembedded");

    expect(evaluateEmbeddingQueryCompatibility(active, migrated).compatible).toBe(
      true,
    );
    expect(evaluateEmbeddingWriteCompatibility(active, migrated).compatible).toBe(
      true,
    );
  });

  test("不同空间拒绝 ANN、raw similarity 比较和 write", () => {
    const querySpace = createEmbeddingSpace(input());
    const otherSpace = createEmbeddingSpace(input({ model: "other-model" }));

    expect(evaluateEmbeddingQueryCompatibility(querySpace, otherSpace)).toEqual({
      compatible: false,
      reason: "space-mismatch",
      annAllowed: false,
      rawSimilarityComparable: false,
    });
    expect(evaluateEmbeddingWriteCompatibility(querySpace, otherSpace)).toEqual({
      compatible: false,
      reason: "space-mismatch",
    });
    expect(() => assertAnnCompatible(querySpace, otherSpace)).toThrow(/ANN/);
    expect(() =>
      assertRawSimilarityFusionCompatible([querySpace, otherSpace]),
    ).toThrow(/raw similarity.*rank\/RRF/s);
  });

  test("unknown space 即使与自身比较也禁止 ANN、raw similarity 和 write", () => {
    const known = createEmbeddingSpace(input());
    const unknown = createUnknownEmbeddingSpace();

    expect(unknown.embeddingSpaceId).toBe(UNKNOWN_EMBEDDING_SPACE_ID);
    expect(evaluateEmbeddingQueryCompatibility(unknown, unknown)).toEqual({
      compatible: false,
      reason: "unknown-space",
      annAllowed: false,
      rawSimilarityComparable: false,
    });
    expect(evaluateEmbeddingWriteCompatibility(known, unknown)).toEqual({
      compatible: false,
      reason: "unknown-space",
    });
    expect(() => assertAnnCompatible(known, unknown)).toThrow(/unknown.*ANN/is);
    expect(() => assertRawSimilarityFusionCompatible([unknown])).toThrow(
      /unknown.*raw similarity/is,
    );
  });
});
