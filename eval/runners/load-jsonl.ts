/**
 * jsonl 黄金集加载器。
 *
 * 本文件做什么：
 *   - 从一个 jsonl 文件读取 GoldenCase[]。
 *   - 跳过空行和以 `#` 开头的注释行（jsonl 规范不支持注释，本项目放宽以方便人工维护）。
 *   - 校验每行是合法 JSON、含必要字段（id / suite / scope / seedMemories / query / expected）。
 *
 * 核心流程：
 *   readFileSync → split(\n) → 过滤空行/注释 → JSON.parse → 字段断言。
 *
 * 关键边界：
 *   - 校验失败抛错并附带行号，便于人工定位。
 *   - 不做语义校验（如 evidence id 是否真实存在），那是 prepare 流水线的工作。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { GoldenCase, GoldenSuite } from "./types.js";

export interface LoadJsonlOptions {
  /** 限制只加载某个 suite。 */
  suite?: GoldenSuite;
  /** 限制最多加载多少条。 */
  limit?: number;
}

function assertField<T>(
  value: T,
  name: string,
  lineNo: number,
  filePath: string,
): asserts value is NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(
      `[load-jsonl] ${filePath}:${lineNo} 缺少必需字段 '${name}'`,
    );
  }
}

/**
 * 加载 jsonl 黄金集文件，返回 GoldenCase[]。
 */
export function loadGoldenJsonl(
  filePath: string,
  options: LoadJsonlOptions = {},
): GoldenCase[] {
  const absolute = path.resolve(filePath);
  const raw = readFileSync(absolute, "utf-8");
  const lines = raw.split("\n");
  const cases: GoldenCase[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    let parsed: GoldenCase;
    try {
      parsed = JSON.parse(trimmed) as GoldenCase;
    } catch (error) {
      throw new Error(
        `[load-jsonl] ${absolute}:${i + 1} JSON 解析失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    assertField(parsed.id, "id", i + 1, absolute);
    assertField(parsed.suite, "suite", i + 1, absolute);
    assertField(parsed.scope, "scope", i + 1, absolute);
    assertField(parsed.seedMemories, "seedMemories", i + 1, absolute);
    assertField(parsed.query, "query", i + 1, absolute);
    assertField(parsed.expected, "expected", i + 1, absolute);

    if (!Array.isArray(parsed.seedMemories)) {
      throw new Error(
        `[load-jsonl] ${absolute}:${i + 1} seedMemories 必须为数组`,
      );
    }

    if (options.suite && parsed.suite !== options.suite) {
      continue;
    }

    cases.push(parsed);

    if (options.limit && cases.length >= options.limit) {
      break;
    }
  }

  return cases;
}

/**
 * 加载多个 jsonl 文件并合并。
 */
export function loadGoldenJsonlMany(
  filePaths: string[],
  options: LoadJsonlOptions = {},
): GoldenCase[] {
  const result: GoldenCase[] = [];
  for (const filePath of filePaths) {
    result.push(...loadGoldenJsonl(filePath, options));
  }
  return result;
}
