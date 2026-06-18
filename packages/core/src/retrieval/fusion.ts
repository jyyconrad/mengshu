/**
 * Rank fusion helpers for hybrid retrieval.
 *
 * M5 使用 Reciprocal Rank Fusion 合并 vector、text、recent 等检索源；
 * 同一条记录按 record id 去重，并保留各来源 score breakdown，便于 explain。
 */

import type { RecallHit } from "../domain/types.js";

export interface RankedHits {
  source: RecallHit["source"];
  hits: RecallHit[];
}

export interface FuseHitsOptions {
  k?: number;
  limit?: number;
}

function hitKey(hit: RecallHit): string {
  return hit.record.id;
}

export function fuseHits(inputs: RankedHits[], options: FuseHitsOptions = {}): RecallHit[] {
  const k = options.k ?? 60;
  const fused = new Map<string, RecallHit>();
  const fusionScores = new Map<string, number>();

  for (const input of inputs) {
    input.hits.forEach((hit, index) => {
      const key = hitKey(hit);
      const rrf = 1 / (k + index + 1);
      const current = fused.get(key);
      const currentScore = fusionScores.get(key) ?? 0;
      fusionScores.set(key, currentScore + rrf);

      if (!current || hit.score > current.score) {
        fused.set(key, {
          ...hit,
          source: input.source,
          scoreBreakdown: {
            ...(current?.scoreBreakdown ?? {}),
            ...(hit.scoreBreakdown ?? {}),
            [input.source]: hit.score,
          },
        });
        return;
      }

      current.scoreBreakdown = {
        ...(current.scoreBreakdown ?? {}),
        ...(hit.scoreBreakdown ?? {}),
        [input.source]: hit.score,
      };
    });
  }

  return Array.from(fused.entries())
    .map(([key, hit]) => ({
      ...hit,
      score: fusionScores.get(key) ?? hit.score,
      scoreBreakdown: {
        ...(hit.scoreBreakdown ?? {}),
        rrf: fusionScores.get(key) ?? hit.score,
      },
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
}
