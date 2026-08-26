import { runCandidateExtractionSuite } from "./candidate-extraction.js";
import {
  runAssetPromotionSuite,
  runProgressiveDisclosureSuite,
  runSlotLoadoutSuite,
} from "./capability-contracts.js";
import { runConflictDetectionSuite } from "./conflict-detection.js";
import { runRecallExplainSuite } from "./recall-explain.js";
import { runSemanticDedupSuite } from "./semantic-dedup.js";
import { runSkillCandidateSuite } from "./skill-candidate.js";
import { runTreeSummarySuite } from "./tree-summary.js";
import type {
  CaseResult,
  EvalContractIssue,
  EvalExecutionMetadata,
  EvalMetricResult,
  SuiteSummary,
} from "./types.js";

export interface HonestExtensionCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/** Honest component runners 共享的最小结构合同。 */
export interface HonestExtensionRun {
  readonly suite: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly HonestExtensionCaseResult[];
  readonly metrics: readonly EvalMetricResult[];
  readonly execution: EvalExecutionMetadata;
  readonly qualityGatePassed: boolean;
  readonly gateFailures: readonly string[];
  readonly contractIssues: readonly EvalContractIssue[];
}

export interface QuickEvalRunnerResult {
  readonly results: CaseResult[];
  readonly summary: SuiteSummary;
}

export type QuickEvalRunner = (fixturePath: string) => Promise<QuickEvalRunnerResult>;

function assertRunIntegrity(run: HonestExtensionRun): void {
  const resultPassed = run.results.filter((result) => result.passed).length;
  const resultFailed = run.results.length - resultPassed;
  if (!Number.isSafeInteger(run.total) || run.total <= 0 ||
      run.total !== run.results.length || run.passed !== resultPassed ||
      run.failed !== resultFailed || run.total !== run.passed + run.failed ||
      run.qualityGatePassed !== (run.gateFailures.length === 0)) {
    throw new Error(`extension runner '${run.suite}' summary is inconsistent`);
  }
}

/**
 * 只做类型桥接，不重新 judge、不读取 expected，也不修改 runner verdict。
 * baseline 专属字段在 extension report 中不展示，兼容值固定为 0。
 */
export function adaptExtensionRun(run: HonestExtensionRun): QuickEvalRunnerResult {
  assertRunIntegrity(run);
  const results: CaseResult[] = run.results.map((result) => ({
    caseId: result.caseId,
    suite: run.suite,
    passed: result.passed,
    failures: [...result.failures],
    hitRequired: [],
    missedRequired: [],
    injectedForbidden: [],
    filledSlots: [],
    latencyMs: 0,
    tokenEstimate: 0,
  }));
  const failedCases = results.filter((result) => !result.passed);
  return {
    results,
    summary: {
      suite: run.suite,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      passRate: run.passed / run.total,
      slotRecallPassRate: 0,
      wrongInjectionRate: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      failedCases,
      metrics: run.metrics.map((metric) => ({ ...metric })),
      execution: { ...run.execution },
      gateFailures: [...run.gateFailures],
      contractIssues: run.contractIssues.map((issue) => ({ ...issue })),
    },
  };
}

function extensionRunner(
  run: (fixturePath: string) => Promise<HonestExtensionRun>,
): QuickEvalRunner {
  return async (fixturePath) => adaptExtensionRun(await run(fixturePath));
}

export const EXTENSION_RUNNER_REGISTRY: ReadonlyMap<string, QuickEvalRunner> = new Map([
  ["candidate-extraction-v1", extensionRunner(runCandidateExtractionSuite)],
  ["semantic-dedup-v1", extensionRunner(runSemanticDedupSuite)],
  ["recall-explain-v1", extensionRunner(runRecallExplainSuite)],
  ["conflict-detection-v1", extensionRunner(runConflictDetectionSuite)],
  ["tree-summary-v1", extensionRunner(runTreeSummarySuite)],
  ["skill-candidate-v1", extensionRunner(runSkillCandidateSuite)],
  ["progressive-disclosure-v1", extensionRunner(runProgressiveDisclosureSuite)],
  ["asset-promotion-v1", extensionRunner(runAssetPromotionSuite)],
  ["slot-loadout-v1", extensionRunner(runSlotLoadoutSuite)],
]);
