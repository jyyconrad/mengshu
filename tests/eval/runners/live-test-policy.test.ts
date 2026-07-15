import { describe, expect, test } from "vitest";

import { isLiveTestEnabled } from "./live-test-policy.js";

describe("live test policy", () => {
  test("普通 provider 凭据不能自动启用 live 测试", () => {
    expect(
      isLiveTestEnabled({
        OPENAI_API_KEY: "test-key",
        SUPABASE_URL: "https://example.invalid",
        SUPABASE_SERVICE_KEY: "test-service-key",
      }),
    ).toBe(false);
  });

  test("只有显式 MENGSHU_RUN_LIVE_TESTS=1 才启用 live 测试", () => {
    expect(isLiveTestEnabled({ MENGSHU_RUN_LIVE_TESTS: "1" })).toBe(true);
    expect(isLiveTestEnabled({ MENGSHU_RUN_LIVE_TESTS: "true" })).toBe(false);
    expect(isLiveTestEnabled({ MENGSHU_RUN_LIVE_TESTS: "0" })).toBe(false);
  });
});
