import { describe, expect, test } from "vitest";

import {
  adaptRagMultiCorpusQuery,
  type RagMultiCorpusDocument,
  type RagMultiCorpusQuery,
} from "./rag-multi-corpus.js";

const documents: readonly RagMultiCorpusDocument[] = [
  {
    path: "datasets/ZX Bank/md/Awards & Recognitions.md",
    enterpriseName: "ZX Bank",
    filename: "Awards & Recognitions.md",
    sha256: "a".repeat(64),
    content: "ZX Bank won the Best Digital Transformation Bank award in 2023.",
  },
  {
    path: "datasets/Aventro Motors/md/Safe Driving Checklist.md",
    enterpriseName: "Aventro Motors",
    filename: "Safe Driving Checklist.md",
    sha256: "b".repeat(64),
    content: "Check the tyres before driving.",
  },
];

function query(overrides: Partial<RagMultiCorpusQuery> = {}): RagMultiCorpusQuery {
  return {
    schemaVersion: "1",
    id: "ragmc-zx-bank-awards",
    enterpriseName: "ZX Bank",
    queryType: "Descriptive",
    query: "What award did ZX Bank win in 2023?",
    sourceRowCount: 1,
    supportingFacts: [{
      filename: "Awards & Recognitions.md",
      text: "Best Digital Transformation Bank (2023).",
    }],
    evidenceDocumentPaths: ["datasets/ZX Bank/md/Awards & Recognitions.md"],
    missingEvidenceFiles: [],
    sourceStatus: "complete",
    ...overrides,
  };
}

describe("RAG-Multi-Corpus kb-pilot adapter", () => {
  test("preserves the full shared corpus and maps supporting files to evidence refs", () => {
    const result = adaptRagMultiCorpusQuery(query(), documents, {
      datasetVersion: "kb-pilot-v1@39071af",
    });

    expect(result).toMatchObject({
      benchmarkId: "rag-multi-corpus-kb-pilot",
      capability: "descriptive",
      query: { expectedMode: "answer" },
      protocol: { ingestMode: "batch", topK: 6 },
    });
    expect(result.memoryStream).toHaveLength(2);
    expect(result.gold.requiredEvidenceRefs).toEqual([
      "ragmc:datasets/ZX Bank/md/Awards & Recognitions.md",
    ]);
    expect(result.official).toMatchObject({
      answerGoldStatus: "absent",
      sourceRowCount: 1,
      supportingFacts: [{ filename: "Awards & Recognitions.md" }],
    });
  });

  test("rejects an evidence path that is not present in the synchronized corpus", () => {
    expect(() => adaptRagMultiCorpusQuery(query({
      evidenceDocumentPaths: ["datasets/ZX Bank/md/Missing.md"],
    }), documents, { datasetVersion: "kb-pilot-v1@39071af" }))
      .toThrow(/evidence document.*missing/i);
  });

  test("does not silently score upstream cases with missing source documents", () => {
    expect(() => adaptRagMultiCorpusQuery(query({
      sourceStatus: "invalid-missing-document",
      evidenceDocumentPaths: [],
      missingEvidenceFiles: ["Account Close Guide.md"],
    }), documents, { datasetVersion: "kb-pilot-v1@39071af" }))
      .toThrow(/invalid-missing-document/i);
  });
});
