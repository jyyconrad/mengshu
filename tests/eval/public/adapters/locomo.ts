import { parseEvalCaseV2, type EvalCaseV2 } from "../protocol.js";

export interface OfficialLoCoMoTurn {
  readonly speaker: string;
  readonly dia_id: string;
  readonly text: string;
  readonly [key: string]: unknown;
}

export interface OfficialLoCoMoSample {
  readonly sample_id: string;
  readonly conversation: Readonly<Record<string, unknown>>;
  readonly qa: ReadonlyArray<{
    readonly question: string;
    readonly answer: unknown;
    readonly evidence: readonly string[];
    readonly category: number;
  }>;
}

const CATEGORY = new Map<number, string>([
  [1, "single-hop"], [2, "temporal-reasoning"], [3, "multi-hop"],
  [4, "open-domain"], [5, "adversarial"],
]);

function locomoDate(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid LoCoMo session date");
  const parsed = Date.parse(value.replace(/\bon\b/i, ""));
  if (!Number.isFinite(parsed)) throw new Error(`invalid LoCoMo session date '${value}'`);
  return new Date(parsed).toISOString();
}

export function adaptLoCoMoSample(
  raw: OfficialLoCoMoSample,
  options: { readonly datasetVersion: string; readonly split?: "dev" | "test" },
): readonly Readonly<EvalCaseV2>[] {
  const sessionKeys = Object.keys(raw.conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)));
  const memoryStream = sessionKeys.flatMap((sessionKey) => {
    const turns = raw.conversation[sessionKey];
    if (!Array.isArray(turns)) throw new Error(`invalid LoCoMo ${sessionKey}`);
    const occurredAt = locomoDate(raw.conversation[`${sessionKey}_date_time`]);
    return (turns as OfficialLoCoMoTurn[]).map((turn) => ({
      eventId: `${raw.sample_id}:${turn.dia_id}`,
      occurredAt,
      payload: structuredClone(turn),
      evidenceRef: turn.dia_id,
    }));
  });
  const available = new Set(memoryStream.map((event) => event.evidenceRef));
  return Object.freeze(raw.qa.map((qa, index) => {
    if (!qa.evidence.every((ref) => available.has(ref))) {
      throw new Error(`LoCoMo case '${raw.sample_id}:${index}' has unresolved evidence`);
    }
    return parseEvalCaseV2({
      schemaVersion: "2",
      id: `${raw.sample_id}:qa-${index + 1}`,
      track: "general",
      benchmarkId: "locomo",
      datasetVersion: options.datasetVersion,
      split: options.split ?? "test",
      capability: CATEGORY.get(qa.category) ?? `category-${qa.category}`,
      memoryStream,
      query: { text: qa.question, expectedMode: qa.category === 5 ? "abstain" : "answer" },
      gold: { answer: structuredClone(qa.answer), requiredEvidenceRefs: [...qa.evidence] },
      protocol: {
        ingestMode: "incremental",
        topK: 10,
        contextTokenBudget: 32_768,
        officialScorer: "locomo/task_eval/evaluate_qa.py@3eb6f2c",
      },
      official: { sampleId: raw.sample_id, category: qa.category },
    });
  }));
}
