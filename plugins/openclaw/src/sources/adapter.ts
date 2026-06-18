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
  provider: "openclaw",
  parserVersion: "openclaw-jsonl-v1",
  defaultRoot: join(homedir(), ".openclaw"),
  patterns: ["**/*.jsonl"],
  sourceKind: "session",
};

export const openClawSourceAdapter: SourceAdapter = {
  provider: "openclaw",
  parserVersion: OPTIONS.parserVersion,
  discover: (ctx: SourceAdapterContext): Promise<DiscoverResult> =>
    discoverJsonlSources(OPTIONS, ctx),
  parseFile: (filePath: string, ctx: SourceAdapterContext): Promise<SourceFileParseResult> =>
    parseJsonlFile(filePath, OPTIONS, ctx),
};
