import type { MemoryScope } from "../../domain/types.js";
import type {
  GovernedRetrievalCandidate,
  GovernedRetrievalCandidateSource,
  GovernedRetrievalEngine,
  GovernedRetrievalHit,
  GovernedRetrievalResult,
} from "../../retrieval/governed-retrieval-engine.js";

export interface GovernedReuseReference {
  readonly version: 1;
  readonly authoritativeRecordId: string;
  readonly sourceScope: MemoryScope;
  readonly evidenceIds: readonly string[];
}

/** No rendered text or former authorization decision is stored in a reusable cache reference. */
export class GovernedReuseReadService {
  constructor(
    private readonly source: GovernedRetrievalCandidateSource,
    private readonly engine: Pick<GovernedRetrievalEngine, "retrieve">,
  ) {}

  async lookup(input: {
    readonly scope: MemoryScope;
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<GovernedRetrievalResult> {
    const candidates = await this.source.search(input);
    return this.engine.retrieve({ intent: "lookup", scope: input.scope, candidates, limit: input.limit });
  }

  reference(hit: GovernedRetrievalHit): GovernedReuseReference {
    return Object.freeze({
      version: 1,
      authoritativeRecordId: hit.record.id,
      sourceScope: Object.freeze({ ...hit.record.scope }),
      evidenceIds: Object.freeze([...(hit.record.sourceNodeIds ?? [])]),
    });
  }

  explain(input: { readonly scope: MemoryScope; readonly reference: GovernedReuseReference }) {
    return this.#read(input.scope, [input.reference], "lookup");
  }

  dereference(input: { readonly scope: MemoryScope; readonly reference: GovernedReuseReference }) {
    return this.#read(input.scope, [input.reference], "lookup");
  }

  readCached(input: { readonly scope: MemoryScope; readonly references: readonly GovernedReuseReference[] }) {
    return this.#read(input.scope, input.references, "context");
  }

  async #read(
    scope: MemoryScope,
    references: readonly GovernedReuseReference[],
    intent: "lookup" | "context",
  ): Promise<GovernedRetrievalResult> {
    if (!Array.isArray(references) || references.length > 500) throw new TypeError("REUSE_REFERENCES_INVALID");
    const candidates: GovernedRetrievalCandidate[] = references.map((ref, index) => {
      if (ref?.version !== 1 || typeof ref.authoritativeRecordId !== "string" ||
          !/^[^\s\p{Cc}]{1,256}$/u.test(ref.authoritativeRecordId) || !ref.sourceScope ||
          !Array.isArray(ref.evidenceIds) || ref.evidenceIds.length === 0 || ref.evidenceIds.length > 500 ||
          ref.evidenceIds.some((id: unknown) => typeof id !== "string" || !/^[^\s\p{Cc}]{1,256}$/u.test(id))) {
        throw new TypeError("REUSE_REFERENCE_INVALID");
      }
      return {
        candidateId: `reference:${index}:${ref.authoritativeRecordId}`,
        authoritativeRecordId: ref.authoritativeRecordId, scope: ref.sourceScope,
        source: "lexical", nodeType: "memory", evidenceIds: ref.evidenceIds,
        // Exact ID access is not a new search score or a permission. The normal six-factor gate follows.
        relevance: 1,
        navigation: { kind: "memory", ref: ref.authoritativeRecordId },
      };
    });
    return this.engine.retrieve({ intent, scope, candidates });
  }
}
