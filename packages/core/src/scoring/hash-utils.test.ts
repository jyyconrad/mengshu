import { describe, expect, test } from "vitest";
import { deterministicUuid, durableUuid } from "./hash-utils.js";

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
