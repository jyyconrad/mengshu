/**
 * Canonicalize raw source content into Markdown plus metadata.
 *
 * 支持 YAML front matter 的常见子集，避免引入额外热路径复杂度；正文会做稳定的
 * 空白归一化，使 chunk hash 在重复导入时保持一致。
 */

import type { CanonicalizeInput, CanonicalizedDocument } from "./types.js";

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/g, "");
}

function parseFrontMatter(content: string): { attributes: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) {
    return { attributes: {}, body: content };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { attributes: {}, body: content };
  }
  const raw = content.slice(4, end).split("\n");
  const attributes: Record<string, unknown> = {};
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    const match = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    if (value) {
      attributes[key] = parseScalar(value);
      continue;
    }
    const list: string[] = [];
    while (raw[index + 1]?.trim().startsWith("- ")) {
      index += 1;
      list.push(raw[index].trim().slice(2).trim());
    }
    attributes[key] = list;
  }
  return { attributes, body: content.slice(end + 4) };
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function canonicalize(input: CanonicalizeInput): CanonicalizedDocument {
  const { attributes, body } = parseFrontMatter(input.content);
  return {
    sourceId: input.sourceId,
    markdown: normalizeMarkdown(body),
    metadata: {
      ...attributes,
      ...(input.metadata ?? {}),
      sourceId: input.sourceId,
    },
  };
}
