/**
 * 5 问题语义协议的辅助类型与契约定义。
 *
 * 核心类型（MemorySemanticType / MemoryRecord 等）已迁移到 core/types.ts，
 * 本文件保留 5 槽位响应、上下文块等专用结构。
 */

import type {
  MemoryScope,
  MemoryScopeInput,
  MemorySemanticType,
} from "./types.js";

export type { MemorySemanticType, MemoryScope, MemoryScopeInput };

/**
 * SlotContextBlock: 单个槽位上下文块
 */
export interface SlotContextBlock {
  semanticType: MemorySemanticType;
  question: string;
  content: string;
  sourceIds: string[];
  nodeCount: number;
  tokenEstimate?: number;
  warnings?: string[];
}

/**
 * AgentTaskContextRequest: Agent 快路径请求
 */
export interface AgentTaskContextRequest {
  scope: MemoryScopeInput;
  task: string;
  intent?: "chat" | "coding" | "research" | "writing" | "ops" | "unknown";
  constraints?: string[];
  tokenBudget?: number;
  latencyBudgetMs?: number;
}

/**
 * ContextFastResponse: memory_context_fast 响应
 */
export interface ContextFastResponse {
  scope: MemoryScope;
  slots: {
    profile?: SlotContextBlock;
    task_context?: SlotContextBlock;
    rules?: SlotContextBlock;
    experience?: SlotContextBlock;
    resource?: SlotContextBlock;
  };
  /** 拼装后的 prompt 注入文本（已转义） */
  content: string;
  /** 任务相关的额外提示 */
  taskHints?: Array<{
    kind: "rule" | "experience" | "resource" | "warning";
    text: string;
    evidenceIds: string[];
  }>;
  /** 可触发的下钻 action */
  actions?: Array<{
    type: "lookup" | "drill_down" | "open_resource";
    label: string;
    input: Record<string, unknown>;
  }>;
  freshness?: {
    slotSnapshotAt?: number;
    staleSlots: string[];
  };
  warnings?: string[];
  telemetry: {
    latencyMs: number;
    nodesUsed: number;
    cacheHit: boolean;
    tokenEstimate?: number;
  };
}

/**
 * 5 问题对应的固定文本（中文）
 */
export const FIVE_QUESTIONS: Record<MemorySemanticType, string> = {
  profile: "Q1: 我为谁工作？",
  task_context: "Q2: 我在做什么？",
  rules: "Q3: 什么不能做？",
  experience: "Q4: 之前怎么做过？",
  resource: "Q5: 有什么可用资源？",
};
