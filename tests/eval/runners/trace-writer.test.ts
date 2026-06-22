/**
 * trace-writer 单元测试（P0-3）。
 *
 * 覆盖：
 *   - writeManifest / 5 阶段 write* 落盘 schema
 *   - truncateText / truncateEmbedding 数据量控制
 *   - loadReplayBundle / resolveRunDir replay 读回
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMBEDDING_PREVIEW_DIMS,
  RAW_TEXT_MAX_CHARS,
  TraceWriter,
  loadReplayBundle,
  resolveRunDir,
  truncateEmbedding,
  truncateText,
} from "./trace-writer.js";

describe("trace-writer 工具函数", () => {
  it("truncateText 保留短文本不变", () => {
    expect(truncateText("hello")).toBe("hello");
  });

  it("truncateText 截断超长文本并追加省略号", () => {
    const long = "a".repeat(RAW_TEXT_MAX_CHARS + 100);
    const result = truncateText(long);
    expect(result.length).toBe(RAW_TEXT_MAX_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("truncateEmbedding 只保留前 N 维并记录维度数", () => {
    const vec = Array.from({ length: 1024 }, (_, i) => i);
    const { preview, dimensions } = truncateEmbedding(vec);
    expect(preview).toHaveLength(EMBEDDING_PREVIEW_DIMS);
    expect(dimensions).toBe(1024);
    expect(preview[0]).toBe(0);
  });
});

describe("TraceWriter 落盘", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-writer-test-"));
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it("writeManifest 写入完整元数据", () => {
    const writer = new TraceWriter(runDir);
    const manifest = writer.writeManifest({
      cli: "ms project ingest-history --eval-run",
      redactionMapVersion: "2026.06.19-2",
      models: { embedding: "BAAI/bge-m3" },
      gitSha: "abc1234",
    });

    expect(manifest.runId).toBe(path.basename(runDir));
    expect(manifest.gitSha).toBe("abc1234");
    expect(manifest.redactionMapVersion).toBe("2026.06.19-2");
    expect(manifest.models.embedding).toBe("BAAI/bge-m3");

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"),
    );
    expect(onDisk.runId).toBe(manifest.runId);
    expect(onDisk.createdAt).toBeTruthy();
  });

  it("writeManifest replay 标记写入 replay.fromRunId", () => {
    const writer = new TraceWriter(runDir);
    const manifest = writer.writeManifest({
      cli: "ms project ingest-history --replay-from 2026-06-19T14-49-32",
      redactionMapVersion: "2026.06.19-2",
      models: {},
      replayFromRunId: "2026-06-19T14-49-32",
    });
    expect(manifest.replay?.fromRunId).toBe("2026-06-19T14-49-32");
  });

  it("5 阶段 write* 产出预期文件", () => {
    const writer = new TraceWriter(runDir);

    writer.writeIngestTrace([
      { candidateId: "c1", text: "prefer concise", semanticType: "profile" },
    ]);
    writer.writeLlmRequests([
      {
        refId: "c1",
        stage: "extract",
        requestPreview: "x".repeat(RAW_TEXT_MAX_CHARS + 50),
        responsePreview: "ok",
      },
    ]);
    writer.writeValidatorDecisions([
      { candidateId: "c1", passed: true, gates: { explicitness: { pass: true } } },
    ]);
    writer.writeRecallTrace([
      { caseId: "r1", query: "q", topResults: [{ rank: 1, totalScore: 0.5, contentPreview: "p" }] },
    ]);
    writer.writeEmbeddingRequests([
      {
        refId: "r1",
        textPreview: "q",
        embeddingPreview: Array.from({ length: 50 }, (_, i) => i),
        dimensions: 1024,
      },
    ]);
    writer.writeRankingBreakdown([
      {
        caseId: "r1",
        memoryId: "m1",
        importance: 0.8,
        breakdown: { salienceLlm: 0.4, sourceAuthority: 0.2, explicitnessBonus: 0.1, typePrior: 0.1 },
      },
    ]);
    writer.writeQaTrace([
      {
        caseId: "qa1",
        query: "q",
        filledSlots: ["profile"],
        injectedMemoryIds: ["m1"],
        contextPreview: "ctx",
      },
    ]);
    writer.writeCitationVerification([
      {
        caseId: "qa1",
        claimedCitations: ["m1"],
        verifiedCitations: ["m1"],
        unverifiedCitations: [],
        passed: true,
      },
    ]);
    writer.writeAnalysis({
      failures: [{ caseId: "qa1", failures: ["x"] }],
      performance: { generatedAt: "now", totalCases: 1, latency: {} },
      coverage: { generatedAt: "now", evidenceMissingCount: 0 },
    });

    const expectedFiles = [
      "phase-2-ingest/ingest-trace.jsonl",
      "phase-2-ingest/llm-requests.jsonl",
      "phase-2-ingest/validator-decisions.jsonl",
      "phase-3-recall/recall-trace.jsonl",
      "phase-3-recall/embedding-requests.jsonl",
      "phase-3-recall/ranking-breakdown.jsonl",
      "phase-4-qa/qa-trace.jsonl",
      "phase-4-qa/citation-verification.jsonl",
      "phase-5-analysis/failures.jsonl",
      "phase-5-analysis/performance.json",
      "phase-5-analysis/coverage-report.json",
    ];
    for (const rel of expectedFiles) {
      expect(fs.existsSync(path.join(runDir, rel)), `missing ${rel}`).toBe(true);
    }

    // 验证 LLM 请求被截断
    const llmLine = fs
      .readFileSync(path.join(runDir, "phase-2-ingest/llm-requests.jsonl"), "utf-8")
      .trim();
    const llm = JSON.parse(llmLine);
    expect(llm.requestPreview.length).toBe(RAW_TEXT_MAX_CHARS);

    // 验证 embedding 向量被截断到前 N 维
    const embLine = fs
      .readFileSync(path.join(runDir, "phase-3-recall/embedding-requests.jsonl"), "utf-8")
      .trim();
    const emb = JSON.parse(embLine);
    expect(emb.embeddingPreview).toHaveLength(EMBEDDING_PREVIEW_DIMS);
    expect(emb.dimensions).toBe(1024);
  });
});

describe("replay 读回", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-replay-test-"));
  });

  afterEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it("loadReplayBundle 读回 manifest 与各阶段 trace", () => {
    const writer = new TraceWriter(runDir);
    writer.writeManifest({
      cli: "x",
      redactionMapVersion: "v1",
      models: { embedding: "bge" },
      gitSha: "sha1",
    });
    writer.writeIngestTrace([{ candidateId: "c1", text: "t", semanticType: "profile" }]);
    writer.writeRecallTrace([
      { caseId: "r1", query: "q", topResults: [{ rank: 1, totalScore: 0.5, contentPreview: "p" }] },
    ]);
    writer.writeQaTrace([
      {
        caseId: "qa1",
        query: "q",
        filledSlots: ["profile"],
        injectedMemoryIds: ["m1"],
        contextPreview: "ctx",
      },
    ]);

    const bundle = loadReplayBundle(runDir);
    expect(bundle.manifest?.gitSha).toBe("sha1");
    expect(bundle.ingestTrace).toHaveLength(1);
    expect(bundle.recallTrace).toHaveLength(1);
    expect(bundle.qaTrace[0].caseId).toBe("qa1");
  });

  it("loadReplayBundle 对缺失文件返回空数组", () => {
    new TraceWriter(runDir).writeManifest({
      cli: "x",
      redactionMapVersion: "v1",
      models: {},
    });
    const bundle = loadReplayBundle(runDir);
    expect(bundle.ingestTrace).toEqual([]);
    expect(bundle.recallTrace).toEqual([]);
    expect(bundle.qaTrace).toEqual([]);
  });

  it("loadReplayBundle 对不存在目录抛错", () => {
    expect(() => loadReplayBundle(path.join(runDir, "nope"))).toThrow(/not found/);
  });

  it("resolveRunDir 支持绝对路径直接返回", () => {
    const resolved = resolveRunDir({
      runIdOrPath: runDir,
      evalCorpusRoot: "/tmp/eval-corpus",
      source: "openclaw",
    });
    expect(resolved).toBe(path.resolve(runDir));
  });

  it("resolveRunDir 支持仅 runId 拼接路径", () => {
    const resolved = resolveRunDir({
      runIdOrPath: "2026-06-19T14-49-32",
      evalCorpusRoot: "/tmp/eval-corpus",
      source: "openclaw",
    });
    expect(resolved).toBe(
      path.join("/tmp/eval-corpus", "openclaw", "validation-runs", "2026-06-19T14-49-32"),
    );
  });
});
