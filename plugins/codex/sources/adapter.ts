import { join } from "node:path";
import { homedir } from "node:os";
import type {
  SourceAdapter,
  SourceAdapterContext,
  SourceFileParseResult,
  DiscoverResult,
} from "../../../ingest/agent-history/types.js";
import {
  discoverJsonlSources,
  parseJsonlFile,
  type JsonlSourceOptions,
} from "../jsonl-parser.js";

const OPTIONS: JsonlSourceOptions = {
  provider: "codex",
  parserVersion: "codex-jsonl-v1",
  defaultRoot: join(homedir(), ".codex"),
  patterns: ["sessions/**/*.jsonl"],
  sourceKind: "session",
};

export const codexSourceAdapter: SourceAdapter = {
  provider: "codex",
  parserVersion: OPTIONS.parserVersion,
  discover: (ctx: SourceAdapterContext): Promise<DiscoverResult> =>
    discoverJsonlSources(OPTIONS, ctx),
  parseFile: (filePath: string, ctx: SourceAdapterContext): Promise<SourceFileParseResult> =>
    parseJsonlFile(filePath, OPTIONS, ctx),
};

export async function* parseCodexSessions(
  rootPath?: string,
  ctx: Omit<SourceAdapterContext, "sourceRoot"> = {},
) {
  const context = { ...ctx, sourceRoot: rootPath };
  const discovered = await codexSourceAdapter.discover(context);
  for (const file of discovered.files) {
    const result = await codexSourceAdapter.parseFile(file, context);
    for (const event of result.events) {
      yield event;
    }
  }
}
