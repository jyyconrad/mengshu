import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  type MarkdownPreprocessNode,
  type MarkdownPreprocessRelationship,
} from "./markdown-workset-preprocessor.js";

export const MARKDOWN_WORKSET_PREPROCESSED_SCHEMA =
  "mengshu.preprocessed-native-record/v1" as const;

export interface RenderPreprocessedMarkdownInput {
  readonly policyVersion: string;
  readonly node: MarkdownPreprocessNode;
  readonly relationships: readonly MarkdownPreprocessRelationship[];
  readonly content: string;
}

export interface ParsedPreprocessedMarkdown extends RenderPreprocessedMarkdownInput {
  readonly schema: typeof MARKDOWN_WORKSET_PREPROCESSED_SCHEMA;
  readonly nodeSha256: string;
}

export type MarkdownWorksetPreprocessedErrorCode =
  | "MARKDOWN_WORKSET_PREPROCESSED_INVALID_INPUT"
  | "MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN"
  | "MARKDOWN_WORKSET_PREPROCESSED_DRIFT";

const MESSAGES: Record<MarkdownWorksetPreprocessedErrorCode, string> = {
  MARKDOWN_WORKSET_PREPROCESSED_INVALID_INPUT: "Preprocessed Markdown input is invalid",
  MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN: "Preprocessed Markdown is invalid",
  MARKDOWN_WORKSET_PREPROCESSED_DRIFT: "Preprocessed Markdown content or descriptor drifted",
};

export class MarkdownWorksetPreprocessedError extends Error {
  constructor(readonly code: MarkdownWorksetPreprocessedErrorCode) {
    super(MESSAGES[code]);
    this.name = "MarkdownWorksetPreprocessedError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const RELATIONSHIP_KINDS = new Set<MarkdownPreprocessRelationship["kind"]>([
  "exact_duplicate_candidate",
  "same_logical_source_candidate",
  "same_revision_candidate",
  "same_snapshot_revision_candidate",
  "revision_successor_candidate",
  "resource_alias_candidate",
]);
const CONTENT_MARKER = /<!-- mengshu-preprocessed-content-bytes: ([0-9]+) -->\n/g;

function fail(code: MarkdownWorksetPreprocessedErrorCode): never {
  throw new MarkdownWorksetPreprocessedError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeContent(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function validNode(value: unknown): value is MarkdownPreprocessNode {
  if (!plainRecord(value) || typeof value.sourceRef !== "string" ||
      !SAFE_TEXT.test(value.sourceRef) || typeof value.sourceHash !== "string" ||
      value.sourceTable !== "memories" && value.sourceTable !== "knowledge" ||
      !SHA256.test(value.sourceHash) || typeof value.normalizedContentHash !== "string" ||
      !SHA256.test(value.normalizedContentHash) ||
      (value.scopeFingerprint !== undefined &&
        (typeof value.scopeFingerprint !== "string" || !SHA256.test(value.scopeFingerprint))) ||
      !Array.isArray(value.semanticTypeCandidates) || !Array.isArray(value.logicalSourceCandidates) ||
      !Array.isArray(value.revisionCandidates) || !Array.isArray(value.ordinalCandidates) ||
      !Array.isArray(value.resourceCandidates) ||
      !Array.isArray(value.topicCandidates) || !plainRecord(value.routeCandidates) ||
      !Array.isArray(value.qualityFlags)) return false;
  return true;
}

function validRelationships(
  value: unknown,
  sourceRef: string,
): value is readonly MarkdownPreprocessRelationship[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return false;
  const keys = new Set<string>();
  for (const relationship of value) {
    if (!plainRecord(relationship) || typeof relationship.kind !== "string" ||
        !RELATIONSHIP_KINDS.has(relationship.kind as MarkdownPreprocessRelationship["kind"]) ||
        typeof relationship.from !== "string" || !SAFE_TEXT.test(relationship.from) ||
        typeof relationship.to !== "string" || !SAFE_TEXT.test(relationship.to) ||
        relationship.from === relationship.to ||
        relationship.from !== sourceRef && relationship.to !== sourceRef ||
        typeof relationship.groupKey !== "string" || !SHA256.test(relationship.groupKey)) {
      return false;
    }
    const key = `${relationship.kind}:${relationship.from}:${relationship.to}:${relationship.groupKey}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export function preprocessedNodeSha256(node: MarkdownPreprocessNode): string {
  if (!validNode(node)) fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_INPUT");
  return sha256(stableJson(node));
}

function jsonDisplay(value: string): string {
  return JSON.stringify(value);
}

function visibleSummary(input: RenderPreprocessedMarkdownInput): string {
  const typeLines = input.node.semanticTypeCandidates.length === 0
    ? ["- none"]
    : input.node.semanticTypeCandidates.map((candidate) =>
      `- \`${candidate.semanticType}\` (${candidate.confidence.toFixed(2)}, ${candidate.reason})`);
  const sourceLines = input.node.logicalSourceCandidates.length === 0
    ? ["- none"]
    : input.node.logicalSourceCandidates.map((candidate) =>
      `- ${jsonDisplay(candidate.identity)} (${candidate.confidence.toFixed(2)}, ${candidate.field})`);
  const revisionLines = input.node.revisionCandidates.length === 0
    ? ["- none"]
    : input.node.revisionCandidates.map((candidate) =>
      `- ${jsonDisplay(candidate.id)} (${candidate.confidence.toFixed(2)}, ${candidate.field}${
        candidate.order === undefined ? "" : `, order=${candidate.order}`})`);
  const ordinalLines = input.node.ordinalCandidates.length === 0
    ? ["- none"]
    : input.node.ordinalCandidates.map((candidate) =>
      `- ${candidate.ordinal} (${candidate.confidence.toFixed(2)}, ${candidate.field})`);
  const resourceLines = input.node.resourceCandidates.length === 0
    ? ["- none"]
    : input.node.resourceCandidates.map((candidate) =>
      `- \`${candidate.kind}\` ${jsonDisplay(candidate.locator)} (${candidate.confidence.toFixed(2)}, ${candidate.field})`);
  const topicLines = input.node.topicCandidates.length === 0
    ? ["- none"]
    : input.node.topicCandidates.map((candidate) =>
      `- ${jsonDisplay(candidate.label)} -> \`${candidate.key}\` (${candidate.confidence.toFixed(2)})`);
  const relationshipLines = input.relationships.length === 0
    ? ["- none"]
    : input.relationships.map((relationship) =>
      `- \`${relationship.kind}\`: \`${relationship.from}\` -> \`${relationship.to}\` (${relationship.groupKey})`);
  return [
    "# Preprocessed Migration Record",
    "",
    "> Candidate-only migration material. No candidate below is a final governance decision.",
    "",
    `- Source ref: \`${input.node.sourceRef}\``,
    `- Source hash: \`${input.node.sourceHash}\``,
    `- Scope fingerprint: \`${input.node.scopeFingerprint ?? "missing"}\``,
    `- Normalized content hash: \`${input.node.normalizedContentHash}\``,
    `- Policy: \`${input.policyVersion}\``,
    "",
    "## Candidate 5 Type",
    "",
    ...typeLines,
    "",
    "## Logical Source Candidates",
    "",
    ...sourceLines,
    "",
    "## Revision Candidates",
    "",
    ...revisionLines,
    "",
    "## Chunk Ordinal Candidates",
    "",
    ...ordinalLines,
    "",
    "## Resource Candidates",
    "",
    ...resourceLines,
    "",
    "## Topic Candidates",
    "",
    ...topicLines,
    "",
    "## Tree Route Candidates",
    "",
    `- source: \`${input.node.routeCandidates.source}\``,
    `- topic: \`${input.node.routeCandidates.topic}\``,
    `- global: \`${input.node.routeCandidates.global}\``,
    "",
    "## Quality Flags",
    "",
    ...(input.node.qualityFlags.length === 0
      ? ["- none"]
      : input.node.qualityFlags.map((flag) => `- \`${flag}\``)),
    "",
    "## Relationship Candidates",
    "",
    ...relationshipLines,
    "",
    "## Original Source Content",
    "",
  ].join("\n");
}

export function renderPreprocessedMarkdown(input: RenderPreprocessedMarkdownInput): string {
  if (!plainRecord(input) || typeof input.policyVersion !== "string" ||
      !SAFE_TEXT.test(input.policyVersion) || !validNode(input.node) ||
      !validRelationships(input.relationships, input.node.sourceRef) ||
      typeof input.content !== "string") fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_INPUT");
  const content = normalizeContent(input.content);
  if (sha256(content) !== input.node.normalizedContentHash) {
    fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_INPUT");
  }
  const nodeSha256 = preprocessedNodeSha256(input.node);
  const descriptor = Buffer.from(stableJson({
    node: input.node,
    relationships: input.relationships,
  }), "utf8").toString("base64url");
  const summary = visibleSummary({ ...input, content });
  return [
    "---",
    `mengshu_preprocessed_schema: ${MARKDOWN_WORKSET_PREPROCESSED_SCHEMA}`,
    `mengshu_policy_version: ${input.policyVersion}`,
    `mengshu_source_ref: ${input.node.sourceRef}`,
    `mengshu_source_hash: ${input.node.sourceHash}`,
    `mengshu_node_sha256: ${nodeSha256}`,
    "mengshu_descriptor_encoding: base64url-json",
    `mengshu_descriptor: ${descriptor}`,
    "---",
    summary,
    `<!-- mengshu-preprocessed-content-bytes: ${Buffer.byteLength(content, "utf8")} -->`,
    content,
  ].join("\n");
}

function parseHeaders(markdown: string): Readonly<{
  headers: Readonly<Record<string, string>>;
  body: string;
}> {
  if (!markdown.startsWith("---\n")) fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  const headers: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
    const key = line.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(headers, key)) {
      fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
    }
    headers[key] = line.slice(separator + 2);
  }
  return Object.freeze({ headers: Object.freeze(headers), body: markdown.slice(end + 5) });
}

export function parsePreprocessedMarkdown(markdown: string): ParsedPreprocessedMarkdown {
  if (typeof markdown !== "string") fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  const { headers, body } = parseHeaders(markdown);
  const required = [
    "mengshu_preprocessed_schema", "mengshu_policy_version", "mengshu_source_ref",
    "mengshu_source_hash", "mengshu_node_sha256", "mengshu_descriptor_encoding",
    "mengshu_descriptor",
  ];
  if (Object.keys(headers).length !== required.length ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(headers, key)) ||
      headers.mengshu_preprocessed_schema !== MARKDOWN_WORKSET_PREPROCESSED_SCHEMA ||
      headers.mengshu_descriptor_encoding !== "base64url-json") {
    fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  }
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(Buffer.from(headers.mengshu_descriptor!, "base64url").toString("utf8"));
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  }
  if (!plainRecord(descriptor) || !validNode(descriptor.node) ||
      !validRelationships(descriptor.relationships, descriptor.node.sourceRef)) {
    fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  }
  CONTENT_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = CONTENT_MARKER.exec(body)) !== null) last = match;
  if (!last) fail("MARKDOWN_WORKSET_PREPROCESSED_INVALID_MARKDOWN");
  const expectedBytes = Number(last[1]);
  const contentStart = last.index + last[0].length;
  const content = body.slice(contentStart);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      Buffer.byteLength(content, "utf8") !== expectedBytes) {
    fail("MARKDOWN_WORKSET_PREPROCESSED_DRIFT");
  }
  const parsed: RenderPreprocessedMarkdownInput = {
    policyVersion: headers.mengshu_policy_version!,
    node: descriptor.node,
    relationships: descriptor.relationships,
    content,
  };
  let canonical: string;
  try {
    canonical = renderPreprocessedMarkdown(parsed);
  } catch {
    fail("MARKDOWN_WORKSET_PREPROCESSED_DRIFT");
  }
  if (canonical !== markdown || headers.mengshu_source_ref !== descriptor.node.sourceRef ||
      headers.mengshu_source_hash !== descriptor.node.sourceHash ||
      headers.mengshu_node_sha256 !== preprocessedNodeSha256(descriptor.node)) {
    fail("MARKDOWN_WORKSET_PREPROCESSED_DRIFT");
  }
  return Object.freeze({
    schema: MARKDOWN_WORKSET_PREPROCESSED_SCHEMA,
    ...parsed,
    nodeSha256: headers.mengshu_node_sha256!,
  });
}
