import { describe, expect, test } from "vitest";

import { createMarkdownWorksetRecord } from "./markdown-workset.js";
import {
  preprocessMarkdownWorksetRecord,
  type MarkdownPreprocessRelationship,
} from "./markdown-workset-preprocessor.js";
import {
  parsePreprocessedMarkdown,
  preprocessedNodeSha256,
  renderPreprocessedMarkdown,
} from "./markdown-workset-preprocessed.js";

function fixture() {
  const source = createMarkdownWorksetRecord({
    phase: "source",
    scopeFingerprint: "a".repeat(64),
    record: {
      id: "m1",
      sourceTable: "memories",
      text: "必须运行 npm test。\r\n保留证据。",
      contentHash: "legacy",
      vector: [0.1],
      importance: 0.9,
      category: "rule",
      dataType: "rule",
      metadata: {
        source: "docs/guide.md",
        revision: { id: "r1", order: 1 },
        semanticType: "rules",
        valueScore: 0.9,
        topicLabels: ["Quality"],
      },
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  });
  const node = preprocessMarkdownWorksetRecord(source);
  const relationships: readonly MarkdownPreprocessRelationship[] = [{
    kind: "same_logical_source_candidate",
    from: "memories:m2",
    to: source.sourceRef,
    groupKey: "b".repeat(64),
  }];
  return { source, node, relationships };
}

describe("Preprocessed Markdown codec", () => {
  test("round-trip 保留候选、关系和规范化正文，并生成稳定 node hash", () => {
    const { source, node, relationships } = fixture();
    const markdown = renderPreprocessedMarkdown({
      policyVersion: "markdown-preprocess/v1",
      node,
      relationships,
      content: source.record.text,
    });
    const parsed = parsePreprocessedMarkdown(markdown);

    expect(parsed.node).toEqual(node);
    expect(parsed.relationships).toEqual(relationships);
    expect(parsed.content).toBe("必须运行 npm test。\n保留证据。");
    expect(parsed.nodeSha256).toBe(preprocessedNodeSha256(node));
    expect(markdown).toContain("## Candidate 5 Type");
    expect(markdown).toContain("`rules` (1.00, metadata.semanticType)");
    expect(markdown).toContain("## Original Source Content");
  });

  test("正文或可见候选摘要漂移都会拒绝", () => {
    const { source, node, relationships } = fixture();
    const markdown = renderPreprocessedMarkdown({
      policyVersion: "markdown-preprocess/v1",
      node,
      relationships,
      content: source.record.text,
    });
    expect(() => parsePreprocessedMarkdown(markdown.replace("保留证据", "删除证据")))
      .toThrow(/drift/i);
    expect(() => parsePreprocessedMarkdown(markdown.replace("Candidate 5 Type", "Final 5 Type")))
      .toThrow(/drift/i);
  });

  test("拒绝不涉及当前 sourceRef 的关系", () => {
    const { source, node } = fixture();
    expect(() => renderPreprocessedMarkdown({
      policyVersion: "markdown-preprocess/v1",
      node,
      relationships: [{
        kind: "same_revision_candidate",
        from: "memories:other-1",
        to: "memories:other-2",
        groupKey: "b".repeat(64),
      }],
      content: source.record.text,
    })).toThrow(/invalid/i);
  });
});
