/**
 * 5 type extractor contract
 *
 * 实现方案文档 §4.2 的 5 type extractor：
 * 从原始文本（observation / chunk / session summary）抽取候选 5 type。
 *
 * 默认实现是「确定性启发式 extractor」（无 LLM 依赖），符合方案中
 * 单机配置的需求。LLM 抽取作为可选增强，通过 LLMTypeExtractor 实现。
 */

import type { MemorySemanticType } from "../domain/types.js";
import { isSensitive } from "./sensitive-filter.js";

/**
 * Extractor 输出
 */
export interface ExtractedCandidate {
  semanticType?: MemorySemanticType;
  kind: string;
  text: string;
  confidence: number;
  reason: string;
  hasWhy?: boolean;
  hasOutcome?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Extractor 输入
 */
export interface ExtractorInput {
  text: string;
  context?: {
    sessionId?: string;
    projectId?: string;
    userId?: string;
    eventType?: string;
  };
  /** 用户显式 hints（如 intent=remember） */
  hints?: {
    explicitSave?: boolean;
    suggestedType?: MemorySemanticType;
  };
}

/**
 * Type Extractor 接口
 */
export interface TypeExtractor {
  name: string;
  extract(input: ExtractorInput): Promise<ExtractedCandidate[]>;
}

/**
 * 启发式 5 type 抽取规则
 */
const RULES: Array<{
  semanticType: MemorySemanticType;
  patterns: RegExp[];
  baseConfidence: number;
  reason: string;
  guards?: (text: string) => boolean;
}> = [
  {
    semanticType: "rules",
    patterns: [
      /禁止|不要|不能|永远不|从不/,
      /must not|never|do not|don't/i,
      /合规|compliance|policy|约束/i,
    ],
    baseConfidence: 0.85,
    reason: "禁止/约束类语句",
  },
  {
    semanticType: "profile",
    patterns: [
      /我喜欢|我倾向|我偏好/,
      /i (prefer|like|love|favor)/i,
      /习惯|风格|protocol/i,
    ],
    baseConfidence: 0.75,
    reason: "用户偏好/风格",
  },
  {
    semanticType: "task_context",
    patterns: [
      /项目目标|当前任务|阶段|deadline|milestone/,
      /current (project|task|phase|sprint)/i,
      /要在.+(月|日|前)完成/,
    ],
    baseConfidence: 0.75,
    reason: "项目/任务上下文",
  },
  {
    semanticType: "experience",
    patterns: [
      /我们.+(选择|决定|采用).+(因为|是因为|由于)/,
      /决策|decided.+because|chose.+because/i,
      /经验|lesson learned|后来发现/,
    ],
    baseConfidence: 0.78,
    reason: "决策/经验",
    guards: (text) => /因为|because|why|due to/i.test(text),
  },
  {
    semanticType: "resource",
    patterns: [
      /参考|参阅|see|refer to/i,
      /https?:\/\/\S+/,
      /\.(md|pdf|doc|json|yaml|yml|ts|js|py)\b/i,
      /工具|tool|skill|connector|api/i,
    ],
    baseConfidence: 0.72,
    reason: "资源指针",
  },
];

/**
 * 启发式抽取器：基于关键词正则匹配
 */
export class HeuristicTypeExtractor implements TypeExtractor {
  readonly name = "heuristic";

  async extract(input: ExtractorInput): Promise<ExtractedCandidate[]> {
    const text = input.text.trim();
    if (text.length < 5) return [];

    // 隐私安全底线（plan §5.1.3 + RISK-15）：命中敏感个人属性（人格/健康/政治/
    // 宗教/性取向）直接返回空候选，确保敏感内容不进入候选区与 Durable Memory。
    if (isSensitive(text)) return [];

    const results: ExtractedCandidate[] = [];
    const explicit = input.hints?.explicitSave;

    for (const rule of RULES) {
      if (rule.guards && !rule.guards(text)) continue;
      const hit = rule.patterns.some((p) => p.test(text));
      if (!hit) continue;

      const baseConfidence = explicit
        ? Math.min(1, rule.baseConfidence + 0.15)
        : rule.baseConfidence;

      const hasWhy = /因为|because|due to|why/i.test(text);
      const hasOutcome = /结果|outcome|发现|得到|achieved/i.test(text);

      results.push({
        semanticType: rule.semanticType,
        kind:
          rule.semanticType === "rules"
            ? "preference"
            : rule.semanticType === "experience"
              ? "decision"
              : rule.semanticType === "task_context"
                ? "task"
                : rule.semanticType === "resource"
                  ? "document"
                  : "preference",
        text,
        confidence: baseConfidence,
        reason: rule.reason,
        hasWhy,
        hasOutcome,
        metadata: input.context ?? {},
      });
    }

    if (results.length === 0 && explicit) {
      // 显式保存但无规则匹配 → 候选 fallback
      results.push({
        semanticType: input.hints?.suggestedType,
        kind: "other",
        text,
        confidence: 0.7,
        reason: "explicit_save_fallback",
        metadata: input.context ?? {},
      });
    }

    return results;
  }
}

/**
 * 全局默认 extractor
 */
export const defaultTypeExtractor: TypeExtractor = new HeuristicTypeExtractor();
