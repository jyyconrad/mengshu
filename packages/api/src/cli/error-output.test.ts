import { describe, expect, test } from "vitest";

import { formatCliError } from "./error-output.js";

describe("formatCliError", () => {
  test("只输出单行 message，不泄露 stack", () => {
    const error = new Error("authority configuration is required");
    error.stack = "Error: authority configuration is required\n    at /private/runtime/secret.ts:42:1";

    expect(formatCliError(error)).toBe("Error: authority configuration is required");
    expect(formatCliError(error)).not.toContain("/private/runtime");
  });

  test("移除控制字符并对未知异常使用固定文案", () => {
    expect(formatCliError(new Error("bad\nconfig\rvalue\u0000"))).toBe("Error: bad config value");
    expect(formatCliError({ secret: "do-not-print" })).toBe("Error: CLI command failed");
  });
});
