/**
 * Deterministic Markdown chunker.
 *
 * 该切分器优先按段落边界切分，必要时按空格切分；输出 id、ordinal 和 hash
 * 都只依赖 documentId、文本和顺序，便于重复导入和测试。
 */

import type { ChunkRecord } from "../domain/types.js";
import { computeContentHash } from "../scoring/hash-utils.js";
import type { ChunkMarkdownOptions } from "./types.js";

function splitParagraph(paragraph: string, chunkSize: number): string[] {
  if (paragraph.length <= chunkSize) {
    return [paragraph];
  }
  const words = paragraph.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > chunkSize && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkMarkdown(markdown: string, options: ChunkMarkdownOptions): ChunkRecord[] {
  const chunkSize = options.chunkSize ?? 1000;
  const rawParagraphs = markdown.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const texts: string[] = [];
  let current = "";

  for (const paragraph of rawParagraphs) {
    const pieces = splitParagraph(paragraph, chunkSize);
    for (const piece of pieces) {
      const next = current ? `${current}\n\n${piece}` : piece;
      if (next.length > chunkSize && current) {
        texts.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }
  if (current) {
    texts.push(current);
  }

  return texts.map((text, ordinal) => ({
    id: `${options.documentId}:chunk:${ordinal}`,
    scope: options.scope ?? {
      tenantId: "",
      appId: "",
      userId: "",
      projectId: "",
      agentId: "",
      namespace: "",
    },
    documentId: options.documentId,
    text,
    contentHash: computeContentHash(text),
    ordinal,
    metadata: { scopeKey: options.scopeKey },
    provenance: { sourceId: options.documentId, createdAt: options.createdAt },
    createdAt: options.createdAt,
  }));
}
