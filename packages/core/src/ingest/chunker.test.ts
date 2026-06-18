import { describe, expect, test } from "vitest";
import { chunkMarkdown } from "./chunker.js";

describe("chunkMarkdown", () => {
  test("creates deterministic chunks with stable content hashes", () => {
    const chunks = chunkMarkdown("# A\n\nalpha beta gamma\n\n## B\n\nsecond section", {
      chunkSize: 18,
      scopeKey: "scope-1",
      documentId: "doc-1",
      createdAt: 1710000000000,
    });

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3]);
    expect(chunks[0]).toMatchObject({
      id: "doc-1:chunk:0",
      documentId: "doc-1",
      text: "# A",
      metadata: { scopeKey: "scope-1" },
      createdAt: 1710000000000,
    });
    expect(chunks.map((chunk) => chunk.contentHash)).toEqual(
      chunkMarkdown("# A\n\nalpha beta gamma\n\n## B\n\nsecond section", {
        chunkSize: 18,
        scopeKey: "scope-1",
        documentId: "doc-1",
        createdAt: 1710000000000,
      }).map((chunk) => chunk.contentHash),
    );
  });
});
