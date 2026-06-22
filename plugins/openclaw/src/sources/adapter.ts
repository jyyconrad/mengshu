import { join } from "node:path";
import { homedir } from "node:os";
import type {
  SourceAdapter,
  SourceAdapterContext,
  SourceFileParseResult,
  DiscoverResult,
} from "../../../../ingest/agent-history/types.js";
import {
  discoverJsonlSources,
  parseJsonlFile,
  type JsonlSourceOptions,
} from "../../../../packages/core/src/ingest/sources/jsonl-parser.js";

/**
 * 从 OpenClaw session 文件路径推断 project hint。
 *
 * OpenClaw session 真实路径为 `~/.openclaw/agents/{agent}/sessions/{uuid}.jsonl`，
 * 其中 `cwd` 仅存在于每个文件首行的 `{"type":"session",...}` 头部，而该头部没有
 * 文本内容，会被 jsonl-parser 在 text 过滤阶段丢弃，导致没有任何 event 携带
 * cwd/projectRootHint。下游 `inferProjectId` 因此恒返回 undefined，使所有 session
 * 被标记为 action=skip。这里以路径中的 agent 名作为兜底 project hint，确保 session
 * 能被识别并导入。
 */
function openClawProjectHintFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const match = normalized.match(/\/agents\/([^/]+)\/sessions\//);
  return match?.[1];
}

const OPTIONS: JsonlSourceOptions = {
  provider: "openclaw",
  parserVersion: "openclaw-jsonl-v1",
  defaultRoot: join(homedir(), ".openclaw"),
  patterns: ["agents/*/sessions/*.jsonl"],
  sourceKind: "session",
  projectHintFromPath: openClawProjectHintFromPath,
};

export const openClawSourceAdapter: SourceAdapter = {
  provider: "openclaw",
  parserVersion: OPTIONS.parserVersion,
  discover: (ctx: SourceAdapterContext): Promise<DiscoverResult> =>
    discoverJsonlSources(OPTIONS, ctx),
  parseFile: (filePath: string, ctx: SourceAdapterContext): Promise<SourceFileParseResult> =>
    parseJsonlFile(filePath, OPTIONS, ctx),
};
