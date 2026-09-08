const ARTICLES = /\b(?:a|an|the)\b/g;
const PUNCTUATION = /[^\p{L}\p{N}\s]/gu;

export function normalizeMemoryAgentAnswer(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(PUNCTUATION, "")
    .replace(ARTICLES, " ").replace(/\s+/g, " ").trim();
}

function parsedAnswer(value: string): string {
  const match = /(?:answer:)(.*)(?:\n|$)/i.exec(value) ?? /^(.*)(?:\n|$)/.exec(value);
  return (match?.[1] ?? value).trim().replace(/^answer:/i, "").trim();
}

function f1(prediction: string, answer: string): number {
  const predicted = normalizeMemoryAgentAnswer(prediction).split(" ").filter(Boolean);
  const expected = normalizeMemoryAgentAnswer(answer).split(" ").filter(Boolean);
  if (["yes", "no", "noanswer"].includes(predicted.join(" ")) ||
      ["yes", "no", "noanswer"].includes(expected.join(" "))) {
    return predicted.join(" ") === expected.join(" ") ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
  let common = 0;
  for (const token of predicted) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      common += 1;
      counts.set(token, count - 1);
    }
  }
  if (common === 0 || predicted.length === 0 || expected.length === 0) return 0;
  const precision = common / predicted.length;
  const recall = common / expected.length;
  return 2 * precision * recall / (precision + recall);
}

/** Equivalent for official exact/F1/substring metrics, excluding optional ROUGE. */
export function scoreMemoryAgentAnswer(
  prediction: string,
  answers: readonly string[],
): Readonly<{ exactMatch: number; f1: number; substringExactMatch: number }> {
  if (answers.length === 0) throw new Error("MemoryAgentBench answers must not be empty");
  const parsed = parsedAnswer(prediction);
  const normalized = normalizeMemoryAgentAnswer(parsed);
  return Object.freeze({
    exactMatch: Math.max(...answers.map((answer) =>
      normalized === normalizeMemoryAgentAnswer(answer) ? 1 : 0)),
    f1: Math.max(...answers.map((answer) => f1(parsed, answer))),
    substringExactMatch: Math.max(...answers.map((answer) =>
      normalized.includes(normalizeMemoryAgentAnswer(answer)) ? 1 : 0)),
  });
}
