import type { MemoryScope } from "../domain/types.js";
import { escapeMemoryForPrompt } from "../retrieval/prompt-safety.js";
import type {
  KnowledgeResourceContentItem,
  KnowledgeResourceIndexItem,
  KnowledgeResourceIndexResult,
  KnowledgeResourceReadResult,
  KnowledgeResourceRecord,
  KnowledgeResourceRepository,
  KnowledgeResourceSearchResult,
  KnowledgeResourceWarning,
} from "./knowledge-resource-types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_INDEX_ITEMS = 8;
const MAX_SEARCH_ITEMS = 8;
const MAX_CONTENT_CHARS = 4_000;
const MAX_QUERY_CHARS = 256;
const PATH_TRAVERSAL = /(?:^|[\\/])\.\.(?:$|[\\/])/;

export interface KnowledgeResourceCapabilityOptions {
  readonly timeoutMs?: number;
  readonly indexLimit?: number;
  readonly maxSearchItems?: number;
  readonly maxSearchContentChars?: number;
  readonly maxReadContentChars?: number;
}

class KnowledgeResourceTimeoutError extends Error {}

function inputInvalid(): never {
  throw new Error("KNOWLEDGE_RESOURCE_INPUT_INVALID");
}

function option(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) inputInvalid();
  return Math.min(value, max);
}

function requestedLimit(value: number | undefined, fallback: number): {
  readonly limit: number;
  readonly exceeded: boolean;
} {
  if (value === undefined) return { limit: fallback, exceeded: false };
  if (!Number.isSafeInteger(value) || value < 1) inputInvalid();
  return { limit: Math.min(value, fallback), exceeded: value > fallback };
}

function validateReadInput(ref: unknown, revision: unknown): asserts ref is string {
  if (typeof ref !== "string" || !UUID.test(ref) ||
      typeof revision !== "string" || !SAFE_REVISION.test(revision)) {
    inputInvalid();
  }
}

function validateQuery(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_QUERY_CHARS ||
      value !== value.trim() || /[\p{Cc}]/u.test(value) || PATH_TRAVERSAL.test(value)) {
    inputInvalid();
  }
}

function indexItem(record: KnowledgeResourceRecord): KnowledgeResourceIndexItem {
  if (!UUID.test(record.ref) || !SAFE_REVISION.test(record.revision) ||
      record.evidence.kind !== "knowledge_record" ||
      record.evidence.ref !== record.ref || record.evidence.revision !== record.revision ||
      typeof record.title !== "string" || typeof record.category !== "string" ||
      typeof record.createdAt !== "string") {
    throw new Error("KNOWLEDGE_RESOURCE_ROW_INVALID");
  }
  return Object.freeze({
    ref: record.ref,
    revision: record.revision,
    title: escapeMemoryForPrompt(record.title),
    category: escapeMemoryForPrompt(record.category),
    createdAt: record.createdAt,
    ...(record.sourceRef ? {
      sourceRef: Object.freeze({
        kind: record.sourceRef.kind,
        ref: escapeMemoryForPrompt(record.sourceRef.ref),
      }),
    } : {}),
    evidence: Object.freeze({ ...record.evidence }),
  });
}

function contentItem(
  record: KnowledgeResourceRecord,
  maxContentChars: number,
): KnowledgeResourceContentItem {
  if (typeof record.content !== "string") {
    throw new Error("KNOWLEDGE_RESOURCE_ROW_INVALID");
  }
  const bounded = record.content.slice(0, maxContentChars);
  return Object.freeze({
    ...indexItem(record),
    content: escapeMemoryForPrompt(bounded),
    truncated: record.truncated === true || bounded.length < record.content.length,
  });
}

function uniqueWarnings(values: readonly KnowledgeResourceWarning[]): readonly KnowledgeResourceWarning[] {
  return Object.freeze([...new Set(values)]);
}

export class KnowledgeResourceCapability {
  private readonly timeoutMs: number;
  private readonly indexLimit: number;
  private readonly maxSearchItems: number;
  private readonly maxSearchContentChars: number;
  private readonly maxReadContentChars: number;

  constructor(
    private readonly repository: KnowledgeResourceRepository,
    options: KnowledgeResourceCapabilityOptions = {},
  ) {
    this.timeoutMs = option(options.timeoutMs, 80, 30_000);
    this.indexLimit = option(options.indexLimit, 5, MAX_INDEX_ITEMS);
    this.maxSearchItems = option(options.maxSearchItems, 5, MAX_SEARCH_ITEMS);
    this.maxSearchContentChars = option(options.maxSearchContentChars, 800, MAX_CONTENT_CHARS);
    this.maxReadContentChars = option(options.maxReadContentChars, 4_000, MAX_CONTENT_CHARS);
  }

  async index(
    scope: MemoryScope,
    input: { readonly limit?: number } = {},
  ): Promise<KnowledgeResourceIndexResult> {
    const requested = requestedLimit(input.limit, this.indexLimit);
    try {
      const records = await this.withTimeout(this.repository.list(scope, { limit: requested.limit }));
      const resources = Object.freeze(records.slice(0, requested.limit).map(indexItem));
      return Object.freeze({
        resources,
        warnings: uniqueWarnings([
          ...(requested.exceeded || records.length > requested.limit
            ? ["knowledge_resource_budget_exceeded" as const]
            : []),
        ]),
      });
    } catch (error) {
      return this.indexFailure(error);
    }
  }

  async search(
    scope: MemoryScope,
    input: { readonly query: string; readonly limit?: number },
  ): Promise<KnowledgeResourceSearchResult> {
    validateQuery(input.query);
    const requested = requestedLimit(input.limit, this.maxSearchItems);
    try {
      const records = await this.withTimeout(this.repository.search(scope, {
        query: input.query,
        limit: requested.limit,
        maxContentChars: this.maxSearchContentChars,
      }));
      const resources = Object.freeze(records.slice(0, requested.limit)
        .map((record) => contentItem(record, this.maxSearchContentChars)));
      const budgetExceeded = requested.exceeded || records.length > requested.limit ||
        resources.some((resource) => resource.truncated);
      return Object.freeze({
        resources,
        warnings: uniqueWarnings(budgetExceeded
          ? ["knowledge_resource_budget_exceeded"]
          : []),
      });
    } catch (error) {
      return this.searchFailure(error);
    }
  }

  async read(
    scope: MemoryScope,
    input: { readonly ref: string; readonly revision: string; readonly maxChars?: number },
  ): Promise<KnowledgeResourceReadResult> {
    validateReadInput(input.ref, input.revision);
    const requested = requestedLimit(input.maxChars, this.maxReadContentChars);
    try {
      const record = await this.withTimeout(this.repository.read(scope, {
        ref: input.ref,
        revision: input.revision,
        maxContentChars: requested.limit,
      }));
      if (!record) {
        return Object.freeze({
          resource: undefined,
          warnings: Object.freeze(["knowledge_resource_not_found"] as const),
        });
      }
      const resource = contentItem(record, requested.limit);
      return Object.freeze({
        resource,
        warnings: uniqueWarnings(requested.exceeded || resource.truncated
          ? ["knowledge_resource_budget_exceeded"]
          : []),
      });
    } catch (error) {
      return this.readFailure(error);
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new KnowledgeResourceTimeoutError()), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private warning(error: unknown): KnowledgeResourceWarning {
    return error instanceof KnowledgeResourceTimeoutError
      ? "knowledge_resource_timeout"
      : "knowledge_resource_unavailable";
  }

  private indexFailure(error: unknown): KnowledgeResourceIndexResult {
    return Object.freeze({ resources: Object.freeze([]), warnings: Object.freeze([this.warning(error)]) });
  }

  private searchFailure(error: unknown): KnowledgeResourceSearchResult {
    return Object.freeze({ resources: Object.freeze([]), warnings: Object.freeze([this.warning(error)]) });
  }

  private readFailure(error: unknown): KnowledgeResourceReadResult {
    return Object.freeze({ resource: undefined, warnings: Object.freeze([this.warning(error)]) });
  }
}
