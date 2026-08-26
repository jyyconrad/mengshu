/**
 * Summary faithfulness 校验（§7.7）。
 *
 * 两层校验：
 * - Layer 1（deterministic evidence check）：always-on
 * - Layer 2（LLM faithfulness judge）：根据 mode 配置决定是否触发
 */

import type { TreeBuffer, TreeLeaf, TreeSummaryNode, SummaryFaithfulnessConfig } from "./types.js";
import type { LlmClient } from "../runtime/llm/llm-client.js";
import { GLOBAL_TREE_IMPORTANCE } from "./leaf-routing.js";

const HIGH_IMPORTANCE_LEAF_RATIO = 0.7;

export type LeafImportanceEvidence = Pick<TreeLeaf, "id" | "importance">;

const PROMPT_INJECTION_KEYWORDS = [
  "ignore previous",
  "disregard",
  "new instructions",
  "system:",
  "assistant:",
  "你现在是",
  "忽略之前",
];

/**
 * Layer 1: deterministic evidence check（always-on）。
 */
export function validateDeterministicEvidence(
  node: TreeSummaryNode,
  maxSummaryTokens: number = 500,
): { valid: boolean; reason?: string } {
  // 1. summary 长度检查
  if (node.tokenCount > maxSummaryTokens) {
    return { valid: false, reason: `summary exceeds max tokens: ${node.tokenCount} > ${maxSummaryTokens}` };
  }

  // 2. evidenceChunkIds 非空检查
  if (node.evidenceChunkIds.length === 0) {
    return { valid: false, reason: "evidenceChunkIds is empty" };
  }

  // 3. title 非空检查
  if (!node.title || node.title.trim().length === 0) {
    return { valid: false, reason: "title is empty" };
  }

  // 4. prompt injection 关键词检查
  const lowerSummary = node.summary.toLowerCase();
  const lowerTitle = node.title.toLowerCase();
  for (const keyword of PROMPT_INJECTION_KEYWORDS) {
    if (lowerSummary.includes(keyword.toLowerCase()) || lowerTitle.includes(keyword.toLowerCase())) {
      return { valid: false, reason: `contains prompt injection keyword: ${keyword}` };
    }
  }

  return { valid: true };
}

/**
 * 判断是否为高风险摘要（§7.7 high_risk 场景）。
 */
export function isHighRiskSummary(
  node: TreeSummaryNode,
  leaves?: readonly LeafImportanceEvidence[],
): boolean {
  // 1. rules topic summary
  if (node.treeType === "topic" && node.treeKey === "rules") {
    return true;
  }

  // 2. profile summary
  if (node.treeKey.includes("profile")) {
    return true;
  }

  // 3. L3 global digest
  if (node.treeType === "global" && node.level >= 3) {
    return true;
  }

  // 4. 跨 scope summary（检查 scope 层级是否跨越）
  if (node.scope.projectId && node.treeType === "global") {
    return true;
  }

  // 5. 高 importance leaf 占比高的摘要（严格 >70%）。
  // importance 由调用方从 repository 的真实 leaf 数据传入；证据不完整或非法时保守判为高风险。
  if (!Array.isArray(leaves) || leaves.length === 0 || leaves.length !== node.leafIds.length) {
    return true;
  }
  const expectedLeafIds = new Set(node.leafIds);
  if (expectedLeafIds.size !== node.leafIds.length) return true;

  const seenLeafIds = new Set<string>();
  let highImportanceCount = 0;
  for (const leaf of leaves) {
    if (!leaf || typeof leaf !== "object" || typeof leaf.id !== "string" ||
        !expectedLeafIds.has(leaf.id) || seenLeafIds.has(leaf.id) ||
        typeof leaf.importance !== "number" || !Number.isFinite(leaf.importance) ||
        leaf.importance < 0 || leaf.importance > 1) {
      return true;
    }
    seenLeafIds.add(leaf.id);
    if (leaf.importance >= GLOBAL_TREE_IMPORTANCE) highImportanceCount += 1;
  }

  return seenLeafIds.size !== expectedLeafIds.size ||
    highImportanceCount / leaves.length > HIGH_IMPORTANCE_LEAF_RATIO;
}

/** Asset promotion/read must consume a previously governed tree receipt, never run a judge inline. */
export function isGovernedTreeSummaryForAsset(
  node: TreeSummaryNode,
  mode: SummaryFaithfulnessConfig["mode"],
  leaves?: readonly LeafImportanceEvidence[],
): boolean {
  if (!validateDeterministicEvidence(node).valid ||
      node.metadata.faithfulnessFailed === true ||
      node.metadata.faithfulnessUntrusted === true) {
    return false;
  }
  const summaryMode = node.metadata.summaryMode;
  if (summaryMode !== "extractive" && summaryMode !== "abstractive") return false;
  const judgeRequired = mode === "always" ||
    (mode === "high_risk" && isHighRiskSummary(node, leaves));
  return summaryMode === "extractive" || !judgeRequired ||
    node.metadata.faithfulnessValidated === true;
}

/**
 * Layer 2: LLM faithfulness judge。
 * 返回 { faithful: boolean, score?: number, reason?: string }
 */
export async function judgeFaithfulnessWithLlm(
  node: TreeSummaryNode,
  evidenceTexts: string[],
  llmClient: LlmClient,
): Promise<{ faithful: boolean; score?: number; reason?: string }> {
  const evidenceContext = evidenceTexts.join("\n\n---\n\n");
  const systemPrompt = `You are a faithfulness judge. Given evidence and a summary, determine if the summary is faithful to the evidence.

Instructions:
1. Check if every claim in the summary can be traced back to the evidence.
2. Check if the summary introduces any information not present in the evidence.
3. Respond with a JSON object: { "faithful": true/false, "score": 0.0-1.0, "reason": "explanation" }`;

  const userPrompt = `Evidence:
${evidenceContext}

Summary:
${node.summary}

Provide your faithfulness assessment:`;

  try {
    const response = await llmClient.complete(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { modelType: "reasoning", maxTokens: 300 }, // 使用推理模型
    );
    const result = JSON.parse(response.trim());
    return {
      faithful: result.faithful === true,
      score: typeof result.score === "number" ? result.score : undefined,
      reason: typeof result.reason === "string" ? result.reason : undefined,
    };
  } catch (err) {
    // LLM 调用失败或解析失败，返回不确定结果
    return { faithful: false, reason: `LLM judge failed: ${(err as Error).message}` };
  }
}

/**
 * 执行完整的 faithfulness 校验（Layer 1 + Layer 2）。
 */
export async function validateFaithfulness(params: {
  node: TreeSummaryNode;
  leaves?: readonly LeafImportanceEvidence[];
  /** @deprecated 仅为旧调用方兼容；高风险判定必须使用 leaves 中的真实 importance。 */
  buffer?: TreeBuffer;
  evidenceTexts: string[];
  config: SummaryFaithfulnessConfig;
  llmClient?: LlmClient;
}): Promise<{ valid: boolean; reason?: string; usedLlmJudge: boolean }> {
  const { node, leaves, evidenceTexts, config, llmClient } = params;

  // Layer 1: deterministic check（always-on）
  const deterministicResult = validateDeterministicEvidence(node);
  if (!deterministicResult.valid) {
    return { valid: false, reason: deterministicResult.reason, usedLlmJudge: false };
  }

  // Layer 2: LLM judge（根据 mode 决定是否触发）
  let shouldRunLlmJudge = false;

  switch (config.mode) {
    case "off":
      // 仅 deterministic check，不触发 LLM judge
      shouldRunLlmJudge = false;
      break;
    case "sampled":
      // 按 sampleRate 抽样
      shouldRunLlmJudge = Math.random() < (config.sampleRate ?? 0.05);
      break;
    case "high_risk":
      // 仅对 high_risk 摘要触发
      shouldRunLlmJudge = isHighRiskSummary(node, leaves);
      break;
    case "always":
      // 全量触发
      shouldRunLlmJudge = true;
      break;
  }

  if (!shouldRunLlmJudge) {
    return { valid: true, usedLlmJudge: false };
  }

  // 运行 LLM judge
  if (!llmClient?.available) {
    // LLM 不可用，跳过 Layer 2（不阻塞）
    return { valid: true, reason: "LLM judge skipped: llmClient not available", usedLlmJudge: false };
  }

  const judgeResult = await judgeFaithfulnessWithLlm(node, evidenceTexts, llmClient);

  if (!judgeResult.faithful) {
    return {
      valid: false,
      reason: `LLM judge failed: ${judgeResult.reason} (score: ${judgeResult.score})`,
      usedLlmJudge: true,
    };
  }

  return { valid: true, usedLlmJudge: true };
}
