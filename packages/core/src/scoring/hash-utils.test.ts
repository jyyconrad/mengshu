import { describe, expect, test } from "vitest";
import {
  computeCanonicalContentHash,
  computeContentHash,
  deterministicUuid,
  durableUuid,
  matchesContentHash,
} from "./hash-utils.js";

describe("content hashes", () => {
  test("同时验证 legacy MD5 与 Markdown 工作集规范 SHA-256", () => {
    const legacyText = "  legacy memory  ";
    const canonicalText = "line one\r\nCafe\u0301";
    const normalizedCanonicalText = "line one\nCaf\u00e9";

    expect(matchesContentHash(legacyText, computeContentHash(legacyText))).toBe(true);
    expect(computeCanonicalContentHash(canonicalText))
      .toBe(computeCanonicalContentHash(normalizedCanonicalText));
    expect(matchesContentHash(
      canonicalText,
      computeCanonicalContentHash(normalizedCanonicalText),
    )).toBe(true);
  });

  test("拒绝不可验证的 legacy hash 和内容漂移", () => {
    expect(matchesContentHash("memory", "legacy-content-hash")).toBe(false);
    expect(matchesContentHash("memory", "a".repeat(36))).toBe(false);
    expect(matchesContentHash("memory", computeContentHash("other"))).toBe(false);
    expect(matchesContentHash("memory", computeCanonicalContentHash("other"))).toBe(false);
  });
});

describe("deterministicUuid", () => {
  test("同逻辑键稳定生成 UUIDv8，不同逻辑键不冲突", () => {
    const first = deterministicUuid("mengshu:document\0logical-a");

    expect(first).toBe(deterministicUuid("mengshu:document\0logical-a"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(deterministicUuid("mengshu:document\0logical-b"));
    expect(first).not.toBe(deterministicUuid("mengshu:chunk\0logical-a"));
  });

  test("durableUuid 保留已有 UUID，否则按 domain 稳定派生", () => {
    const existing = "11111111-1111-4111-8111-111111111111";
    expect(durableUuid("document", existing)).toBe(existing);
    expect(durableUuid("document", "doc-1")).toBe(durableUuid("document", "doc-1"));
    expect(durableUuid("document", "doc-1")).not.toBe(durableUuid("chunk", "doc-1"));
  });
});
