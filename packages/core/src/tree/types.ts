/**
 * Memory Tree domain types.
 *
 * Tree 负责把 chunk evidence 组织为 source/topic/global 三类可导航摘要；
 * buffer 保存 L0 待 seal 内容，SummaryNode 保留 leaf/evidence/provenance。
 */

import type { MemoryScope } from "../core/types.js";

export type MemoryTreeType = "source" | "topic" | "global";
export type SummaryNodeStatus = "open" | "sealed" | "stale" | "archived";

/**
 * Summary faithfulness 模式（D-07）。
 * - off: 仅 deterministic check（P0/P1 默认）
 * - sampled: 按 sampleRate 抽样 LLM judge
 * - high_risk: 仅对 high_risk 摘要触发 LLM judge（P2 起启用）
 * - always: 全量 LLM judge
 */
export type SummaryFaithfulnessMode = "off" | "sampled" | "high_risk" | "always";

/**
 * Summary faithfulness 配置（§7.7）。
 */
export interface SummaryFaithfulnessConfig {
  /** 校验模式（D-07：P0/P1 默认 off，P2 起 high_risk） */
  mode: SummaryFaithfulnessMode;
  /** 抽样比例（sampled 模式下生效） */
  sampleRate?: number;
  /** Judge 模型（可选，缺省使用 llm.reasoningModel） */
  judgeModel?: string;
  /** 校验失败时的处理动作 */
  failAction: "fallback_extractive" | "mark_untrusted" | "retry";
}

export interface TreeLeaf {
  id: string;
  scope: MemoryScope;
  chunkId: string;
  sourceId: string;
  entityIds: string[];
  importance: number;
  eventAt: number;
  createdAt: number;
  text?: string;
  tokenCount?: number;
}

export interface TreeBuffer {
  id: string;
  scope: MemoryScope;
  treeType: MemoryTreeType;
  treeKey: string;
  level: number;
  leafIds: string[];
  childNodeIds: string[];
  tokenCount: number;
  openedAt: number;
  updatedAt: number;
  sealAfterAt?: number;
}

export interface TreeSummaryNode {
  id: string;
  scope: MemoryScope;
  treeType: MemoryTreeType;
  treeKey: string;
  level: number;
  title: string;
  summary: string;
  childNodeIds: string[];
  leafIds: string[];
  evidenceChunkIds: string[];
  entityIds: string[];
  relationIds: string[];
  tokenCount: number;
  timeRange: { startAt: number; endAt: number };
  status: SummaryNodeStatus;
  createdAt: number;
  sealedAt?: number;
  metadata: Record<string, unknown>;
}

export interface TreeRepository {
  upsertLeaf(leaf: TreeLeaf): Promise<void>;
  getLeaf(id: string): Promise<TreeLeaf | undefined>;
  listLeaves(ids: string[]): Promise<TreeLeaf[]>;
  upsertBuffer(buffer: TreeBuffer): Promise<void>;
  getBuffer(id: string): Promise<TreeBuffer | undefined>;
  deleteBuffer(id: string): Promise<void>;
  upsertSummary(node: TreeSummaryNode): Promise<void>;
  getSummary(id: string): Promise<TreeSummaryNode | undefined>;
  listSummaries(filter: { scope: MemoryScope; treeType?: MemoryTreeType; treeKey?: string }): Promise<TreeSummaryNode[]>;
}
