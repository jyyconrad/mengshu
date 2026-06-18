import { describe, expect, test } from "vitest";
import { appendLeafToBuffer, InMemoryTreeRepository } from "./buffer.js";
import { sealBuffer } from "./seal.js";
import type { TreeLeaf, SummaryFaithfulnessConfig } from "./types.js";
import type { LlmClient } from "../processing/llm-client.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function leaf(id: string, text: string, importance: number, eventAt: number): TreeLeaf {
  return {
    id,
    scope,
    chunkId: `chunk-${id}`,
    sourceId: "file:/docs/guide.md",
    entityIds: [`entity-${id}`],
    importance,
    eventAt,
    createdAt: eventAt,
    text,
    tokenCount: 5,
  };
}

// Mock LlmClient for faithfulness testing
class MockLlmClient implements LlmClient {
  public readonly available = true;
  private shouldFail = false;

  constructor(private abstractiveSummary: string = "This is an abstractive summary") {}

  setFaithfulnessFail(fail: boolean) {
    this.shouldFail = fail;
  }

  async complete() {
    if (this.shouldFail) {
      return JSON.stringify({ faithful: false, score: 0.3, reason: "Introduces unsupported claims" });
    }
    return JSON.stringify({ faithful: true, score: 0.95, reason: "All claims supported" });
  }

  async summarize() {
    return this.abstractiveSummary;
  }

  async extractStructured<T>(
    _messages: Array<{ role: string; content: string }>,
    _schema: unknown,
    _options?: { temperature?: number; maxTokens?: number },
  ): Promise<T> {
    // 返回符合 SealSummaryOutput 的结构化输出
    const result = {
      title: "Test Summary Title",
      summary: this.abstractiveSummary,
      keyFacts: [
        {
          text: "Key fact from evidence",
          evidenceLeafIds: ["1"],
        },
      ],
      evidenceLeafIds: ["1"],
    };
    return result as T;
  }
}

describe("sealBuffer", () => {
  test("creates extractive summary node and removes sealed buffer", async () => {
    const repository = new InMemoryTreeRepository();
    const first = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "file:/docs/guide.md",
      leaf: leaf("1", "lower priority event", 0.3, 1710000000000),
      now: 1710000000000,
    });
    const second = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "file:/docs/guide.md",
      leaf: leaf("2", "important memory tree event", 0.9, 1710000001000),
      now: 1710000001000,
    });

    const node = await sealBuffer(repository, {
      buffer: second.buffer,
      now: 1710000010000,
      title: "Guide Summary",
      relationIds: ["rel-1"],
    });

    expect(node).toMatchObject({
      treeType: "source",
      treeKey: "file:/docs/guide.md",
      level: 1,
      title: "Guide Summary",
      status: "sealed",
      evidenceChunkIds: ["chunk-1", "chunk-2"],
      relationIds: ["rel-1"],
      metadata: { summaryMode: "extractive" },
    });
    expect(node.summary.indexOf("important memory tree event")).toBeLessThan(
      node.summary.indexOf("lower priority event"),
    );
    await expect(repository.getBuffer(first.buffer.id)).resolves.toBeUndefined();
    await expect(repository.getSummary(node.id)).resolves.toEqual(node);
  });

  test("faithfulness validation with mode=off skips LLM judge", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new MockLlmClient("Abstractive summary with LLM");
    const faithfulnessConfig: SummaryFaithfulnessConfig = {
      mode: "off",
      failAction: "fallback_extractive",
    };

    const { buffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "test-key",
      leaf: leaf("1", "test event", 0.8, 1710000000000),
      now: 1710000000000,
    });

    const node = await sealBuffer(repository, {
      buffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    expect(node.metadata.summaryMode).toBe("abstractive");
    expect(node.metadata.faithfulnessValidated).toBeUndefined(); // Not validated in mode=off
  });

  test("faithfulness validation with mode=always runs LLM judge", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new MockLlmClient("Abstractive summary with LLM");
    const faithfulnessConfig: SummaryFaithfulnessConfig = {
      mode: "always",
      failAction: "fallback_extractive",
    };

    const { buffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "test-key",
      leaf: leaf("1", "test event", 0.8, 1710000000000),
      now: 1710000000000,
    });

    const node = await sealBuffer(repository, {
      buffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    expect(node.metadata.summaryMode).toBe("abstractive");
    expect(node.metadata.faithfulnessValidated).toBe(true);
    expect(node.metadata.faithfulnessUsedLlmJudge).toBe(true);
  });

  test("faithfulness validation fails and falls back to extractive", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new MockLlmClient("Abstractive summary with false claims");
    llmClient.setFaithfulnessFail(true);

    const faithfulnessConfig: SummaryFaithfulnessConfig = {
      mode: "always",
      failAction: "fallback_extractive",
    };

    const { buffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "test-key",
      leaf: leaf("1", "real evidence text", 0.8, 1710000000000),
      now: 1710000000000,
    });

    const node = await sealBuffer(repository, {
      buffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    expect(node.metadata.summaryMode).toBe("extractive");
    expect(node.metadata.faithfulnessFailed).toBe(true);
    expect(node.summary).toContain("real evidence text"); // Fallback to extractive
  });

  test("faithfulness validation with mode=high_risk only validates high-risk summaries", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new MockLlmClient("Abstractive summary");
    const faithfulnessConfig: SummaryFaithfulnessConfig = {
      mode: "high_risk",
      failAction: "fallback_extractive",
    };

    // High-risk: rules topic
    const { buffer: highRiskBuffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "topic",
      treeKey: "rules",
      leaf: leaf("1", "rules content", 0.8, 1710000000000),
      now: 1710000000000,
    });

    const highRiskNode = await sealBuffer(repository, {
      buffer: highRiskBuffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    expect(highRiskNode.metadata.faithfulnessValidated).toBe(true);
    expect(highRiskNode.metadata.faithfulnessUsedLlmJudge).toBe(true);

    // Regular: source tree
    const { buffer: regularBuffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "docs",
      leaf: leaf("2", "docs content", 0.8, 1710000001000),
      now: 1710000001000,
    });

    const regularNode = await sealBuffer(repository, {
      buffer: regularBuffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    expect(regularNode.metadata.faithfulnessValidated).toBeUndefined(); // Not high-risk, not validated
  });

  test("faithfulness validation with failAction=mark_untrusted keeps abstractive summary", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new MockLlmClient("Abstractive summary with questionable claims");
    llmClient.setFaithfulnessFail(true);

    const faithfulnessConfig: SummaryFaithfulnessConfig = {
      mode: "always",
      failAction: "mark_untrusted",
    };

    const { buffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "test-key",
      leaf: leaf("1", "real evidence text", 0.8, 1710000000000),
      now: 1710000000000,
    });

    const node = await sealBuffer(repository, {
      buffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    expect(node.metadata.summaryMode).toBe("abstractive");
    expect(node.metadata.faithfulnessUntrusted).toBe(true);
    expect(node.metadata.faithfulnessReason).toContain("Introduces unsupported claims");
    expect(node.summary).toContain("Abstractive summary"); // Keeps abstractive, but marked untrusted
  });

  test("faithfulness validation with failAction=retry falls back to extractive", async () => {
    const repository = new InMemoryTreeRepository();
    const llmClient = new MockLlmClient("Abstractive summary that fails validation");
    llmClient.setFaithfulnessFail(true);

    const faithfulnessConfig: SummaryFaithfulnessConfig = {
      mode: "always",
      failAction: "retry",
    };

    const { buffer } = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "test-key",
      leaf: leaf("1", "real evidence text", 0.8, 1710000000000),
      now: 1710000000000,
    });

    const node = await sealBuffer(repository, {
      buffer,
      now: 1710000010000,
      llmClient,
      faithfulnessConfig,
    });

    // retry 策略当前简化为降级到 extractive
    expect(node.metadata.summaryMode).toBe("extractive");
    expect(node.metadata.faithfulnessFailed).toBe(true);
    expect(node.summary).toContain("real evidence text");
  });
});
