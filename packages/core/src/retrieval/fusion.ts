/**
 * Rank fusion helpers for hybrid retrieval.
 *
 * M5 使用 Reciprocal Rank Fusion 合并 vector、text、recent 等检索源；
 * 同一条记录按 record id 去重，并保留各来源 score breakdown，便于 explain。
 */

import type { RecallHit } from "../domain/types.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import { computeRecallScoreBreakdown, type RecallMatchedBy } from "../domain/recall-scoring.js";
import { computeScopeFit } from "../domain/scope-fit.js";

export interface RankedHits {
  source: RecallHit["source"];
  hits: RecallHit[];
}

export interface FuseHitsOptions {
  k?: number;
  limit?: number;
  scope?: MemoryScope;
}

function hitKey(hit: RecallHit): string {
  return hit.record.id;
}

function isMemoryHit(hit: RecallHit): hit is RecallHit & { record: MemoryRecord } {
  const record = hit.record as Partial<MemoryRecord>;
  return typeof record.text === "string" && typeof record.contentHash === "string" &&
    typeof record.importance === "number" && typeof record.kind === "string" &&
    Boolean(record.metadata && typeof record.metadata === "object") &&
    Boolean(record.provenance && typeof record.provenance === "object");
}

export function fuseHits(inputs: RankedHits[], options: FuseHitsOptions = {}): RecallHit[] {
  const k = options.k ?? 60;
  const fused = new Map<string, RecallHit & { record: MemoryRecord }>();
  const fusionScores = new Map<string, number>();
  const matchedBy = new Map<string, RecallMatchedBy[]>();
  const sourceSignals = new Map<string, Record<string, number>>();

  for (const input of inputs) {
    input.hits.filter(isMemoryHit).forEach((hit, index) => {
      const key = hitKey(hit);
      const rrf = 1 / (k + index + 1);
      const current = fused.get(key);
      const currentScore = fusionScores.get(key) ?? 0;
      fusionScores.set(key, currentScore + rrf);
      const matched = matchedBy.get(key) ?? [];
      if (!matched.includes(input.source)) matched.push(input.source);
      matchedBy.set(key, matched);
      sourceSignals.set(key, {
        ...(sourceSignals.get(key) ?? {}),
        [input.source]: hit.score,
      });

      if (!current || hit.score > current.score) {
        fused.set(key, {
          ...hit,
          source: input.source,
        });
        return;
      }
    });
  }

  return Array.from(fused.entries())
    .map(([key, hit]) => {
      const rrf = fusionScores.get(key) ?? 0;
      const maximumRrf = inputs.length === 0 ? 1 : inputs.length / (k + 1);
      const relevance = maximumRrf <= 0 ? 0 : Math.min(1, rrf / maximumRrf);
      const signals = { ...(sourceSignals.get(key) ?? {}), rrf };
      const breakdown = computeRecallScoreBreakdown(
        hit.record,
        {
          relevance,
          scopeFit: options.scope ? computeScopeFit(options.scope, hit.record.scope) : 1,
        },
        matchedBy.get(key) ?? [hit.source],
        signals,
      );
      return { ...hit, score: breakdown.score, scoreBreakdown: breakdown };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
}
