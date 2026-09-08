import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  adaptRagMultiCorpusQuery,
  type RagMultiCorpusDocument,
  type RagMultiCorpusQuery,
} from "../adapters/rag-multi-corpus.js";

const dataRoot = path.join(import.meta.dirname, "data", "rag-multi-corpus-v1");

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readQueries(): RagMultiCorpusQuery[] {
  return readFileSync(path.join(dataRoot, "queries.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as RagMultiCorpusQuery);
}

describe("synchronized kb-pilot evaluation dataset", () => {
  test("registers the dataset as a non-formal G1 diagnostic benchmark", () => {
    const registry = readJson<{ benchmarks: Array<Record<string, unknown>> }>(
      path.join(import.meta.dirname, "..", "registry.json"),
    );
    const entry = registry.benchmarks.find((benchmark) =>
      benchmark.id === "rag-multi-corpus-kb-pilot");

    expect(entry).toMatchObject({
      tier: ["G1"],
      role: "diagnostic",
      scorerStatus: "manual-unversioned",
      formalScoreEligible: false,
      revision: "39071af3f4dd25e59f5c59a6f9b6e8e99cd643b3",
      synchronizedDataset: { caseCount: 907, completeCaseCount: 902, documentCount: 236 },
    });
  });

  test("pins the upstream identities, deduplication counts and disclosed invalid cases", () => {
    const manifest = readJson<Record<string, unknown>>(path.join(dataRoot, "manifest.json"));
    const queryBytes = readFileSync(path.join(dataRoot, "queries.jsonl"));
    const corpusManifestBytes = readFileSync(path.join(dataRoot, "corpus-manifest.json"));
    const queries = readQueries();

    expect(manifest).toMatchObject({
      datasetId: "rag-multi-corpus-kb-pilot-v1",
      formalScoreEligible: false,
      sourceRowCount: 1088,
      caseCount: 907,
      completeCaseCount: 902,
      invalidMissingDocumentCaseCount: 5,
      documentCount: 236,
      queriesSha256: sha256(queryBytes),
      corpusManifestSha256: sha256(corpusManifestBytes),
      source: {
        revision: "39071af3f4dd25e59f5c59a6f9b6e8e99cd643b3",
        queryCsvSha256: "58be4e8ebe96147ab63b159b3166357ad905989023956038ed563f9b88c2d24e",
      },
      kbPilot: { revision: "a987183b1ff3c983775d4eff14e012baf811f080" },
    });
    expect(queries).toHaveLength(907);
    expect(new Set(queries.map((query) => query.id))).toHaveLength(907);
    expect(queries.reduce((sum, query) => sum + query.sourceRowCount, 0)).toBe(1088);
    expect(queries.filter((query) => query.sourceStatus === "invalid-missing-document"))
      .toHaveLength(5);
    expect(Object.fromEntries([...new Set(queries.map((query) => query.enterpriseName))]
      .sort().map((enterprise) => [enterprise,
        queries.filter((query) => query.enterpriseName === enterprise).length]))).toEqual({
      "Aventro Motors": 221,
      "Cendara University": 186,
      "Velvera Technologies": 177,
      "ZX Bank": 323,
    });
  });

  test("verifies every synchronized Markdown document and materializes a real 236-document case", () => {
    const corpusManifest = readJson<{
      documentCount: number;
      documents: Array<Omit<RagMultiCorpusDocument, "content"> & { bytes: number }>;
    }>(path.join(dataRoot, "corpus-manifest.json"));
    const documents = corpusManifest.documents.map((document): RagMultiCorpusDocument => {
      const bytes = readFileSync(path.join(dataRoot, "corpus", document.path));
      expect(bytes.byteLength).toBe(document.bytes);
      expect(sha256(bytes)).toBe(document.sha256);
      return { ...document, content: bytes.toString("utf8") };
    });
    const query = readQueries().find((candidate) => candidate.sourceStatus === "complete");

    expect(corpusManifest.documentCount).toBe(236);
    expect(documents).toHaveLength(236);
    expect(query).toBeDefined();
    const evalCase = adaptRagMultiCorpusQuery(query!, documents, {
      datasetVersion: "rag-multi-corpus-kb-pilot-v1@39071af",
    });
    expect(evalCase.memoryStream).toHaveLength(236);
    expect(evalCase.gold.requiredEvidenceRefs.length).toBeGreaterThan(0);
  });

  test("pins the vendored raw query CSV and license", () => {
    expect(sha256(readFileSync(path.join(dataRoot, "source", "queries.csv"))))
      .toBe("58be4e8ebe96147ab63b159b3166357ad905989023956038ed563f9b88c2d24e");
    expect(sha256(readFileSync(path.join(dataRoot, "LICENSE.rag-multi-corpus"))))
      .toBe("98800da81937e7e782491cd00623c39f6958cf031e36441f9ed604997921a140");
  });
});
