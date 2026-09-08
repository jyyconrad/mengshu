export interface LongMemEvalRetrievalScore {
  readonly recallAny: number;
  readonly recallAll: number;
  readonly ndcg: number;
}

function dcg(relevances: readonly number[], k: number): number {
  const values = relevances.slice(0, k);
  if (values.length === 0) return 0;
  return values[0]! + values.slice(1).reduce((sum, value, index) =>
    sum + value / Math.log2(index + 2), 0);
}

/** TypeScript-equivalent bridge for official src/retrieval/eval_utils.py. */
export function scoreLongMemEvalRetrieval(input: {
  readonly rankedIds: readonly string[];
  readonly correctIds: readonly string[];
  readonly corpusIds: readonly string[];
  readonly k: number;
}): LongMemEvalRetrievalScore {
  if (!Number.isSafeInteger(input.k) || input.k < 1 ||
      input.rankedIds.some((id) => !input.corpusIds.includes(id))) {
    throw new Error("invalid LongMemEval retrieval result");
  }
  const recalled = new Set(input.rankedIds.slice(0, input.k));
  const correct = new Set(input.correctIds);
  const relevances = input.corpusIds.map((id) => correct.has(id) ? 1 : 0);
  const rankedRelevances = input.rankedIds.slice(0, input.k).map((id) => correct.has(id) ? 1 : 0);
  const ideal = [...relevances].sort((left, right) => right - left);
  const idealDcg = dcg(ideal, input.k);
  return Object.freeze({
    recallAny: input.correctIds.some((id) => recalled.has(id)) ? 1 : 0,
    recallAll: input.correctIds.every((id) => recalled.has(id)) ? 1 : 0,
    ndcg: idealDcg === 0 ? 0 : dcg(rankedRelevances, input.k) / idealDcg,
  });
}
