/**
 * eval/adapters/longmemeval — LongMemEval 数据集 adapter（占位实现）。
 *
 * 本文件做什么：
 *   - 把 LongMemEval 官方 JSON（多轮对话 + 问题 + 答案）转换成本仓 GoldenCase。
 *   - 当前只覆盖最常见的 "question + answer + sessions" 格式；其余形态留待后续。
 *   - 默认不真跑：v0.1 release gate 不要求外部 benchmark；这里只确保有
 *     可重复的转换路径，供 v0.2+ 接入时直接复用。
 *
 * 核心流程：
 *   loadLongMemEval(filePath, opts):
 *     1) 读 JSON，期望顶层是 array，每条样本至少含 question / answer 两个字段；
 *     2) 把 sessions（多轮对话）展平成 seedMemories：
 *        - 每条 user/assistant 消息为一条 GoldenCase.seedMemory；
 *        - kind=observation；不强行赋 semanticType（v0.1 lookup-only）；
 *     3) GoldenCase.query = 样本 question；GoldenCase.expected.answerMustContain
 *        = answer.split / 关键词；
 *     4) 不做 evidence 校验（属于 prepare 流水线工作）。
 *
 * 关键边界：
 *   - 实际 LongMemEval 数据集字段名可能因版本而变；本 adapter 故意做容错处理，
 *     若某字段缺失，转换中跳过该字段而不抛错。
 *   - 本文件不下载数据集，仅做格式转换。数据集获取见 eval/README.md。
 *   - 不要把 LongMemEval 黄金集与本仓黄金集混存一个 jsonl；
 *     用 GoldenCase.suite 区分。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { GoldenCase, SeedMemorySpec } from "../runners/types.js";

/** LongMemEval 单条样本可识别的字段（适配宽松匹配）。 */
export interface LongMemEvalRawCase {
  question_id?: string;
  id?: string;
  question?: string;
  query?: string;
  answer?: string;
  answers?: string[];
  question_type?: string;
  sessions?: LongMemEvalSession[];
  haystack_sessions?: LongMemEvalSession[];
  /** 任意附加字段，保留供后续使用。 */
  [key: string]: unknown;
}

export interface LongMemEvalSession {
  session_id?: string;
  date?: string;
  /** OpenAI ChatML 风格消息列表。 */
  messages?: Array<{ role: string; content: string }>;
}

export interface LoadLongMemEvalOptions {
  /** 自定义 suite 名称，默认 "longmemeval-imported"。 */
  suite?: string;
  /** scope 默认填充值。 */
  scope?: GoldenCase["scope"];
  /** 限制最多转换多少条样本。 */
  limit?: number;
}

/**
 * 把 answer 文本分词成关键字数组（用于 answerMustContain 的字面比较）。
 * 仅做最简单的分词：中英文标点切分，过滤短词。
 */
function answerToKeywords(answer: string): string[] {
  if (!answer) return [];
  // 将常见标点替换成空格再 split
  const tokens = answer
    .replace(/[，。；：、！？,.;:!?\n\t]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  // 去重，限制最多 3 个关键字（避免过度断言）
  return Array.from(new Set(tokens)).slice(0, 3);
}

/** 单条 LongMemEval raw → GoldenCase。 */
export function rawToGoldenCase(
  raw: LongMemEvalRawCase,
  options: LoadLongMemEvalOptions = {},
): GoldenCase {
  const id =
    raw.question_id ??
    raw.id ??
    `lme-${Math.random().toString(36).slice(2, 10)}`;
  const query = raw.question ?? raw.query ?? "";
  const answer = raw.answer ?? (raw.answers?.[0] ?? "");

  const sessions = raw.sessions ?? raw.haystack_sessions ?? [];
  const seedMemories: SeedMemorySpec[] = [];
  let seedIdx = 0;
  for (const session of sessions) {
    const messages = session.messages ?? [];
    for (const msg of messages) {
      if (!msg.content) continue;
      seedMemories.push({
        id: `${id}-seed-${seedIdx++}`,
        kind: "observation",
        body: msg.content,
        metadata: {
          role: msg.role,
          sessionId: session.session_id,
          sessionDate: session.date,
        },
      });
    }
  }

  const scope = options.scope ?? {
    tenantId: "local",
    appId: "openclaw",
    userId: "longmemeval-user",
    workspaceId: "lme",
    projectId: "lme",
    namespace: "memories",
  };

  return {
    id,
    suite: options.suite ?? "longmemeval-imported",
    task: raw.question_type ?? "longmemeval question answering",
    scope,
    seedMemories,
    query,
    expected: {
      answerMustContain: answerToKeywords(answer),
    },
    metrics: ["context_precision", "evidence_grounding", "abstention"],
    notes:
      "由 longmemeval adapter 自动生成；evidence_grounding 与 answer 真值仅作 reference，不进入 v0.1 必跑。",
  };
}

/**
 * 加载一个 LongMemEval JSON 文件，返回 GoldenCase[]。
 *
 * @param filePath JSON 文件绝对/相对路径
 */
export function loadLongMemEval(
  filePath: string,
  options: LoadLongMemEvalOptions = {},
): GoldenCase[] {
  const absolute = path.resolve(filePath);
  const raw = readFileSync(absolute, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[longmemeval] 解析 ${absolute} 失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[longmemeval] ${absolute} 顶层必须是数组，收到 ${typeof parsed}`,
    );
  }
  const cases: GoldenCase[] = [];
  for (const sample of parsed as LongMemEvalRawCase[]) {
    cases.push(rawToGoldenCase(sample, options));
    if (options.limit && cases.length >= options.limit) {
      break;
    }
  }
  return cases;
}
