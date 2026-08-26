/**
 * Memory Tree buffer operations.
 *
 * Source/topic/global tree 都先写入 L0 buffer；当 leaf 数、token 数或 stale
 * 条件满足时，再由 seal 阶段生成 SummaryNode。
 */

import { createHash } from "node:crypto";
import { scopeToKey } from "../domain/scope.js";
import type { MemoryScope } from "../domain/types.js";
import type { MemoryTreeType, TreeBuffer, TreeLeaf, TreeRepository, TreeSummaryNode } from "./types.js";

export interface AppendLeafInput {
  scope: MemoryScope;
  treeType: MemoryTreeType;
  treeKey: string;
  leaf: TreeLeaf;
  level?: number;
  now?: number;
}

export interface SealPolicy {
  maxLeafCount?: number;
  maxTokenCount?: number;
  staleAfterMs?: number;
}

export interface AppendLeafResult {
  buffer: TreeBuffer;
  shouldSeal: boolean;
  /** false means this exact leaf id was already present in this target buffer. */
  appended: boolean;
}

function treeId(prefix: string, parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24)}`;
}

export function bufferId(scope: MemoryScope, treeType: MemoryTreeType, treeKey: string, level: number): string {
  return treeId("buf", [scopeToKey(scope), treeType, treeKey, String(level)]);
}

export class InMemoryTreeRepository implements TreeRepository {
  private readonly leaves = new Map<string, TreeLeaf>();
  private readonly buffers = new Map<string, TreeBuffer>();
  private readonly summaries = new Map<string, TreeSummaryNode>();

  async upsertLeaf(leaf: TreeLeaf): Promise<void> {
    this.leaves.set(leaf.id, leaf);
  }

  async getLeaf(id: string): Promise<TreeLeaf | undefined> {
    return this.leaves.get(id);
  }

  async listLeaves(ids: string[]): Promise<TreeLeaf[]> {
    return ids.map((id) => this.leaves.get(id)).filter((leaf): leaf is TreeLeaf => Boolean(leaf));
  }

  async upsertBuffer(buffer: TreeBuffer): Promise<void> {
    this.buffers.set(buffer.id, buffer);
  }

  async getBuffer(id: string): Promise<TreeBuffer | undefined> {
    return this.buffers.get(id);
  }

  async deleteBuffer(id: string): Promise<void> {
    this.buffers.delete(id);
  }

  async upsertSummary(node: TreeSummaryNode): Promise<void> {
    this.summaries.set(node.id, node);
  }

  async getSummary(id: string): Promise<TreeSummaryNode | undefined> {
    return this.summaries.get(id);
  }

  async listSummaries(filter: { scope: MemoryScope; treeType?: MemoryTreeType; treeKey?: string }): Promise<TreeSummaryNode[]> {
    const scopeKey = scopeToKey(filter.scope);
    return Array.from(this.summaries.values())
      .filter((node) => scopeToKey(node.scope) === scopeKey)
      .filter((node) => !filter.treeType || node.treeType === filter.treeType)
      .filter((node) => !filter.treeKey || node.treeKey === filter.treeKey)
      .sort((left, right) => (right.sealedAt ?? right.createdAt) - (left.sealedAt ?? left.createdAt));
  }

  async getParent(nodeId: string): Promise<TreeSummaryNode | undefined> {
    const parents = Array.from(this.summaries.values()).filter((node) => node.childNodeIds.includes(nodeId));
    if (parents.length === 0) {
      return undefined;
    }
    if (parents.length > 1) {
      console.warn(`[InMemoryTreeRepository] getParent: multiple parents found for node ${nodeId}, returning first`);
    }
    return parents[0];
  }
}

export async function appendLeafToBuffer(
  repository: TreeRepository,
  input: AppendLeafInput,
  policy: SealPolicy = {},
): Promise<AppendLeafResult> {
  const now = input.now ?? Date.now();
  const level = input.level ?? 0;
  await repository.upsertLeaf(input.leaf);
  const id = bufferId(input.scope, input.treeType, input.treeKey, level);
  const existing = await repository.getBuffer(id);
  const appended = !existing?.leafIds.includes(input.leaf.id);
  const leafIds = appended
    ? [...(existing?.leafIds ?? []), input.leaf.id]
    : [...(existing?.leafIds ?? [])];
  const leafTokenCount = input.leaf.tokenCount ?? Math.ceil((input.leaf.text?.length ?? 0) / 4);
  const tokenCount = (existing?.tokenCount ?? 0) + (appended ? leafTokenCount : 0);
  const buffer: TreeBuffer = {
    id,
    scope: input.scope,
    treeType: input.treeType,
    treeKey: input.treeKey,
    level,
    leafIds,
    childNodeIds: existing?.childNodeIds ?? [],
    tokenCount,
    openedAt: existing?.openedAt ?? now,
    updatedAt: now,
    sealAfterAt: existing?.sealAfterAt,
  };
  await repository.upsertBuffer(buffer);

  const shouldSeal =
    leafIds.length >= (policy.maxLeafCount ?? 20) ||
    tokenCount >= (policy.maxTokenCount ?? 6000) ||
    (policy.staleAfterMs !== undefined && now - buffer.openedAt >= policy.staleAfterMs);

  return { buffer, shouldSeal, appended };
}
