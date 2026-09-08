import { parseEvalCaseV2, type EvalCaseV2 } from "../protocol.js";

export type RagMultiCorpusSourceStatus = "complete" | "invalid-missing-document";

export interface RagMultiCorpusSupportingFact {
  readonly filename: string;
  readonly text: string;
}

export interface RagMultiCorpusQuery {
  readonly schemaVersion: "1";
  readonly id: string;
  readonly enterpriseName: string;
  readonly queryType: string;
  readonly query: string;
  readonly sourceRowCount: number;
  readonly supportingFacts: readonly RagMultiCorpusSupportingFact[];
  readonly evidenceDocumentPaths: readonly string[];
  readonly missingEvidenceFiles: readonly string[];
  readonly sourceStatus: RagMultiCorpusSourceStatus;
}

export interface RagMultiCorpusDocument {
  readonly path: string;
  readonly enterpriseName: string;
  readonly filename: string;
  readonly sha256: string;
  readonly content: string;
}

export interface RagMultiCorpusAdapterOptions {
  readonly datasetVersion: string;
  readonly split?: "dev" | "test";
  readonly topK?: number;
  readonly contextTokenBudget?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`RAG-Multi-Corpus ${field} must be a non-empty trimmed string`);
  }
}

function requireNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`RAG-Multi-Corpus ${field} must be a non-blank string`);
  }
}

function capability(queryType: string): string {
  requireNonEmpty(queryType, "queryType");
  const normalized = queryType.toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) throw new Error("RAG-Multi-Corpus queryType is invalid");
  return normalized;
}

function validateQuery(query: RagMultiCorpusQuery): void {
  if (query.schemaVersion !== "1" || !Number.isSafeInteger(query.sourceRowCount) ||
      query.sourceRowCount < 1 || query.supportingFacts.length === 0) {
    throw new Error(`invalid RAG-Multi-Corpus query '${query.id}'`);
  }
  for (const [field, value] of [["id", query.id], ["enterpriseName", query.enterpriseName],
    ["query", query.query]] as const) requireNonEmpty(value, field);
  for (const fact of query.supportingFacts) {
    requireNonEmpty(fact.filename, "supportingFacts.filename");
    requireNonEmpty(fact.text, "supportingFacts.text");
  }
  if (new Set(query.evidenceDocumentPaths).size !== query.evidenceDocumentPaths.length ||
      new Set(query.missingEvidenceFiles).size !== query.missingEvidenceFiles.length) {
    throw new Error(`RAG-Multi-Corpus query '${query.id}' contains duplicate evidence identities`);
  }
  if (query.sourceStatus === "complete" && query.missingEvidenceFiles.length > 0) {
    throw new Error(`RAG-Multi-Corpus query '${query.id}' has inconsistent source status`);
  }
  if (query.sourceStatus !== "complete") {
    throw new Error(
      `RAG-Multi-Corpus query '${query.id}' is ${query.sourceStatus}: ` +
      query.missingEvidenceFiles.join(", "),
    );
  }
}

function validateDocuments(documents: readonly RagMultiCorpusDocument[]): Map<string, RagMultiCorpusDocument> {
  if (documents.length === 0) throw new Error("RAG-Multi-Corpus shared corpus is empty");
  const byPath = new Map<string, RagMultiCorpusDocument>();
  for (const document of documents) {
    requireNonEmpty(document.path, "document.path");
    requireNonEmpty(document.enterpriseName, "document.enterpriseName");
    requireNonBlank(document.filename, "document.filename");
    if (!SHA256.test(document.sha256) || !document.content.trim()) {
      throw new Error(`invalid RAG-Multi-Corpus document '${document.path}'`);
    }
    if (byPath.has(document.path)) {
      throw new Error(`duplicate RAG-Multi-Corpus document '${document.path}'`);
    }
    byPath.set(document.path, document);
  }
  return byPath;
}

function eventId(path: string): string {
  return `ragmc:${path}`;
}

export function adaptRagMultiCorpusQuery(
  query: RagMultiCorpusQuery,
  documents: readonly RagMultiCorpusDocument[],
  options: RagMultiCorpusAdapterOptions,
): Readonly<EvalCaseV2> {
  validateQuery(query);
  requireNonEmpty(options.datasetVersion, "datasetVersion");
  const byPath = validateDocuments(documents);
  for (const path of query.evidenceDocumentPaths) {
    if (!byPath.has(path)) {
      throw new Error(`RAG-Multi-Corpus evidence document '${path}' is missing from shared corpus`);
    }
  }
  const evidencePaths = new Set(query.evidenceDocumentPaths);

  return parseEvalCaseV2({
    schemaVersion: "2",
    id: query.id,
    track: "general",
    benchmarkId: "rag-multi-corpus-kb-pilot",
    datasetVersion: options.datasetVersion,
    split: options.split ?? "test",
    capability: capability(query.queryType),
    memoryStream: documents.map((document) => ({
      eventId: eventId(document.path),
      occurredAt: "2025-12-22T00:00:00.000Z",
      payload: {
        enterpriseName: document.enterpriseName,
        path: document.path,
        filename: document.filename,
        sha256: document.sha256,
        content: document.content,
      },
      ...(evidencePaths.has(document.path) ? { evidenceRef: eventId(document.path) } : {}),
    })),
    query: { text: query.query, expectedMode: "answer" },
    gold: {
      requiredEvidenceRefs: query.evidenceDocumentPaths.map(eventId),
    },
    protocol: {
      ingestMode: "batch",
      topK: options.topK ?? 6,
      contextTokenBudget: options.contextTokenBudget ?? 32_768,
    },
    official: {
      enterpriseName: query.enterpriseName,
      queryType: query.queryType,
      sourceRowCount: query.sourceRowCount,
      supportingFacts: query.supportingFacts.map((fact) => ({ ...fact })),
      answerGoldStatus: "absent",
      scorerStatus: "manual-unversioned",
      sourceStatus: query.sourceStatus,
    },
  });
}
