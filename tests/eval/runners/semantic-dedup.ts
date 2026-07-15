import {
  SemanticDeduplicator,
  type DedupResult,
} from "../../../packages/core/src/lifecycle/semantic-dedup.js";
import { Embeddings } from "../../../packages/core/src/runtime/llm/embeddings.js";

import { createMetric } from "./eval-metrics.js";
import {
  loadExtensionSuite,
  type ContractIssue,
  type SemanticDedupCase,
} from "./extension-loaders.js";
import type {
  EvalExecutionMetadata,
  EvalMetricResult,
} from "./types.js";

const VECTOR_DIMENSIONS = 2048;
const FIXED_SALIENCE = 0.5;

/**
 * 完全离线、与 golden label 无关的文本特征 provider。
 * 仅做 NFKC/lowercase/标点空白归一化 + 2/3 字符 n-gram hashing；
 * 不含任何领域同义词表，也不读取 expected relation。
 */
class DeterministicHashedCharNgramEmbeddings extends Embeddings {
  constructor() {
    super({
      provider: "openai",
      apiKey: "offline-component",
      baseURL: "http://127.0.0.1",
      model: "char-ngram-v1",
    });
  }

  override async embed(text: string): Promise<number[]> {
    return vectorize(text);
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(vectorize);
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function lexicalFeatures(text: string): string[] {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (normalized.length === 0) return ["empty"];

  const characters = Array.from(normalized);
  const features: string[] = [];
  for (const size of [2, 3]) {
    if (characters.length < size) continue;
    for (let index = 0; index <= characters.length - size; index++) {
      features.push(`${size}:${characters.slice(index, index + size).join("")}`);
    }
  }
  if (features.length === 0) features.push(`1:${normalized}`);
  return features;
}

function vectorize(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const feature of lexicalFeatures(text)) {
    const bucketHash = fnv1a(feature);
    const signHash = fnv1a(`sign:${feature}`);
    const bucket = bucketHash % VECTOR_DIMENSIONS;
    vector[bucket] += (signHash & 1) === 0 ? 1 : -1;
  }
  return vector;
}

export interface SemanticDedupActualResult {
  isDuplicate: boolean;
  reason?: DedupResult["reason"];
  duplicateOf?: string;
  similarity?: number;
  threshold?: number;
}

export interface SemanticDedupCaseResult {
  caseId: string;
  expectedRelation: SemanticDedupCase["expected"]["relation"];
  expectedDuplicate: boolean;
  actual: SemanticDedupActualResult;
  passed: boolean;
  failures: string[];
  unsupportedContracts: string[];
}

export interface SemanticDedupRun {
  suite: "mengshu-dedup";
  total: number;
  passed: number;
  failed: number;
  results: SemanticDedupCaseResult[];
  metrics: EvalMetricResult[];
  execution: EvalExecutionMetadata;
  componentBoundary: {
    productionEntry: "SemanticDeduplicator.checkDuplicate";
    output: "binary_duplicate_only";
    embeddingMode: "deterministic_label_independent_char_ngram";
    fixedSalience: 0.5;
    salienceBranchesCovered: readonly ["low_salience"];
    salienceBranchesNotCovered: readonly ["high_value"];
  };
  diagnostics: {
    /** manifest 当前没有 duplicate recall gate；仅作为诚实能力可见性，不参与放行。 */
    binaryDuplicateRecall: {
      numerator: number;
      denominator: number;
      value: number;
    };
  };
  qualityGatePassed: boolean;
  gateFailures: string[];
  contractIssues: ContractIssue[];
}

function outputContractFailures(actual: SemanticDedupActualResult): string[] {
  if (!actual.isDuplicate) {
    return actual.reason === undefined && actual.duplicateOf === undefined &&
      actual.similarity === undefined && actual.threshold === undefined
      ? []
      : ["actual.non_duplicate:unexpected_duplicate_fields"];
  }
  if (actual.reason !== "high_value_duplicate" &&
      actual.reason !== "low_salience_duplicate") {
    return ["actual.duplicate.reason:invalid"];
  }
  if (!actual.duplicateOf || !Number.isFinite(actual.similarity) ||
      actual.similarity! < -1 - 1e-12 || actual.similarity! > 1 + 1e-12 ||
      !Number.isFinite(actual.threshold) || actual.threshold! < 0 ||
      actual.threshold! > 1) {
    return ["actual.duplicate:invalid"];
  }
  return [];
}

async function evaluateCase(
  goldenCase: SemanticDedupCase,
  deduplicator: SemanticDeduplicator,
): Promise<SemanticDedupCaseResult> {
  const productionResult = await deduplicator.checkDuplicate(
    {
      id: `${goldenCase.id}-memoryB`,
      text: goldenCase.memoryB.body,
      salience: FIXED_SALIENCE,
    },
    [
      {
        id: `${goldenCase.id}-memoryA`,
        text: goldenCase.memoryA.body,
        salience: FIXED_SALIENCE,
      },
    ],
  );
  const actual: SemanticDedupActualResult = {
    isDuplicate: productionResult.isDuplicate,
    reason: productionResult.reason,
    duplicateOf: productionResult.duplicateOf,
    similarity: productionResult.similarity,
    threshold: productionResult.threshold,
  };
  const expectedDuplicate = goldenCase.expected.relation === "duplicate";
  // 五分类 fixture 在 production binary boundary 上投影为 duplicate / non-duplicate。
  // prediction mismatch 只参与 manifest 声明的 precision/false-merge metrics，不能
  // 再伪装成 runner contract failure 覆盖质量门禁。
  const unsupported: string[] = [];
  const failures = outputContractFailures(actual);

  return {
    caseId: goldenCase.id,
    expectedRelation: goldenCase.expected.relation,
    expectedDuplicate,
    actual,
    passed: failures.length === 0,
    failures,
    unsupportedContracts: unsupported,
  };
}

function gateFailure(metric: EvalMetricResult): string {
  if (metric.failure) return metric.failure;
  return `${metric.name}: value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`;
}

export async function runSemanticDedupSuite(
  fixturePath: string,
): Promise<SemanticDedupRun> {
  const loaded = loadExtensionSuite(fixturePath, "mengshu-dedup");
  const embeddings = new DeterministicHashedCharNgramEmbeddings();
  const deduplicator = new SemanticDeduplicator(embeddings);
  const results: SemanticDedupCaseResult[] = [];
  for (const goldenCase of loaded.cases) {
    results.push(await evaluateCase(goldenCase, deduplicator));
  }

  const predictedDuplicates = results.filter((result) => result.actual.isDuplicate);
  const goldenDuplicates = results.filter((result) => result.expectedDuplicate);
  const goldenNonDuplicates = results.filter((result) => !result.expectedDuplicate);
  const metrics = [
    createMetric({
      name: "duplicate_precision",
      numerator: predictedDuplicates.filter((result) => result.expectedDuplicate).length,
      denominator: predictedDuplicates.length,
      direction: "min",
      threshold: 0.9,
    }),
    createMetric({
      name: "false_merge",
      numerator: goldenNonDuplicates.filter((result) => result.actual.isDuplicate).length,
      denominator: goldenNonDuplicates.length,
      direction: "max",
      threshold: 0.03,
    }),
  ];
  const failedResults = results.filter((result) => !result.passed);
  const gateFailures = [
    ...metrics.filter((metric) => !metric.passed).map(gateFailure),
    ...(failedResults.length > 0
      ? [`case_contract_failures:${failedResults.length}`]
      : []),
    ...(loaded.contractIssues.length > 0
      ? [`fixture_contract_issues:${loaded.contractIssues.length}`]
      : []),
  ];

  return {
    suite: "mengshu-dedup",
    total: results.length,
    passed: results.length - failedResults.length,
    failed: failedResults.length,
    results,
    metrics,
    execution: {
      runMode: "offline-component",
      provider: "deterministic-hashed-char-ngram",
      model: "char-ngram-v1",
      prompt: null,
      version: "semantic-dedup-v1",
      fallback: false,
      degraded: false,
    },
    componentBoundary: {
      productionEntry: "SemanticDeduplicator.checkDuplicate",
      output: "binary_duplicate_only",
      embeddingMode: "deterministic_label_independent_char_ngram",
      fixedSalience: FIXED_SALIENCE,
      salienceBranchesCovered: ["low_salience"],
      salienceBranchesNotCovered: ["high_value"],
    },
    diagnostics: {
      binaryDuplicateRecall: {
        numerator: goldenDuplicates.filter((result) => result.actual.isDuplicate).length,
        denominator: goldenDuplicates.length,
        value:
          goldenDuplicates.length === 0
            ? 0
            : goldenDuplicates.filter((result) => result.actual.isDuplicate).length /
              goldenDuplicates.length,
      },
    },
    qualityGatePassed: gateFailures.length === 0,
    gateFailures,
    contractIssues: loaded.contractIssues,
  };
}
