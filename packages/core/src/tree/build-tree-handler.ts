/**
 * build_tree job handler。
 *
 * 本文件做什么：消费 build_tree 任务，把 leaf 追加到记忆树 buffer，当满足
 * seal 条件时调用 sealBuffer 生成 SummaryNode。
 *
 * 核心流程：
 * 1. 解析 payload { scope, treeType, treeKey, leaf }，缺必填字段抛错。
 * 2. 补全 leaf 默认字段（entityIds、importance、eventAt、tokenCount）。
 * 3. 调用 appendLeafToBuffer 追加 leaf 到 buffer。
 * 4. 若 shouldSeal=true，调用 sealBuffer 生成 SummaryNode（带 LlmClient 支持）。
 * 5. 返回 { sealed: boolean, nodeId?: string, bufferId?: string }。
 *
 * 关键边界：
 * - payload 必须包含 scope、treeType、treeKey、leaf.id、leaf.chunkId、leaf.sourceId。
 * - treeType 必须是 "source" | "topic" | "global" 之一。
 * - leaf 字段不完整时补全默认值（entityIds=[]、importance=0.5、eventAt=now、tokenCount 按文本估算）。
 * - LlmClient 不可用或失败时降级到 extractive 摘要（不阻塞）。
 */

import { appendLeafToBuffer, type SealPolicy } from "./buffer.js";
import { sealBuffer } from "./seal.js";
import type { TreeRepository, TreeLeaf, MemoryTreeType } from "./types.js";
import type { LlmClient } from "../processing/llm-client.js";
import type { JobHandler } from "../server/workers.js";
import type { JobRecord } from "../storage/repositories/types.js";
import type { MemoryScope } from "../core/types.js";

export interface BuildTreeHandlerDeps {
  repository: TreeRepository;
  llmClient?: LlmClient;
  policy?: SealPolicy;
}

interface BuildTreePayload {
  scope?: MemoryScope;
  treeType?: string;
  treeKey?: string;
  leaf?: Partial<TreeLeaf> & { id?: string; chunkId?: string; sourceId?: string };
}

function readPayload(job: JobRecord): BuildTreePayload {
  const payload = job.payload as BuildTreePayload;
  return {
    scope: payload.scope,
    treeType: typeof payload.treeType === "string" ? payload.treeType : undefined,
    treeKey: typeof payload.treeKey === "string" ? payload.treeKey : undefined,
    leaf: payload.leaf,
  };
}

function validateTreeType(treeType: string): asserts treeType is MemoryTreeType {
  if (treeType !== "source" && treeType !== "topic" && treeType !== "global") {
    throw new Error(`Invalid treeType: ${treeType}. Must be one of: source, topic, global`);
  }
}

function completeLeaf(partial: Partial<TreeLeaf>, now: number): TreeLeaf {
  return {
    id: partial.id!,
    scope: partial.scope!,
    chunkId: partial.chunkId!,
    sourceId: partial.sourceId!,
    entityIds: partial.entityIds ?? [],
    importance: partial.importance ?? 0.5,
    eventAt: partial.eventAt ?? now,
    createdAt: partial.createdAt ?? now,
    text: partial.text,
    tokenCount: partial.tokenCount ?? (partial.text ? Math.ceil(partial.text.length / 4) : 0),
  };
}

type BuildTreeResult = { sealed: false; bufferId: string } | { sealed: true; nodeId: string };

/** 构造 build_tree job handler。 */
export function createBuildTreeHandler(deps: BuildTreeHandlerDeps): JobHandler {
  return async (job: JobRecord): Promise<BuildTreeResult> => {
    const { scope, treeType, treeKey, leaf } = readPayload(job);

    // 校验必填字段
    if (!scope) {
      throw new Error("Missing required field: scope");
    }
    if (!treeType) {
      throw new Error("Missing required field: treeType");
    }
    if (!treeKey) {
      throw new Error("Missing required field: treeKey");
    }
    if (!leaf) {
      throw new Error("Missing required field: leaf");
    }
    if (!leaf.id) {
      throw new Error("Missing required field: leaf.id");
    }
    if (!leaf.chunkId) {
      throw new Error("Missing required field: leaf.chunkId");
    }
    if (!leaf.sourceId) {
      throw new Error("Missing required field: leaf.sourceId");
    }

    // 校验 treeType
    validateTreeType(treeType);

    // 补全 leaf 默认字段
    const now = Date.now();
    const completeLeafData = completeLeaf({ ...leaf, scope }, now);

    // 追加 leaf 到 buffer
    const { buffer, shouldSeal } = await appendLeafToBuffer(
      deps.repository,
      {
        scope,
        treeType,
        treeKey,
        leaf: completeLeafData,
        now,
      },
      deps.policy,
    );

    // 若需 seal，调用 sealBuffer 生成 SummaryNode
    if (shouldSeal) {
      const node = await sealBuffer(deps.repository, {
        buffer,
        now,
        llmClient: deps.llmClient,
      });
      return { sealed: true, nodeId: node.id };
    }

    return { sealed: false, bufferId: buffer.id };
  };
}
