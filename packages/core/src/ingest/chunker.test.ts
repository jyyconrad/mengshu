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
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      documentId: "doc-1",
      text: "# A",
      metadata: { scopeKey: "scope-1", logicalId: "doc-1:chunk:0" },
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
    expect(chunks.map((chunk) => chunk.id)).toEqual(
      chunkMarkdown("# A\n\nalpha beta gamma\n\n## B\n\nsecond section", {
        chunkSize: 18,
        scopeKey: "scope-1",
        documentId: "doc-1",
        createdAt: 1710000000000,
      }).map((chunk) => chunk.id),
    );
  });
});
