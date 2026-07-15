import type { MemoryScope } from "../../../packages/core/src/domain/types.js";
import {
  appendLeafToBuffer,
  InMemoryTreeRepository,
} from "../../../packages/core/src/tree/buffer.js";
import { validateFaithfulness } from "../../../packages/core/src/tree/faithfulness.js";
import { sealBuffer } from "../../../packages/core/src/tree/seal.js";
import type { TreeLeaf, TreeSummaryNode } from "../../../packages/core/src/tree/types.js";

import { createMetric } from "./eval-metrics.js";
import {
  loadExtensionSuite,
  type ContractIssue,
  type TreeKeyFact,
  type TreeSummaryCase,
  type TreeTextLeaf,
} from "./extension-loaders.js";
import type { EvalExecutionMetadata, EvalMetricResult } from "./types.js";

const EXPECTED_CASE_COUNT = 8;
const FIXED_NOW = Date.parse("2026-06-20T00:00:00.000Z");
const HARNESS_SCOPE: MemoryScope = Object.freeze({
  tenantId: "eval",
  appId: "mengshu-eval",
  userId: "tree-summary",
  projectId: "tree-summary-golden",
  agentId: "tree-summary-runner",
  namespace: "tree-summary-eval",
  sessionId: "tree-summary-eval",
});

export interface TreeSummaryActualNode {
  id: string;
  treeType: "source" | "topic" | "global";
  level: number;
  summary: string;
  summaryMode: string | null;
  summaryFragments: string[];
  leafIds: string[];
  evidenceChunkIds: string[];
  status: string;
}

export interface TreeSummaryActual {
  node: TreeSummaryActualNode | null;
  faithfulness: { valid: boolean; usedLlmJudge: boolean; reason?: string } | null;
  groundedExtractive: boolean | null;
  structuredKeyFacts: TreeKeyFact[];
}

export interface TreeSummaryCaseResult {
  caseId: string;
  actual: TreeSummaryActual;
  passed: boolean;
  failures: string[];
  unsupportedContracts: string[];
  productionInvocations: {
    appendLeafToBuffer: number;
    sealBuffer: number;
    validateFaithfulness: number;
  };
}

export interface TreeSummaryRun {
  suite: "mengshu-tree-summary";
  total: number;
  passed: number;
  failed: number;
  results: TreeSummaryCaseResult[];
  metrics: EvalMetricResult[];
  execution: EvalExecutionMetadata;
  componentBoundary: {
    productionEntry: "appendLeafToBuffer/sealBuffer/validateFaithfulness";
    summaryMode: "production_extractive";
    scopePolicy: "fixed_isolation_scope";
    timePolicy: "fixed_case_clock_and_monotonic_leaf_event_time";
    keyFactsOutput: "extractive_fragments_with_production_leaf_evidence";
  };
  qualityGatePassed: boolean;
  gateFailures: string[];
  contractIssues: ContractIssue[];
}

function isTextLeaf(
  leaf: TreeSummaryCase["leaves"] extends Array<infer T> | undefined ? T : never,
): leaf is TreeTextLeaf {
  return "id" in leaf && "body" in leaf;
}

function textLeaves(goldenCase: TreeSummaryCase): TreeTextLeaf[] {
  return (goldenCase.leaves ?? []).filter(isTextLeaf);
}

function unsupportedContracts(goldenCase: TreeSummaryCase): string[] {
  const unsupported: string[] = [];
  if (!goldenCase.leaves || goldenCase.leaves.length === 0 ||
      goldenCase.leaves.some((leaf) => !isTextLeaf(leaf))) {
    unsupported.push("text_leaves_required");
  }
  if (goldenCase.llm_summary !== undefined) unsupported.push("fixture_llm_summary");
  if (goldenCase.level !== undefined) unsupported.push("fixture_fold_level");
  if (goldenCase.buffer_size !== undefined || goldenCase.seal_threshold !== undefined) {
    unsupported.push("fixture_buffer_size_without_production_policy");
  }
  if (goldenCase.existing_summary !== undefined || goldenCase.new_leaves !== undefined) {
    unsupported.push("fixture_incremental_summary");
  }
  if (goldenCase.expected.rejected !== undefined || goldenCase.expected.reason !== undefined ||
      goldenCase.expected.keyFacts_missing_evidence !== undefined ||
      goldenCase.expected.folding_correct !== undefined ||
      goldenCase.expected.seal_triggered !== undefined ||
      goldenCase.expected.summary_generated !== undefined ||
      goldenCase.expected.summary_updated !== undefined ||
      goldenCase.expected.incremental !== undefined) {
    unsupported.push("unsupported_expected_variant");
  }
  return unsupported;
}

function normalizeNode(node: TreeSummaryNode): TreeSummaryActualNode {
  return {
    id: node.id,
    treeType: node.treeType,
    level: node.level,
    summary: node.summary,
    summaryMode: typeof node.metadata.summaryMode === "string"
      ? node.metadata.summaryMode
      : null,
    summaryFragments: node.summary.split(/\n\n+/).map((item) => item.trim()).filter(Boolean),
    leafIds: [...node.leafIds],
    evidenceChunkIds: [...node.evidenceChunkIds],
    status: node.status,
  };
}

function toProductionLeaf(leaf: TreeTextLeaf, caseId: string, index: number): TreeLeaf {
  const eventAt = FIXED_NOW + index;
  return {
    id: leaf.id,
    scope: HARNESS_SCOPE,
    chunkId: `eval-chunk:${leaf.id}`,
    sourceId: `eval-source:${caseId}`,
    entityIds: [],
    importance: 0.5,
    eventAt,
    createdAt: eventAt,
    text: leaf.body,
    tokenCount: Math.max(1, Math.ceil(leaf.body.length / 4)),
  };
}

function actualKeyFacts(node: TreeSummaryActualNode, leaves: TreeTextLeaf[]): TreeKeyFact[] {
  const idsByBody = new Map(leaves.map((leaf) => [leaf.body.trim(), leaf.id]));
  return node.summaryFragments.flatMap((fragment) => {
    const leafId = idsByBody.get(fragment);
    return leafId ? [{ fact: fragment, evidence: [leafId] }] : [];
  });
}

function groundedExtractive(
  node: TreeSummaryActualNode,
  keyFacts: TreeKeyFact[],
): boolean {
  if (node.summaryMode !== "extractive" || keyFacts.length !== node.summaryFragments.length) {
    return false;
  }
  return keyFacts.every((fact) =>
    fact.evidence.length > 0 && fact.evidence.every((leafId) =>
      node.leafIds.includes(leafId) && node.evidenceChunkIds.includes(`eval-chunk:${leafId}`),
    ),
  );
}

function compareExpected(
  goldenCase: TreeSummaryCase,
  actual: TreeSummaryActual,
): string[] {
  const failures: string[] = [];
  const expected = goldenCase.expected;
  if (!actual.node || !actual.faithfulness) return ["production_node:missing"];
  if (expected.summary !== undefined && actual.node.summary !== expected.summary) {
    failures.push("summary:mismatch");
  }
  if (expected.keyFacts !== undefined &&
      JSON.stringify(actual.structuredKeyFacts) !== JSON.stringify(expected.keyFacts)) {
    failures.push("keyFacts:mismatch");
  }
  if (expected.faithfulness !== undefined &&
      Number(actual.faithfulness.valid) !== expected.faithfulness) {
    failures.push("faithfulness:mismatch");
  }
  if (expected.evidence_rate !== undefined) {
    const supported = actual.structuredKeyFacts.filter((fact) => fact.evidence.length > 0).length;
    const rate = actual.structuredKeyFacts.length === 0
      ? 0
      : supported / actual.structuredKeyFacts.length;
    if (rate !== expected.evidence_rate) failures.push("evidence_rate:mismatch");
  }
  return failures;
}

async function evaluateCase(goldenCase: TreeSummaryCase): Promise<TreeSummaryCaseResult> {
  const unsupported = unsupportedContracts(goldenCase);
  const leaves = textLeaves(goldenCase);
  let actual: TreeSummaryActual = {
    node: null,
    faithfulness: null,
    groundedExtractive: null,
    structuredKeyFacts: [],
  };
  let appendInvocations = 0;
  let sealInvocations = 0;
  let faithfulnessInvocations = 0;

  if (unsupported.length === 0) {
    const repository = new InMemoryTreeRepository();
    let buffer;
    for (const [index, leaf] of leaves.entries()) {
      const appended = await appendLeafToBuffer(repository, {
        scope: HARNESS_SCOPE,
        treeType: goldenCase.treeType,
        treeKey: `eval:${goldenCase.id}`,
        leaf: toProductionLeaf(leaf, goldenCase.id, index),
        now: FIXED_NOW + index,
      });
      appendInvocations += 1;
      buffer = appended.buffer;
    }
    if (buffer) {
      const sealed = await sealBuffer(repository, {
        buffer,
        now: FIXED_NOW + 10_000,
        title: `eval:${goldenCase.id}`,
      });
      sealInvocations += 1;
      const faithfulness = await validateFaithfulness({
        node: sealed,
        buffer,
        evidenceTexts: leaves.map((leaf) => leaf.body),
        config: { mode: "off", failAction: "fallback_extractive" },
      });
      faithfulnessInvocations += 1;
      const node = normalizeNode(sealed);
      const keyFacts = actualKeyFacts(node, leaves);
      actual = {
        node,
        faithfulness,
        groundedExtractive: groundedExtractive(node, keyFacts),
        structuredKeyFacts: keyFacts,
      };
    }
  }

  const failures = [
    ...unsupported.map((name) => `unsupported_contract:${name}`),
    ...(unsupported.length === 0 ? compareExpected(goldenCase, actual) : []),
  ];
  return {
    caseId: goldenCase.id,
    actual,
    passed: failures.length === 0,
    failures,
    unsupportedContracts: unsupported,
    productionInvocations: {
      appendLeafToBuffer: appendInvocations,
      sealBuffer: sealInvocations,
      validateFaithfulness: faithfulnessInvocations,
    },
  };
}

function metricFailure(metric: EvalMetricResult): string {
  return metric.failure ?? `${metric.name}: value=${metric.value} 未满足 ${metric.direction} ${metric.threshold}`;
}

export async function runTreeSummarySuite(fixturePath: string): Promise<TreeSummaryRun> {
  const loaded = loadExtensionSuite(fixturePath, "mengshu-tree-summary");
  if (loaded.cases.length !== EXPECTED_CASE_COUNT) {
    throw new Error(`[tree-summary-v1] expected ${EXPECTED_CASE_COUNT} cases, got ${loaded.cases.length}`);
  }
  const results: TreeSummaryCaseResult[] = [];
  for (const goldenCase of loaded.cases) results.push(await evaluateCase(goldenCase));
  const nodes = results.filter((result) => result.actual.node !== null);
  const facts = nodes.flatMap((result) => result.actual.structuredKeyFacts.map((fact) => ({
    fact,
    node: result.actual.node!,
  })));
  const metrics = [
    createMetric({
      name: "faithfulness",
      numerator: nodes.filter((result) =>
        result.actual.faithfulness?.valid === true && result.actual.groundedExtractive === true,
      ).length,
      denominator: nodes.length,
      direction: "min",
      threshold: 0.95,
    }),
    createMetric({
      name: "key_fact_evidence_rate",
      numerator: facts.filter(({ fact, node }) => fact.evidence.length > 0 &&
        fact.evidence.every((id) =>
          node.leafIds.includes(id) && node.evidenceChunkIds.includes(`eval-chunk:${id}`),
        )).length,
      denominator: facts.length,
      direction: "exact",
      threshold: 1,
    }),
  ];
  const failedResults = results.filter((result) => !result.passed);
  const gateFailures = [
    ...metrics.filter((metric) => !metric.passed).map(metricFailure),
    ...(failedResults.length > 0 ? [`case_contract_failures:${failedResults.length}`] : []),
    ...(loaded.contractIssues.length > 0 ? [`fixture_contract_issues:${loaded.contractIssues.length}`] : []),
    ...loaded.contractIssues.map((issue) =>
      `fixture_contract_issue:${issue.caseId ?? issue.suite}:${issue.code}`),
  ];
  return {
    suite: "mengshu-tree-summary",
    total: results.length,
    passed: results.length - failedResults.length,
    failed: failedResults.length,
    results,
    metrics,
    execution: {
      runMode: "offline-component",
      provider: null,
      model: null,
      prompt: null,
      version: "tree-summary-v1",
      fallback: false,
      degraded: false,
    },
    componentBoundary: {
      productionEntry: "appendLeafToBuffer/sealBuffer/validateFaithfulness",
      summaryMode: "production_extractive",
      scopePolicy: "fixed_isolation_scope",
      timePolicy: "fixed_case_clock_and_monotonic_leaf_event_time",
      keyFactsOutput: "extractive_fragments_with_production_leaf_evidence",
    },
    qualityGatePassed: gateFailures.length === 0,
    gateFailures,
    contractIssues: loaded.contractIssues,
  };
}
