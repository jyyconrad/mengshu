import type { CommanderLike } from "./cli.js";
import type {
  AgentHistoryProvider,
  DryRunReport,
  SourceAdapter,
  SourceAdapterContext,
  SourceMappingRow,
} from "../../ingest/agent-history/types.js";
import { emptyCandidateEstimates } from "../../ingest/agent-history/types.js";
import {
  claudeCodeSourceAdapter,
  codexSourceAdapter,
  openClawSourceAdapter,
} from "../sources/index.js";

export interface IngestHistoryCliDeps {
  adapters?: SourceAdapter[];
  cwd?: () => string;
}

interface IngestHistoryOptions {
  from?: string;
  since?: string;
  sourceRoot?: string;
  dryRun?: boolean;
  apply?: boolean;
  maxFiles?: string;
}

const DEFAULT_ADAPTERS = [
  codexSourceAdapter,
  claudeCodeSourceAdapter,
  openClawSourceAdapter,
];

export function registerIngestHistoryCommand(
  project: CommanderLike,
  deps: IngestHistoryCliDeps = {},
): void {
  project
    .command("ingest-history")
    .description("Preview agent history import from Codex / Claude Code / OpenClaw")
    .option("--from <providers>", "Comma-separated providers: codex,claude-code,openclaw", "codex")
    .option("--since <window>", "Only include events after window, e.g. 30d or 12h")
    .option("--source-root <path>", "Override source root path for selected providers")
    .option("--dry-run", "Preview only; do not write data", true)
    .option("--apply", "Apply import (not supported yet)", false)
    .option("--max-files <n>", "Maximum files per provider")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as IngestHistoryOptions;
      if (options.apply) {
        console.log("ms project ingest-history: --apply 尚未支持；当前阶段只支持 --dry-run。");
        return;
      }

      const providers = parseProviders(options.from);
      const report = await buildHistoryDryRunReport({
        providers,
        adapters: deps.adapters ?? DEFAULT_ADAPTERS,
        ctx: {
          sourceRoot: options.sourceRoot,
          sinceMs: parseSince(options.since),
          maxFiles: options.maxFiles ? Number.parseInt(options.maxFiles, 10) : undefined,
        },
      });
      printDryRunReport(report);
    });
}

export async function buildHistoryDryRunReport(input: {
  providers: AgentHistoryProvider[];
  adapters: SourceAdapter[];
  ctx: SourceAdapterContext;
}): Promise<DryRunReport> {
  const adaptersByProvider = new Map(input.adapters.map((adapter) => [adapter.provider, adapter]));
  const candidateEstimates = emptyCandidateEstimates();
  const sources: SourceMappingRow[] = [];
  const parseErrors: DryRunReport["parseErrors"] = [];
  let sourceFiles = 0;
  let sessionsMatched = 0;
  let redactedHits = 0;
  let estimatedChunks = 0;

  for (const provider of input.providers) {
    const adapter = adaptersByProvider.get(provider);
    if (!adapter) {
      parseErrors.push({ sourcePath: String(provider), error: `unknown provider: ${provider}` });
      continue;
    }
    const discovered = await adapter.discover(input.ctx);
    sourceFiles += discovered.files.length;
    if (!discovered.rootExists) {
      sources.push({
        source: discovered.resolvedRoot ?? String(provider),
        provider,
        sessions: 0,
        matchReason: "unmatched",
        confidence: 0,
        action: "skip",
      });
      continue;
    }

    for (const file of discovered.files) {
      const parsed = await adapter.parseFile(file, input.ctx);
      if (parsed.error) {
        parseErrors.push({ sourcePath: file, error: parsed.error });
      }
      if (parsed.badLines > 0) {
        parseErrors.push({ sourcePath: file, error: `${parsed.badLines} bad JSONL lines skipped` });
      }
      const sessionIds = new Set(parsed.events.map((event) => event.sessionId ?? event.sourceHash));
      sessionsMatched += sessionIds.size;
      redactedHits += parsed.events.reduce((sum, event) => sum + (event.redactedCount ?? 0), 0);
      estimatedChunks += estimateChunks(parsed.events.map((event) => event.text).join("\n\n"));
      for (const event of parsed.events) {
        incrementEstimate(candidateEstimates, event.text);
      }
      sources.push({
        source: file,
        provider,
        sessions: sessionIds.size,
        matchedProjectId: inferProjectId(parsed.events),
        matchReason: inferProjectId(parsed.events) ? "cwd_prefix" : "unmatched",
        confidence: inferProjectId(parsed.events) ? 0.75 : 0,
        action: inferProjectId(parsed.events) ? "import" : "skip",
      });
    }
  }

  return {
    providers: input.providers,
    sourceFiles,
    sessionsMatched,
    sessionsSkipped: sources.filter((source) => source.action === "skip").length,
    estimatedChunks,
    requiresConfirmation: sources.filter((source) => source.action === "needs-confirmation").length,
    candidateEstimates,
    sources,
    redactedHits,
    parseErrors,
  };
}

function printDryRunReport(report: DryRunReport): void {
  console.log("Agent history dry-run");
  console.log(`- providers: ${report.providers.join(", ")}`);
  console.log(`- source files: ${report.sourceFiles}`);
  console.log(`- sessions matched: ${report.sessionsMatched}`);
  console.log(`- sessions skipped: ${report.sessionsSkipped}`);
  console.log(`- estimated chunks: ${report.estimatedChunks}`);
  console.log(`- redacted hits: ${report.redactedHits}`);
  console.log("- candidate estimates:");
  for (const [type, count] of Object.entries(report.candidateEstimates)) {
    console.log(`  - ${type}: ${count}`);
  }
  if (report.sources.length > 0) {
    console.log("- sources:");
    for (const source of report.sources) {
      console.log(
        `  - ${source.provider}: ${source.source} sessions=${source.sessions} action=${source.action} confidence=${source.confidence}`,
      );
    }
  }
  if (report.parseErrors.length > 0) {
    console.log("- parse errors:");
    for (const error of report.parseErrors) {
      console.log(`  - ${error.sourcePath}: ${error.error}`);
    }
  }
}

function parseProviders(input: string | undefined): AgentHistoryProvider[] {
  return (input ?? "codex")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is AgentHistoryProvider => item.length > 0);
}

function parseSince(input: string | undefined): number | undefined {
  if (!input) {
    return undefined;
  }
  const match = input.match(/^(\d+)([dhm])$/i);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "d"
    ? 24 * 60 * 60 * 1000
    : unit === "h"
      ? 60 * 60 * 1000
      : 60 * 1000;
  return Date.now() - value * multiplier;
}

function estimateChunks(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 2000));
}

function incrementEstimate(
  estimates: ReturnType<typeof emptyCandidateEstimates>,
  text: string,
): void {
  const lower = text.toLowerCase();
  if (/prefer|always|never|喜欢|偏好/.test(lower)) {
    estimates.profile += 1;
  } else if (/must|禁止|必须|rule|规则/.test(lower)) {
    estimates.rules += 1;
  } else if (/http|file:|\/[\w.-]+|资源|文档/.test(lower)) {
    estimates.resource += 1;
  } else if (/because|原因|踩坑|decided|决定/.test(lower)) {
    estimates.experience += 1;
  } else {
    estimates.task_context += 1;
  }
}

function inferProjectId(events: Array<{ cwd?: string; projectRootHint?: string }>): string | undefined {
  const hint = events.find((event) => event.cwd || event.projectRootHint);
  const value = hint?.cwd ?? hint?.projectRootHint;
  if (!value) {
    return undefined;
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1);
}
