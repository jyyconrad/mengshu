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
  /** 原文证据。若省略，兼容路径继续使用 text；validator 会校验其真实来自输入。 */
  evidenceQuote?: string;
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
  priority?: number; // 优先级，数字越大越优先匹配
}> = [
  {
    semanticType: "experience",
    patterns: [
      /我们.+(选择|决定|采用).+(因为|是因为|由于)/,
      /决策|decided.+because|chose.+because/i,
      /经验|lesson learned|后来发现/,
      /(上次|之前|曾|原来).+(导致|失败|问题).+(现在|后来|改用)/,
      /(tried|attempted).+(failed|didn't work).+(switched|changed to)/i,
      /发现.*(导致|引起|造成).*(无限循环|内存泄漏|性能问题|崩溃)/,
      /(尝试|试过).*(方案|办法).*(但|可是).*(问题|失败)/,
      /踩(?:了)?坑/,
      /(之前|曾).+(超时|失败|问题).+(改用|后来|现在)/,
      /\b(before|previously).+(timeout|failed|issue).+(changed|switched|now use)/i,
    ],
    baseConfidence: 0.78,
    reason: "决策/经验",
    priority: 10, // 高优先级，优先于 resource 匹配
    guards: (text) => /因为|because|why|due to|导致|failed|switched|改用|后来|问题|超时|timeout|issue|changed|踩(?:了)?坑/i.test(text),
  },
  {
    semanticType: "rules",
    patterns: [
      /禁止|不要|不能|永远不|从不/,
      /^所有.+必须/,
      /must not|never|do not|don't/i,
      /合规|compliance|policy|约束/i,
    ],
    baseConfidence: 0.85,
    reason: "禁止/约束类语句",
    priority: 8,
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
      /等.+完成后才能.+/,
      /还没.+(?:阻塞|blocked)/i,
    ],
    baseConfidence: 0.75,
    reason: "项目/任务上下文",
    priority: 8,
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

    // 按优先级排序（高优先级规则先匹配）
    const sortedRules = [...RULES].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const rule of sortedRules) {
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
        evidenceQuote: text,
        confidence: baseConfidence,
        reason: rule.reason,
        hasWhy,
        hasOutcome,
        metadata: input.context ?? {},
      });

      // 匹配到高优先级规则后立即返回，不再尝试其他规则
      if (rule.priority && rule.priority >= 8) break;
    }

    if (results.length === 0 && explicit) {
      // 显式保存但无规则匹配 → 候选 fallback
      results.push({
        semanticType: input.hints?.suggestedType,
        kind: "other",
        text,
        evidenceQuote: text,
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
