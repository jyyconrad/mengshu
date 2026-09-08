import type { EvalCaseV2 } from "../public/protocol.js";
import type { GeneralEvalEngine, GeneralEvalEngineResult } from "./general-runner.js";

interface PreparedEvent {
  readonly id: string;
  readonly occurredAt: number;
  readonly tokens: readonly string[];
  readonly tokenCount: number;
  readonly normalized: string;
}

const WORDS = /[\p{L}\p{N}]+/gu;

function tokens(value: string): string[] {
  return (value.toLocaleLowerCase("en-US").match(WORDS) ?? [])
    .flatMap((token) => /\p{Script=Han}/u.test(token) && token.length > 1
      ? [token, ...Array.from(token)]
      : [token]);
}

function payloadText(value: unknown): string {
  return JSON.stringify(value).toLocaleLowerCase("en-US");
}

function prepare(evalCase: Readonly<EvalCaseV2>): PreparedEvent[] {
  return evalCase.memoryStream.map((event) => {
    const normalized = payloadText(event.payload);
    const eventTokens = tokens(normalized);
    return Object.freeze({
      id: event.eventId,
      occurredAt: Date.parse(event.occurredAt),
      tokens: Object.freeze(eventTokens),
      tokenCount: Math.max(1, Math.ceil(normalized.length / 4)),
      normalized,
    });
  });
}

export function createNoMemoryEngine(): GeneralEvalEngine {
  return Object.freeze({
    id: "no-memory/v1",
    role: "no-memory" as const,
    async run(): Promise<GeneralEvalEngineResult> {
      return Object.freeze({
        status: "completed" as const,
        rankedEventIds: Object.freeze([]),
        contextTokens: 0,
        warnings: Object.freeze([]),
      });
    },
  });
}

export function createBudgetedFullContextEngine(): GeneralEvalEngine {
  return Object.freeze({
    id: "full-context-budgeted/v1",
    role: "full-context" as const,
    async run(evalCase: Readonly<EvalCaseV2>): Promise<GeneralEvalEngineResult> {
      const events = prepare(evalCase);
      const contextTokens = events.reduce((sum, event) => sum + event.tokenCount, 0);
      if (contextTokens > evalCase.protocol.contextTokenBudget) {
        return Object.freeze({
          status: "unavailable" as const,
          rankedEventIds: Object.freeze([]),
          contextTokens,
          warnings: Object.freeze(["full_context_exceeds_reader_budget"]),
          unavailableReason: "full_context_exceeds_reader_budget",
        });
      }
      return Object.freeze({
        status: "completed" as const,
        rankedEventIds: Object.freeze(events.map((event) => event.id)),
        contextTokens,
        scoreAtK: Math.max(1, events.length),
        warnings: Object.freeze([]),
      });
    },
  });
}

export function createLexicalDiagnosticEngine(input: {
  readonly cacheMode: "cold" | "warm";
  readonly cases?: readonly Readonly<EvalCaseV2>[];
}): GeneralEvalEngine {
  const cache = new Map<string, PreparedEvent[]>();
  if (input.cacheMode === "warm") {
    for (const evalCase of input.cases ?? []) cache.set(evalCase.id, prepare(evalCase));
  }
  return Object.freeze({
    id: "lexical-diagnostic-bm25/v1",
    role: "diagnostic" as const,
    async run(evalCase: Readonly<EvalCaseV2>): Promise<GeneralEvalEngineResult> {
      const events = cache.get(evalCase.id) ?? prepare(evalCase);
      cache.set(evalCase.id, events);
      const queryTokens = [...new Set(tokens(evalCase.query.text))];
      const averageLength = events.reduce((sum, event) => sum + event.tokens.length, 0) /
        Math.max(1, events.length);
      const documentFrequency = new Map<string, number>();
      for (const term of queryTokens) {
        documentFrequency.set(term, events.filter((event) => event.tokens.includes(term)).length);
      }
      const ranked = events.map((event) => {
        const frequencies = new Map<string, number>();
        for (const token of event.tokens) {
          if (documentFrequency.has(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
        }
        const score = queryTokens.reduce((sum, term) => {
          const frequency = frequencies.get(term) ?? 0;
          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (events.length - df + 0.5) / (df + 0.5));
          const denominator = frequency + 1.2 * (0.25 + 0.75 * event.tokens.length /
            Math.max(1, averageLength));
          return sum + idf * (frequency * 2.2 / Math.max(Number.EPSILON, denominator));
        }, 0) + (event.normalized.includes(evalCase.query.text.toLocaleLowerCase("en-US")) ? 2 : 0);
        return { event, score };
      }).sort((left, right) => right.score - left.score ||
        right.event.occurredAt - left.event.occurredAt || left.event.id.localeCompare(right.event.id));
      const selected = ranked.slice(0, evalCase.protocol.topK).map((item) => item.event);
      return Object.freeze({
        status: "completed" as const,
        rankedEventIds: Object.freeze(selected.map((event) => event.id)),
        contextTokens: selected.reduce((sum, event) => sum + event.tokenCount, 0),
        warnings: Object.freeze(["diagnostic_only_not_runtime_vector_retrieval"]),
      });
    },
  });
}
