/**
 * In-memory BM25 text index.
 *
 * 用于 M5 的混合检索 contract baseline：英文按词切分，CJK 使用字符 bigram，
 * 并在同一个 scope 内执行搜索和过滤。该实现不承担进程外持久化。
 */

import type { MemoryScope, RecallHit } from "../../domain/types.js";
import type { TextIndex, TextIndexDocument, TextSearchInput } from "./text-index.js";

interface IndexedDocument extends TextIndexDocument {
  tokens: string[];
  termCounts: Map<string, number>;
}

const K1 = 1.2;
const B = 0.75;

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId &&
    left.appId === right.appId &&
    left.userId === right.userId &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.namespace === right.namespace;
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function cjkBigrams(text: string): string[] {
  const chars = Array.from(text.replace(/\s+/g, "").toLowerCase()).filter((char) => /\p{L}|\p{N}/u.test(char));
  if (chars.length <= 1) {
    return chars;
  }
  const tokens: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(`${chars[index]}${chars[index + 1]}`);
  }
  return tokens;
}

export function tokenizeForBm25(text: string): string[] {
  if (hasCjk(text)) {
    return cjkBigrams(text);
  }
  return text
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function matchesFilter(document: IndexedDocument, filter?: Record<string, unknown>): boolean {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }
  const metadata = document.metadata ?? {};
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

export class InMemoryBm25Index implements TextIndex {
  private readonly documents = new Map<string, IndexedDocument>();

  async upsert(documents: TextIndexDocument[]): Promise<void> {
    for (const document of documents) {
      const tokens = tokenizeForBm25(document.text);
      this.documents.set(document.id, {
        ...document,
        tokens,
        termCounts: termCounts(tokens),
      });
    }
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.documents.delete(id);
    }
  }

  async search(input: TextSearchInput): Promise<RecallHit[]> {
    const queryTokens = Array.from(new Set(tokenizeForBm25(input.query)));
    if (queryTokens.length === 0) {
      return [];
    }

    const candidates = Array.from(this.documents.values())
      .filter((document) => sameScope(document.scope, input.scope))
      .filter((document) => matchesFilter(document, input.filter));
    if (candidates.length === 0) {
      return [];
    }

    const averageLength = candidates.reduce((sum, document) => sum + document.tokens.length, 0) / candidates.length;
    const documentFrequency = new Map<string, number>();
    for (const token of queryTokens) {
      documentFrequency.set(
        token,
        candidates.filter((document) => document.termCounts.has(token)).length,
      );
    }

    return candidates
      .map((document) => {
        let score = 0;
        for (const token of queryTokens) {
          const frequency = document.termCounts.get(token) ?? 0;
          if (frequency === 0) {
            continue;
          }
          const df = documentFrequency.get(token) ?? 0;
          const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
          const lengthNorm = 1 - B + B * (document.tokens.length / averageLength);
          score += idf * ((frequency * (K1 + 1)) / (frequency + K1 * lengthNorm));
        }
        return {
          ...document.hit,
          score,
          source: "text" as const,
          scoreBreakdown: {
            ...(document.hit.scoreBreakdown ?? {}),
            text: score,
          },
        };
      })
      .filter((hit) => hit.score > 0 && hit.score >= (input.minScore ?? 0))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit ?? Number.POSITIVE_INFINITY);
  }

  async count(filter: { scope?: MemoryScope } = {}): Promise<number> {
    return Array.from(this.documents.values())
      .filter((document) => !filter.scope || sameScope(document.scope, filter.scope))
      .length;
  }
}
