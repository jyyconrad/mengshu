import { describe, expect, test } from "vitest";

import {
  createEmbeddingSpace,
  createUnknownEmbeddingSpace,
  type EmbeddingSpace,
  type EmbeddingSpaceFingerprintInput,
} from "../domain/embedding-space.js";
import {
  decideEmbeddingAnnPolicy,
  decideEmbeddingLateFusionPolicy,
  decideEmbeddingReadPolicy,
  decideEmbeddingRecallPolicy,
  decideEmbeddingWritePolicy,
  EmbeddingReadGuard,
  EmbeddingWriteGuard,
  type ActiveEmbeddingSpaceRegistryState,
} from "./embedding-space-policy.js";

function fingerprint(
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

function registry(activeSpace: EmbeddingSpace): ActiveEmbeddingSpaceRegistryState {
  return { status: "ready", activeSpace };
}

describe("embedding write policy", () => {
  test("runtime 与 persisted active space 一致时允许写入", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());

    expect(
      decideEmbeddingWritePolicy({
        runtimeSpace,
        registry: registry(createEmbeddingSpace(fingerprint())),
      }),
    ).toEqual({
      allowed: true,
      mode: "write-enabled",
      reasonCode: "active-space-match",
      diagnostic: {
        registryStatus: "ready",
        runtimeSpace: {
          embeddingSpaceId: runtimeSpace.embeddingSpaceId,
          state: "known-queryable",
        },
        persistedActiveSpace: {
          embeddingSpaceId: runtimeSpace.embeddingSpaceId,
          state: "known-queryable",
        },
      },
    });
  });

  test("active fingerprint 不一致时强制 read-only-diagnostic", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());
    const persistedActive = createEmbeddingSpace(
      fingerprint({ model: "text-embedding-3-large", dim: 3072 }),
    );

    const decision = decideEmbeddingWritePolicy({
      runtimeSpace,
      registry: registry(persistedActive),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe("read-only-diagnostic");
    expect(decision.reasonCode).toBe("active-space-mismatch");
  });

  test.each([
    [{ status: "missing" } as const, "registry-active-space-missing"],
    [{ status: "unavailable" } as const, "registry-unavailable"],
  ])("registry=%o 时 fail-closed", (registryState, reasonCode) => {
    const decision = decideEmbeddingWritePolicy({
      runtimeSpace: createEmbeddingSpace(fingerprint()),
      registry: registryState,
    });

    expect(decision).toMatchObject({
      allowed: false,
      mode: "read-only-diagnostic",
      reasonCode,
    });
  });

  test("runtime 或 persisted active 为 unknown 时禁止写入", () => {
    const known = createEmbeddingSpace(fingerprint());
    const unknown = createUnknownEmbeddingSpace();

    expect(
      decideEmbeddingWritePolicy({
        runtimeSpace: unknown,
        registry: registry(known),
      }).reasonCode,
    ).toBe("runtime-space-unknown");
    expect(
      decideEmbeddingWritePolicy({
        runtimeSpace: known,
        registry: registry(unknown),
      }).reasonCode,
    ).toBe("persisted-active-space-unknown");
  });

  test("diagnostic payload 只含 ID/状态，不泄露额外 secret 字段", () => {
    const clean = createEmbeddingSpace(fingerprint());
    const withSecret = {
      ...clean,
      fingerprint: { ...clean.fingerprint, apiKey: "sk-do-not-leak" },
    } as EmbeddingSpace;

    const decision = decideEmbeddingWritePolicy({
      runtimeSpace: withSecret,
      registry: registry(clean),
    });

    expect(JSON.stringify(decision.diagnostic)).not.toContain("sk-do-not-leak");
    expect(decision.diagnostic.runtimeSpace).not.toHaveProperty("fingerprint");
  });
});

describe("runtime embedding write guard", () => {
  test("enforced guard 在 active match 后允许写入", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());
    const guard = new EmbeddingWriteGuard(runtimeSpace, "enforced");
    guard.update({ status: "ready", activeSpace: runtimeSpace });

    expect(() => guard.assertWriteAllowed()).not.toThrow();
    expect(guard.snapshot().decision.reasonCode).toBe("active-space-match");
  });

  test("enforced guard 在 mismatch 时抛错并携带 reason code", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());
    const guard = new EmbeddingWriteGuard(runtimeSpace, "enforced");
    guard.update({
      status: "ready",
      activeSpace: createEmbeddingSpace(fingerprint({ model: "other-model" })),
    });

    expect(() => guard.assertWriteAllowed()).toThrow(/active-space-mismatch/);
    expect(guard.snapshot()).toMatchObject({
      enforcement: "enforced",
      decision: { allowed: false, reasonCode: "active-space-mismatch" },
    });
  });

  test("legacy-write-through 明确暴露 unavailable，但在过渡期允许旧 provider 写入", () => {
    const guard = new EmbeddingWriteGuard(
      createEmbeddingSpace(fingerprint()),
      "legacy-write-through",
    );

    expect(() => guard.assertWriteAllowed()).not.toThrow();
    expect(guard.snapshot()).toMatchObject({
      enforcement: "legacy-write-through",
      decision: { allowed: false, reasonCode: "registry-unavailable" },
    });
  });
});

describe("embedding read and ANN policy", () => {
  test("同一已知空间允许直接读取与 ANN", () => {
    const query = createEmbeddingSpace(fingerprint());
    const target = createEmbeddingSpace(fingerprint());

    expect(decideEmbeddingReadPolicy({ querySpace: query, targetSpace: target }))
      .toMatchObject({
        allowed: true,
        mode: "same-space",
        reasonCode: "same-space-read",
      });
    expect(decideEmbeddingAnnPolicy({ querySpace: query, targetSpace: target }))
      .toEqual({ allowed: true, reasonCode: "same-space-ann" });
  });

  test("不同已知空间只能分路读取并禁止交叉 ANN", () => {
    const query = createEmbeddingSpace(fingerprint());
    const target = createEmbeddingSpace(fingerprint({ model: "other-model" }));

    expect(decideEmbeddingReadPolicy({ querySpace: query, targetSpace: target }))
      .toMatchObject({
        allowed: true,
        mode: "separate-space-route",
        reasonCode: "cross-space-separate-route",
      });
    expect(decideEmbeddingAnnPolicy({ querySpace: query, targetSpace: target }))
      .toEqual({ allowed: false, reasonCode: "cross-space-ann-forbidden" });
  });

  test("unknown space 只允许 text-only，禁止 ANN", () => {
    const known = createEmbeddingSpace(fingerprint());
    const unknown = createUnknownEmbeddingSpace();

    expect(decideEmbeddingReadPolicy({ querySpace: known, targetSpace: unknown }))
      .toMatchObject({
        allowed: true,
        mode: "text-only",
        reasonCode: "unknown-space-text-only",
      });
    expect(decideEmbeddingAnnPolicy({ querySpace: known, targetSpace: unknown }))
      .toEqual({ allowed: false, reasonCode: "unknown-space-ann-forbidden" });
  });
});

describe("runtime embedding recall policy", () => {
  test("仅 runtime 与 persisted active space 匹配时允许 ANN，并绑定 runtime space filter", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());

    expect(
      decideEmbeddingRecallPolicy({
        runtimeSpace,
        registry: registry(createEmbeddingSpace(fingerprint())),
      }),
    ).toMatchObject({
      allowed: true,
      mode: "same-space-ann",
      reasonCode: "active-space-match",
      requiredFilter: {
        embeddingSpaceId: runtimeSpace.embeddingSpaceId,
        embeddingSpaceState: "known-queryable",
      },
    });
  });

  test("同 fingerprint 的 reembedded registry 仅作审计标记，已验证记录统一查询 known-queryable", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());
    const reembedded = createEmbeddingSpace(fingerprint(), "reembedded");

    expect(
      decideEmbeddingRecallPolicy({
        runtimeSpace,
        registry: registry(reembedded),
      }),
    ).toMatchObject({
      allowed: true,
      requiredFilter: {
        embeddingSpaceId: runtimeSpace.embeddingSpaceId,
        embeddingSpaceState: "known-queryable",
      },
    });
  });

  test.each([
    [{ status: "missing" } as const, "registry-active-space-missing"],
    [{ status: "unavailable" } as const, "registry-unavailable"],
  ])("registry=%o 时显式 fail-closed，不允许 ANN", (registryState, reasonCode) => {
    expect(
      decideEmbeddingRecallPolicy({
        runtimeSpace: createEmbeddingSpace(fingerprint()),
        registry: registryState,
      }),
    ).toMatchObject({
      allowed: false,
      mode: "fail-closed",
      reasonCode,
    });
  });

  test("active mismatch 与 unknown space 都不允许混合 ANN", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());

    expect(
      decideEmbeddingRecallPolicy({
        runtimeSpace,
        registry: registry(createEmbeddingSpace(fingerprint({ model: "other-model" }))),
      }),
    ).toMatchObject({
      allowed: false,
      mode: "fail-closed",
      reasonCode: "active-space-mismatch",
    });
    expect(
      decideEmbeddingRecallPolicy({
        runtimeSpace,
        registry: registry(createUnknownEmbeddingSpace()),
      }),
    ).toMatchObject({
      allowed: false,
      mode: "fail-closed",
      reasonCode: "persisted-active-space-unknown",
    });
  });

  test("read guard 随 registry 更新，并在 unavailable 初始态禁止 ANN", () => {
    const runtimeSpace = createEmbeddingSpace(fingerprint());
    const guard = new EmbeddingReadGuard(runtimeSpace);

    expect(guard.snapshot()).toMatchObject({
      allowed: false,
      mode: "fail-closed",
      reasonCode: "registry-unavailable",
    });

    guard.update({ status: "ready", activeSpace: runtimeSpace });
    expect(guard.snapshot()).toMatchObject({
      allowed: true,
      mode: "same-space-ann",
      reasonCode: "active-space-match",
    });
  });
});

describe("embedding late-fusion policy", () => {
  test("同一空间允许 rank/RRF 与 raw similarity", () => {
    const space = createEmbeddingSpace(fingerprint());

    expect(decideEmbeddingLateFusionPolicy([space, space])).toEqual({
      allowed: true,
      rankRrfAllowed: true,
      rawSimilarityAllowed: true,
      reasonCode: "same-space-raw-score-allowed",
    });
  });

  test("多个已知不同空间允许 rank/RRF，但禁止 raw score", () => {
    const first = createEmbeddingSpace(fingerprint());
    const second = createEmbeddingSpace(fingerprint({ model: "other-model" }));

    expect(decideEmbeddingLateFusionPolicy([first, second])).toEqual({
      allowed: true,
      rankRrfAllowed: true,
      rawSimilarityAllowed: false,
      reasonCode: "cross-space-rank-rrf-only",
    });
  });

  test("包含 unknown 时仍只允许 text rank/RRF，禁止 raw score", () => {
    const known = createEmbeddingSpace(fingerprint());
    const unknown = createUnknownEmbeddingSpace();

    expect(decideEmbeddingLateFusionPolicy([known, unknown])).toEqual({
      allowed: true,
      rankRrfAllowed: true,
      rawSimilarityAllowed: false,
      reasonCode: "unknown-space-rank-rrf-only",
    });
  });

  test("空输入或 invalid descriptor 时拒绝 fusion", () => {
    const valid = createEmbeddingSpace(fingerprint());
    const invalid = {
      ...valid,
      embeddingSpaceId: valid.embeddingSpaceId.replace(/[a-f0-9]$/, "x"),
    } as EmbeddingSpace;

    expect(decideEmbeddingLateFusionPolicy([])).toEqual({
      allowed: false,
      rankRrfAllowed: false,
      rawSimilarityAllowed: false,
      reasonCode: "no-spaces",
    });
    expect(decideEmbeddingLateFusionPolicy([valid, invalid])).toEqual({
      allowed: false,
      rankRrfAllowed: false,
      rawSimilarityAllowed: false,
      reasonCode: "invalid-space",
    });
  });
});
