import type { MemoryScope } from "../domain/types.js";
import type { DisclosureLevel, NavigationRef } from "../domain/semantic-types.js";
import type { WorkMemoryGraphNode, WorkMemoryGraphRepository } from "./work-memory-types.js";

export interface EvidenceContentRef {
  readonly ref: string;
  readonly source: "memory" | "chunk" | "document" | "message" | "resource";
}

export interface EvidenceContentItem extends EvidenceContentRef {
  readonly preview: string;
}

export interface EvidenceContentReadPort {
  read(scope: MemoryScope, refs: readonly EvidenceContentRef[]): Promise<readonly EvidenceContentItem[]>;
}

export interface MemoryNavigationItem extends NavigationRef {
  readonly title: string;
  readonly preview?: string;
  readonly evidenceRefs?: string[];
}

const SAFE_REF = /^[^\s\p{Cc}]{1,512}$/u;
const LEVEL_ORDER: Record<DisclosureLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

function safeRef(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REF.test(value)) {
    throw new Error("MEMORY_EVIDENCE_REFERENCE_INVALID");
  }
  return value;
}

function graphNodeId(node: WorkMemoryGraphNode): string {
  return node.id;
}

function nodeLevel(node: WorkMemoryGraphNode): DisclosureLevel {
  if (node.nodeType === "evidence") return "R4";
  if (node.nodeType === "summary") {
    if (node.treeType === "source") return "R1";
    if (node.treeType === "topic") return "R2";
    return "R3";
  }
  return "R0";
}

function nodeKind(node: WorkMemoryGraphNode): NavigationRef["kind"] {
  if (node.nodeType === "evidence") return "evidence";
  if (node.nodeType === "summary") return `${node.treeType}_tree` as NavigationRef["kind"];
  return "memory";
}

function evidenceSource(node: WorkMemoryGraphNode): EvidenceContentRef["source"] {
  if (node.nodeType !== "evidence") throw new Error("MEMORY_EVIDENCE_REFERENCE_INVALID");
  return node.evidenceKind === "observation" ? "memory" : node.evidenceKind;
}

export class MemoryNavigationService {
  readonly #repository: WorkMemoryGraphRepository;
  readonly #evidenceContent?: EvidenceContentReadPort;

  constructor(input: {
    readonly repository: WorkMemoryGraphRepository;
    readonly evidenceContent?: EvidenceContentReadPort;
  }) {
    this.#repository = input.repository;
    this.#evidenceContent = input.evidenceContent;
  }

  async navigate(
    scope: MemoryScope,
    input: { readonly ref: string; readonly level?: DisclosureLevel; readonly limit: number },
  ): Promise<MemoryNavigationItem[]> {
    const ref = safeRef(input.ref);
    const seeds = await this.#repository.findWorkMemoryNodes({ scope, recordId: ref, limit: 2 });
    if (seeds.length !== 1) throw new Error("MEMORY_NAVIGATION_REFERENCE_NOT_FOUND");
    const seed = seeds[0]!;
    const relatedEdges = await this.#repository.findWorkMemoryEdges({
      scope,
      nodeId: graphNodeId(seed),
      limit: input.limit,
    });
    const nodes = new Map<string, WorkMemoryGraphNode>();
    for (const edge of relatedEdges) {
      const endpointId = edge.sourceId === seed.id ? edge.targetId : edge.sourceId;
      const endpoint = await this.#repository.getWorkMemoryNode(endpointId, scope);
      if (endpoint) nodes.set(endpoint.id, endpoint);
    }
    if (seed.nodeType !== "evidence") {
      for (const evidenceId of seed.evidenceChunkIds) {
        const matches = await this.#repository.findWorkMemoryNodes({
          scope,
          nodeType: "evidence",
          recordId: evidenceId,
          limit: 2,
        });
        if (matches.length === 1) nodes.set(matches[0]!.id, matches[0]!);
      }
    }
    return [...nodes.values()]
      .map((node): MemoryNavigationItem => ({
        ref: node.recordId,
        kind: nodeKind(node),
        level: nodeLevel(node),
        title: node.label,
        ...(node.nodeType === "memory" && node.semanticType
          ? { semanticType: node.semanticType }
          : {}),
        ...(node.nodeType !== "evidence" ? { evidenceRefs: [...node.evidenceChunkIds] } : {}),
      }))
      .filter((item) => input.level === undefined || LEVEL_ORDER[item.level] > LEVEL_ORDER[input.level])
      .sort((left, right) => LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level] ||
        left.ref.localeCompare(right.ref))
      .slice(0, input.limit);
  }

  async readEvidence(
    scope: MemoryScope,
    refsInput: readonly string[],
  ): Promise<readonly EvidenceContentItem[]> {
    if (!Array.isArray(refsInput) || refsInput.length < 1 || refsInput.length > 50) {
      throw new Error("MEMORY_EVIDENCE_REFERENCE_INVALID");
    }
    const refs = refsInput.map(safeRef);
    if (new Set(refs).size !== refs.length) throw new Error("MEMORY_EVIDENCE_REFERENCE_INVALID");
    if (!this.#evidenceContent) throw new Error("MEMORY_EVIDENCE_CONTENT_UNAVAILABLE");
    const contentRefs: EvidenceContentRef[] = [];
    for (const ref of refs) {
      const matches = await this.#repository.findWorkMemoryNodes({
        scope,
        nodeType: "evidence",
        recordId: ref,
        limit: 2,
      });
      if (matches.length !== 1 || matches[0]!.nodeType !== "evidence") {
        throw new Error("MEMORY_EVIDENCE_REFERENCE_INVALID");
      }
      contentRefs.push({ ref, source: evidenceSource(matches[0]!) });
    }
    return this.#evidenceContent.read(scope, contentRefs);
  }
}
