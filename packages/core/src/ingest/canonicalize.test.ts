import { describe, expect, test } from "vitest";
import { canonicalize } from "./canonicalize.js";

describe("canonicalize", () => {
  test("turns markdown input into canonical markdown and metadata", () => {
    const result = canonicalize({
      sourceId: "/docs/guide.md",
      content: "---\ntitle: Guide\ntags:\n  - memory\n---\n\n# Guide\n\nHello   world\n",
      metadata: { owner: "docs" },
    });

    expect(result.markdown).toBe("# Guide\n\nHello world");
    expect(result.metadata).toMatchObject({
      title: "Guide",
      tags: ["memory"],
      owner: "docs",
      sourceId: "/docs/guide.md",
    });
  });
});
