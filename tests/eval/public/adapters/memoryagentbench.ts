import { createHash } from "node:crypto";

import { parseEvalCaseV2, type EvalCaseV2 } from "../protocol.js";

export type MemoryAgentBenchSplit =
  | "Accurate_Retrieval"
  | "Test_Time_Learning"
  | "Long_Range_Understanding"
  | "Conflict_Resolution";

export interface OfficialMemoryAgentBenchRow {
  readonly context: string;
  readonly questions: readonly string[];
  readonly answers: ReadonlyArray<readonly string[]>;
  readonly metadata: Readonly<{
    readonly source: string;
    readonly question_ids?: readonly string[];
    readonly question_types?: readonly string[];
    readonly qa_pair_ids?: readonly string[];
    readonly question_dates?: readonly string[];
    readonly previous_events?: readonly string[];
    readonly keypoints?: readonly string[];
    readonly haystack_sessions?: unknown;
    readonly demo?: string | null;
  }>;
}

const CAPABILITY: Readonly<Record<MemoryAgentBenchSplit, string>> = Object.freeze({
  Accurate_Retrieval: "accurate-retrieval",
  Test_Time_Learning: "test-time-learning",
  Long_Range_Understanding: "long-range-understanding",
  Conflict_Resolution: "conflict-resolution",
});

function id(raw: OfficialMemoryAgentBenchRow, index: number): string {
  return raw.metadata.question_ids?.[index] ?? raw.metadata.qa_pair_ids?.[index] ??
    `mab-${createHash("sha256").update(JSON.stringify([
      raw.metadata.source, index, raw.questions[index], raw.answers[index],
    ])).digest("hex").slice(0, 24)}`;
}

export function adaptMemoryAgentBenchRow(
  raw: OfficialMemoryAgentBenchRow,
  options: {
    readonly benchmarkSplit: MemoryAgentBenchSplit;
    readonly datasetVersion: string;
    readonly rowIndex?: number;
    readonly split?: "dev" | "test";
    readonly questionIndexes?: readonly number[];
  },
): readonly Readonly<EvalCaseV2>[] {
  if (!raw.context || !raw.metadata.source || raw.questions.length !== raw.answers.length) {
    throw new Error("invalid MemoryAgentBench row");
  }
  const eventId = `mab:${options.benchmarkSplit}:${options.rowIndex ?? 0}:context`;
  const questionIndexes = options.questionIndexes ?? raw.questions.map((_, index) => index);
  if (new Set(questionIndexes).size !== questionIndexes.length || questionIndexes.some((index) =>
    !Number.isSafeInteger(index) || index < 0 || index >= raw.questions.length)) {
    throw new Error("invalid MemoryAgentBench question indexes");
  }
  return Object.freeze(questionIndexes.map((index) => parseEvalCaseV2({
    schemaVersion: "2",
    id: id(raw, index),
    track: "general",
    benchmarkId: "memoryagentbench",
    datasetVersion: options.datasetVersion,
    split: options.split ?? "test",
    capability: CAPABILITY[options.benchmarkSplit],
    memoryStream: [{
      eventId,
      occurredAt: "1970-01-01T00:00:00.000Z",
      payload: {
        source: raw.metadata.source,
        context: raw.context,
        previousEvents: raw.metadata.previous_events ?? [],
        keypoints: raw.metadata.keypoints ?? [],
        haystackSessions: raw.metadata.haystack_sessions ?? null,
      },
      evidenceRef: eventId,
    }],
    query: { text: raw.questions[index], expectedMode: "answer" },
    gold: { answer: [...raw.answers[index]!], requiredEvidenceRefs: [eventId] },
    protocol: {
      ingestMode: "incremental",
      topK: 10,
      contextTokenBudget: 32_768,
      officialScorer: "memoryagentbench/utils/eval_other_utils.py@fe1735d",
    },
    official: {
      benchmarkSplit: options.benchmarkSplit,
      source: raw.metadata.source,
      rowIndex: options.rowIndex ?? 0,
      qaPairId: raw.metadata.qa_pair_ids?.[index] ?? null,
      questionType: raw.metadata.question_types?.[index] ?? null,
      questionDate: raw.metadata.question_dates?.[index] ?? null,
    },
  })));
}
