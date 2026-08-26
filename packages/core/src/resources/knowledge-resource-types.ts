import type { MemoryScope } from "../domain/types.js";

export type KnowledgeResourceSourceRefKind = "document" | "source" | "file";

export interface KnowledgeResourceSourceRef {
  readonly kind: KnowledgeResourceSourceRefKind;
  readonly ref: string;
}
export interface KnowledgeResourceEvidenceRef {
  readonly kind: "knowledge_record";
  readonly ref: string;
  readonly revision: string;
}

export interface KnowledgeResourceRecord {
  readonly ref: string;
  readonly revision: string;
  readonly title: string;
  readonly category: string;
  readonly createdAt: string;
  readonly sourceRef?: KnowledgeResourceSourceRef;
  readonly evidence: KnowledgeResourceEvidenceRef;
  readonly content?: string;
  readonly truncated?: boolean;
}

export interface KnowledgeResourceRepository {
  list(
    scope: MemoryScope,
    input: { readonly limit: number },
  ): Promise<readonly KnowledgeResourceRecord[]>;
  search(
    scope: MemoryScope,
    input: {
      readonly query: string;
      readonly limit: number;
      readonly maxContentChars: number;
    },
  ): Promise<readonly KnowledgeResourceRecord[]>;
  read(
    scope: MemoryScope,
    input: {
      readonly ref: string;
      readonly revision: string;
      readonly maxContentChars: number;
    },
  ): Promise<KnowledgeResourceRecord | undefined>;
}

export interface KnowledgeResourceIndexItem extends Omit<KnowledgeResourceRecord,
  "content" | "truncated"> {}

export interface KnowledgeResourceContentItem extends KnowledgeResourceIndexItem {
  readonly content: string;
  readonly truncated: boolean;
}

export type KnowledgeResourceWarning =
  | "knowledge_resource_budget_exceeded"
  | "knowledge_resource_not_found"
  | "knowledge_resource_timeout"
  | "knowledge_resource_unavailable";

export interface KnowledgeResourceIndexResult {
  readonly resources: readonly KnowledgeResourceIndexItem[];
  readonly warnings: readonly KnowledgeResourceWarning[];
}

export interface KnowledgeResourceSearchResult {
  readonly resources: readonly KnowledgeResourceContentItem[];
  readonly warnings: readonly KnowledgeResourceWarning[];
}

export interface KnowledgeResourceReadResult {
  readonly resource: KnowledgeResourceContentItem | undefined;
  readonly warnings: readonly KnowledgeResourceWarning[];
}
