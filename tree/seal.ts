/**
 * Memory Tree sealing.
 *
 * 第一阶段提供 extractive summary fallback：按 importance/eventAt 选择 leaf 文本，
 * 生成 sealed SummaryNode，并保留 evidence chunk ids。
 *
 * P2 升级：集成 faithfulness 校验（§7.7，D-07）。
 * - 默认模式：P0/P1 为 `off`（仅 deterministic check），P2 起为 `high_risk`
 * - high_risk 场景自动触发 LLM faithfulness judge：
 *   1. rules topic summary（影响 agent 约束注入）
 *   2. profile summary（影响用户画像）
 *   3. L3 global digest（信息跨度大，易过度归纳）
 *   4. 跨 scope summary（可能把 project 事实扩散到 app/global）
 *   5. 高 importance leaf 占比 >70% 的摘要（错误成本高）
 */

import { createHash } from "node:crypto";
import { scopeToKey } from "../core/scope.js";
import type { TreeBuffer, TreeLeaf, TreeRepository, TreeSummaryNode, SummaryFaithfulnessConfig } from "./types.js";
import type { LlmClient } from "../processing/llm-client.js";
import { validateFaithfulness } from "./faithfulness.js";

export interface SealBufferInput {
  buffer: TreeBuffer;
  now?: number;
  title?: string;
  relationIds?: string[];
  llmClient?: LlmClient;
  faithfulnessConfig?: SummaryFaithfulnessConfig;
}

function summaryId(buffer: TreeBuffer, sealedAt: number): string {
  return `sum_${createHash("sha256")
    .update([scopeToKey(buffer.scope), buffer.treeType, buffer.treeKey, buffer.level, sealedAt].join(":"))
    .digest("hex")
    .slice(0, 24)}`;
}

function summarizeLeaves(leaves: TreeLeaf[]): string {
  return leaves
    .slice()
    .sort((left, right) => right.importance - left.importance || right.eventAt - left.eventAt)
    .slice(0, 5)
    .map((leaf) => leaf.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n\n");
}

interface SealSummaryOutput {
  title: string;
  summary: string;
  keyFacts: Array<{
    text: string;
    evidenceLeafIds: string[];
  }>;
  openQuestions?: string[];
  supersedes?: string[];
  riskFlags?: string[];
  evidenceLeafIds: string[];
}

interface SealInputLeaf {
  id: string;
  semanticType?: string;
  eventAt: number;
  importance: number;
  text: string;
  evidenceChunkId?: string;
}

async function generateStructuredSummary(
  llmClient: LlmClient,
  leaves: TreeLeaf[],
  buffer: TreeBuffer,
): Promise<string> {
  // 按 eventAt 升序准备输入 leaves
  const inputLeaves: SealInputLeaf[] = leaves
    .slice()
    .sort((a, b) => a.eventAt - b.eventAt)
    .slice(0, 30) // 最多 30 条
    .map((leaf) => ({
      id: leaf.id,
      semanticType: undefined, // TreeLeaf 暂无 semanticType，后续扩展
      eventAt: leaf.eventAt,
      importance: leaf.importance,
      text: leaf.text ?? "",
      evidenceChunkId: leaf.chunkId,
    }));

  const systemMessage = `你是 mengshu 记忆树摘要器。给定同一来源下的若干条记忆 leaf，压缩为结构化摘要。

严格要求：
- 不引入 leaf 中没有的信息（禁止外推）。
- summary 控制在指定 token 内。
- 优先保留：决策、约束、失败-修复模式、文件/工具操作。
- 丢弃：寒暄、过程性话术、agent 自己的计划性陈述。
- 不要合并相互冲突的规则；冲突写入 openQuestions 或 riskFlags。
- 每个 keyFact 必须引用 evidenceLeafIds。
- 输出语言与原文一致。`;

  const userMessage = `请为以下记忆 leaves 生成结构化摘要：

treeType: ${buffer.treeType}
treeKey: ${buffer.treeKey}
level: ${buffer.level}

Leaves (${inputLeaves.length} 条，按时间升序):
${JSON.stringify(inputLeaves, null, 2)}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "keyFacts", "evidenceLeafIds"],
    properties: {
      title: { type: "string", maxLength: 80 },
      summary: { type: "string", maxLength: 600 },
      keyFacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "evidenceLeafIds"],
          properties: {
            text: { type: "string", maxLength: 200 },
            evidenceLeafIds: { type: "array", items: { type: "string" }, minItems: 1 },
          },
        },
      },
      openQuestions: { type: "array", items: { type: "string" } },
      supersedes: { type: "array", items: { type: "string" } },
      riskFlags: { type: "array", items: { type: "string" } },
      evidenceLeafIds: { type: "array", items: { type: "string" }, minItems: 1 },
    },
  };

  // 检查 llmClient 是否支持 extractStructured
  if (typeof (llmClient as any).extractStructured === "function") {
    const result: SealSummaryOutput = await (llmClient as any).extractStructured({
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
      schema,
      schemaName: "SealSummaryOutput",
      modelType: "summarization", // 使用摘要模型
    });

    // 组装最终 summary（三级结构：title + summary + keyFacts）
    let finalSummary = `# ${result.title}\n\n${result.summary}`;

    if (result.keyFacts && result.keyFacts.length > 0) {
      finalSummary += "\n\n## 关键事实\n";
      for (const fact of result.keyFacts) {
        finalSummary += `- ${fact.text}\n`;
      }
    }

    if (result.openQuestions && result.openQuestions.length > 0) {
      finalSummary += "\n\n## 待确认问题\n";
      for (const q of result.openQuestions) {
        finalSummary += `- ${q}\n`;
      }
    }

    return finalSummary;
  }

  // 降级：使用 summarize 方法
  const extractive = leaves
    .slice()
    .sort((a, b) => b.importance - a.importance || b.eventAt - a.eventAt)
    .slice(0, 5)
    .map((l) => l.text?.trim())
    .filter((t): t is string => Boolean(t))
    .join("\n\n");

  return llmClient.summarize(extractive, systemMessage, { modelType: "summarization" });
}

export async function sealBuffer(
  repository: TreeRepository,
  input: SealBufferInput,
): Promise<TreeSummaryNode> {
  const sealedAt = input.now ?? Date.now();
  const leaves = await repository.listLeaves(input.buffer.leafIds);
  const evidenceChunkIds = leaves.map((leaf) => leaf.chunkId);
  const entityIds = Array.from(new Set(leaves.flatMap((leaf) => leaf.entityIds)));
  const eventTimes = leaves.map((leaf) => leaf.eventAt);

  // 生成摘要：优先使用 LLM abstractive 摘要，失败则降级到 extractive
  const extractiveSummary = summarizeLeaves(leaves) || `${leaves.length} events sealed.`;
  let summary = extractiveSummary;
  let summaryMode: "extractive" | "abstractive" = "extractive";
  let faithfulnessValidation: { valid: boolean; reason?: string; usedLlmJudge: boolean } | undefined;

  if (input.llmClient?.available) {
    try {
      summary = await generateStructuredSummary(input.llmClient, leaves, input.buffer);
      summaryMode = "abstractive";
    } catch (err) {
      // LLM 调用失败，降级到 extractive（不阻塞）
      summary = extractiveSummary;
      summaryMode = "extractive";
    }
  }

  // 构建初始 node（用于 faithfulness 校验）
  const node: TreeSummaryNode = {
    id: summaryId(input.buffer, sealedAt),
    scope: input.buffer.scope,
    treeType: input.buffer.treeType,
    treeKey: input.buffer.treeKey,
    level: input.buffer.level + 1,
    title: input.title ?? `${input.buffer.treeType}:${input.buffer.treeKey}`,
    summary,
    childNodeIds: input.buffer.childNodeIds,
    leafIds: input.buffer.leafIds,
    evidenceChunkIds,
    entityIds,
    relationIds: input.relationIds ?? [],
    tokenCount: input.buffer.tokenCount,
    timeRange: {
      startAt: eventTimes.length > 0 ? Math.min(...eventTimes) : sealedAt,
      endAt: eventTimes.length > 0 ? Math.max(...eventTimes) : sealedAt,
    },
    status: "sealed",
    createdAt: sealedAt,
    sealedAt,
    metadata: { summaryMode },
  };

  // Faithfulness 校验（P2 升级，D-07）
  if (input.faithfulnessConfig && summaryMode === "abstractive") {
    const evidenceTexts = leaves.map((leaf) => leaf.text ?? "").filter((text) => text.length > 0);
    faithfulnessValidation = await validateFaithfulness({
      node,
      buffer: input.buffer,
      evidenceTexts,
      config: input.faithfulnessConfig,
      llmClient: input.llmClient,
    });

    // 根据 failAction 处理校验失败
    if (!faithfulnessValidation.valid) {
      if (input.faithfulnessConfig.failAction === "fallback_extractive") {
        // 降级到 extractive 摘要
        node.summary = extractiveSummary;
        node.metadata = {
          summaryMode: "extractive",
          faithfulnessFailed: true,
          faithfulnessReason: faithfulnessValidation.reason,
        };
      } else if (input.faithfulnessConfig.failAction === "mark_untrusted") {
        // 保留 abstractive 摘要，但标记为不可信
        node.metadata = {
          summaryMode: "abstractive",
          faithfulnessUntrusted: true,
          faithfulnessReason: faithfulnessValidation.reason,
        };
      } else if (input.faithfulnessConfig.failAction === "retry") {
        // retry 策略：简单降级到 extractive（实际 retry 需要更复杂的逻辑）
        node.summary = extractiveSummary;
        node.metadata = {
          summaryMode: "extractive",
          faithfulnessFailed: true,
          faithfulnessReason: faithfulnessValidation.reason,
        };
      }
    } else {
      // 校验通过，记录到 metadata
      // 只有在实际运行了 LLM judge 时才标记 faithfulnessValidated
      // deterministic check 是 always-on 的基础检查，不单独标记
      if (faithfulnessValidation.usedLlmJudge) {
        node.metadata = {
          ...node.metadata,
          faithfulnessValidated: true,
          faithfulnessUsedLlmJudge: true,
        };
      }
    }
  }

  await repository.upsertSummary(node);
  await repository.deleteBuffer(input.buffer.id);
  return node;
}
