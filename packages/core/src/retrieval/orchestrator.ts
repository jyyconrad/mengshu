/**
 * Hybrid retrieval orchestrator.
 *
 * 该层并行调用 vector/text/recent source，并用 RRF 产出可解释 RecallResult；
 * 它是 `MemoryService` 后续替换单一路径检索的中间层。
 */

import { normalizeScope } from "../core/scope.js";
import type { MemoryScopeInput, RecallHit, RecallResult } from "../core/types.js";
import { fuseHits } from "./fusion.js";

export interface RetrievalQuery {
  query: string;
  scope?: MemoryScopeInput;
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
}

export interface RetrievalSource {
  source: RecallHit["source"];
  search(input: Required<Pick<RetrievalQuery, "query">> & Omit<RetrievalQuery, "query">): Promise<RecallHit[]>;
}

export interface RetrievalOrchestratorOptions {
  sources: RetrievalSource[];
  fusionK?: number;
}

export class RetrievalOrchestrator {
  constructor(private readonly options: RetrievalOrchestratorOptions) {}

  async recall(input: RetrievalQuery): Promise<RecallResult> {
    const scope = normalizeScope(input.scope);
    const sourceResults = await Promise.all(
      this.options.sources.map(async (source) => ({
        source: source.source,
        hits: await source.search({
          ...input,
          scope,
          query: input.query,
        }),
      })),
    );
    const hits = fuseHits(sourceResults, {
      k: this.options.fusionK,
      limit: input.limit,
    });

    return {
      scope,
      query: input.query,
      hits,
    };
  }
}
