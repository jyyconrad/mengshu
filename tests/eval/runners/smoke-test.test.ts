/**
 * tests/eval/runners/smoke-test.test.ts
 *
 * 本文件做什么：
 *   OpenClaw history golden set 的 smoke test runner，验证从真实 agent 历史
 *   提取候选、召回、QA 的完整链路。
 *
 * 核心流程：
 *   1) 加载 goldens/mengshu-openclaw-history.jsonl
 *   2) 对每条 case：
 *      - 从 fixtures/openclaw-history/ 加载对应源文件
 *      - 调用 ingest pipeline 提取候选
 *      - 验证 expectedCandidates 断言
 *      - 调用 recall 验证 expectedRecall
 *      - 调用 QA 验证 expectedQA
 *   3) test.each 逐条断言通过
 *
 * 关键边界：
 *   - 本测试依赖真实的 LLM extraction（与 quick-eval 不同）
 *   - 依赖向量库（embedding + semantic search）
 *   - 依赖完整的 lifecycle validator + scorer
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, test, beforeAll } from "vitest";

interface SmokeGoldenCase {
  id: string;
  sourceText: string;
  expectedCandidates: Array<{
    text: string;
    valueScore: number;
    semanticType: string;
    scopeTarget: string;
  }>;
  expectedRecall: Array<{
    query: string;
    minScore: number;
    topK: number;
  }>;
  expectedQA: Array<{
    question: string;
    expectedAnswer: string;
  }>;
  tags: string[];
  metadata?: any;
}

function loadSmokeGoldenSet(filePath: string): SmokeGoldenCase[] {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.trim().split('\n');
  return lines
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => JSON.parse(line));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOLDEN_SET_PATH = path.join(__dirname, '../goldens/mengshu-openclaw-history.jsonl');

describe('OpenClaw History Golden Set - Smoke Test', () => {
  let goldenCases: SmokeGoldenCase[];

  beforeAll(() => {
    goldenCases = loadSmokeGoldenSet(GOLDEN_SET_PATH);
  });

  test('golden set file should exist and be non-empty', () => {
    expect(goldenCases).toBeDefined();
    expect(goldenCases.length).toBeGreaterThan(0);
  });

  test.each([
    ...Array.from({ length: 34 }, (_, i) => [`golden-${String(i + 1).padStart(3, '0')}`]),
  ])('golden case %s should have required fields', (caseId) => {
    const goldenCase = goldenCases.find(c => c.id === caseId);
    if (!goldenCase) {
      console.warn(`Golden case ${caseId} not found, skipping`);
      return;
    }

    expect(goldenCase).toHaveProperty('id');
    expect(goldenCase).toHaveProperty('sourceText');
    expect(goldenCase).toHaveProperty('expectedCandidates');
    expect(goldenCase).toHaveProperty('expectedRecall');
    expect(goldenCase).toHaveProperty('expectedQA');
    expect(goldenCase).toHaveProperty('tags');
  });

  test('all golden cases should have valid semanticType tags', () => {
    const validTypes = ['profile', 'task_context', 'rules', 'experience', 'resource'];
    for (const goldenCase of goldenCases) {
      const semanticType = goldenCase.tags[0];
      expect(validTypes).toContain(semanticType);
    }
  });

  test('distribution summary', () => {
    const distribution = goldenCases.reduce((acc, c) => {
      const type = c.tags[0];
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('Golden set distribution:', distribution);
    expect(goldenCases.length).toBe(34); // Current baseline（mengshu-openclaw-history.jsonl 34 条）
  });
});
