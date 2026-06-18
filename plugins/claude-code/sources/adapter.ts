import { join, sep } from "node:path";
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
  provider: "claude-code",
  parserVersion: "claude-code-jsonl-v1",
  defaultRoot: join(homedir(), ".claude"),
  patterns: ["projects/**/*.jsonl"],
  sourceKind: "session",
  projectHintFromPath: (filePath) => {
    const marker = `${sep}projects${sep}`;
    const index = filePath.indexOf(marker);
    if (index < 0) {
      return undefined;
    }
    return filePath.slice(index + marker.length).split(sep)[0]?.replace(/-/g, sep);
  },
};

export const claudeCodeSourceAdapter: SourceAdapter = {
  provider: "claude-code",
  parserVersion: OPTIONS.parserVersion,
  discover: (ctx: SourceAdapterContext): Promise<DiscoverResult> =>
    discoverJsonlSources(OPTIONS, ctx),
  parseFile: (filePath: string, ctx: SourceAdapterContext): Promise<SourceFileParseResult> =>
    parseJsonlFile(filePath, OPTIONS, ctx),
};

export async function* parseClaudeCodeSessions(
  rootPath?: string,
  ctx: Omit<SourceAdapterContext, "sourceRoot"> = {},
) {
  const context = { ...ctx, sourceRoot: rootPath };
  const discovered = await claudeCodeSourceAdapter.discover(context);
  for (const file of discovered.files) {
    const result = await claudeCodeSourceAdapter.parseFile(file, context);
    for (const event of result.events) {
      yield event;
    }
  }
}
