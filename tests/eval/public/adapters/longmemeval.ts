import { createHash } from "node:crypto";

import { parseEvalCaseV2, type EvalCaseV2 } from "../protocol.js";

export interface OfficialLongMemEvalTurn {
  readonly role: "user" | "assistant" | string;
  readonly content: string;
  readonly has_answer?: boolean;
}

export interface OfficialLongMemEvalCase {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer: unknown;
  readonly question_date: string;
  readonly haystack_session_ids: readonly string[];
  readonly haystack_dates: readonly string[];
  readonly haystack_sessions: ReadonlyArray<readonly OfficialLongMemEvalTurn[]>;
  readonly answer_session_ids: readonly string[];
}

export interface LongMemEvalAdapterOptions {
  readonly datasetVersion: string;
  readonly split?: "dev" | "test";
  readonly topK?: number;
  readonly contextTokenBudget?: number;
}

const DATE = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/;

function officialDate(value: string): string {
  const match = DATE.exec(value);
  if (!match) throw new Error(`invalid LongMemEval date '${value}'`);
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`;
}

function assertAligned(raw: OfficialLongMemEvalCase): void {
  const size = raw.haystack_session_ids.length;
  if (!raw.question_id || !raw.question_type || !raw.question ||
      raw.haystack_dates.length !== size || raw.haystack_sessions.length !== size ||
      raw.answer_session_ids.some((id) => !raw.haystack_session_ids.includes(id))) {
    throw new Error(`invalid LongMemEval case '${raw.question_id}'`);
  }
}

export function adaptLongMemEvalCase(
  raw: OfficialLongMemEvalCase,
  options: LongMemEvalAdapterOptions,
): Readonly<EvalCaseV2> {
  assertAligned(raw);
  const answerSessions = new Set(raw.answer_session_ids);
  const sessionCounts = new Map<string, number>();
  for (const sessionId of raw.haystack_session_ids) {
    sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  return parseEvalCaseV2({
    schemaVersion: "2",
    id: raw.question_id,
    track: "general",
    benchmarkId: "longmemeval-cleaned",
    datasetVersion: options.datasetVersion,
    split: options.split ?? "test",
    capability: raw.question_id.endsWith("_abs") ? "abstention" : raw.question_type,
    memoryStream: raw.haystack_session_ids.map((sessionId, index) => {
      const occurrence = (occurrences.get(sessionId) ?? 0) + 1;
      occurrences.set(sessionId, occurrence);
      return {
        eventId: sessionCounts.get(sessionId) === 1
          ? sessionId
          : `${sessionId}#occurrence-${occurrence}`,
        occurredAt: officialDate(raw.haystack_dates[index]!),
        payload: {
          sessionId,
          occurrence,
          date: raw.haystack_dates[index],
          messages: structuredClone(raw.haystack_sessions[index]),
        },
        ...(answerSessions.has(sessionId) ? { evidenceRef: sessionId } : {}),
      };
    }),
    query: {
      text: raw.question,
      occurredAt: officialDate(raw.question_date),
      expectedMode: raw.question_id.endsWith("_abs") ? "abstain" : "answer",
    },
    gold: {
      answer: structuredClone(raw.answer),
      requiredEvidenceRefs: [...raw.answer_session_ids],
    },
    protocol: {
      ingestMode: "incremental",
      topK: options.topK ?? 10,
      contextTokenBudget: options.contextTokenBudget ?? 32_768,
      officialScorer: "longmemeval/src/evaluation/evaluate_qa.py@9e0b455",
    },
    official: {
      questionType: raw.question_type,
      answerSessionIds: [...raw.answer_session_ids],
      retrievalAbstentionExcluded: raw.question_id.endsWith("_abs"),
      duplicateSessionIds: [...sessionCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([sessionId]) => sessionId),
    },
  });
}

function orderKey(raw: OfficialLongMemEvalCase, seed: number): string {
  return createHash("sha256").update(`${seed}\0${raw.question_id}`).digest("hex");
}

export function selectLongMemEvalStratified(
  cases: readonly OfficialLongMemEvalCase[],
  size: number,
  seed: number,
): readonly OfficialLongMemEvalCase[] {
  if (!Number.isSafeInteger(size) || size < 1 || size > cases.length ||
      !Number.isSafeInteger(seed)) throw new Error("invalid stratified sampling input");
  const groups = new Map<string, OfficialLongMemEvalCase[]>();
  for (const value of cases) {
    assertAligned(value);
    const key = `${value.question_type}:${value.question_id.endsWith("_abs") ? "abs" : "answer"}`;
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => {
      const exact = size * values.length / cases.length;
      return {
        key,
        values: values.sort((left, right) =>
          orderKey(left, seed).localeCompare(orderKey(right, seed)) ||
          left.question_id.localeCompare(right.question_id)),
        quota: Math.floor(exact),
        remainder: exact - Math.floor(exact),
      };
    });
  let remaining = size - orderedGroups.reduce((sum, group) => sum + group.quota, 0);
  for (const group of [...orderedGroups].sort((left, right) =>
    right.remainder - left.remainder || left.key.localeCompare(right.key))) {
    if (remaining === 0) break;
    if (group.quota < group.values.length) {
      group.quota += 1;
      remaining -= 1;
    }
  }
  const selected = orderedGroups.flatMap((group) => group.values.slice(0, group.quota));
  if (selected.length !== size) throw new Error("unable to satisfy stratified sample size");
  return Object.freeze(selected.sort((left, right) => left.question_id.localeCompare(right.question_id)));
}
