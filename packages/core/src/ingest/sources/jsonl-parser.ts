import { createHash } from "node:crypto";
import fs from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { glob } from "glob";
import type {
  AgentHistoryEvent,
  AgentHistoryProvider,
  AgentHistoryRole,
  AgentHistorySourceKind,
  DiscoverResult,
  SourceAdapterContext,
  SourceFileParseResult,
} from "../../ingest/agent-history/types.js";
import { redactSecrets } from "../../ingest/agent-history/redaction.js";

export interface JsonlSourceOptions {
  provider: AgentHistoryProvider;
  parserVersion: string;
  defaultRoot: string;
  patterns: string[];
  sourceKind?: AgentHistorySourceKind;
  projectHintFromPath?: (filePath: string) => string | undefined;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function discoverJsonlSources(
  options: JsonlSourceOptions,
  ctx: SourceAdapterContext,
): Promise<DiscoverResult> {
  const root = ctx.sourceRoot ?? options.defaultRoot;
  if (!fs.existsSync(root)) {
    return {
      provider: options.provider,
      resolvedRoot: root,
      rootExists: false,
      files: [],
      note: `source root not found: ${root}`,
    };
  }

  const files = (
    await Promise.all(options.patterns.map((pattern) =>
      glob(pattern, {
        cwd: root,
        absolute: true,
        nodir: true,
      })
    ))
  ).flat().sort();

  return {
    provider: options.provider,
    resolvedRoot: root,
    rootExists: true,
    files: typeof ctx.maxFiles === "number" ? files.slice(0, ctx.maxFiles) : files,
  };
}

export async function parseJsonlFile(
  filePath: string,
  options: JsonlSourceOptions,
  ctx: SourceAdapterContext,
): Promise<SourceFileParseResult> {
  try {
    const sourceHash = await hashFile(filePath);
    const events: AgentHistoryEvent[] = [];
    let badLines = 0;
    let lineNo = 0;
    const rl = createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

    for await (const line of rl) {
      lineNo += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let value: Record<string, unknown>;
      try {
        value = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        badLines += 1;
        continue;
      }

      const text = extractText(value);
      if (!text || text.trim().length < 3) {
        continue;
      }
      const timestamp = extractTimestamp(value);
      if (ctx.sinceMs !== undefined && timestamp !== undefined && timestamp < ctx.sinceMs) {
        continue;
      }

      const redacted = redactSecrets(text.trim());
      const sessionId = asString(value.sessionId) ??
        asString(value.session_id) ??
        asString(value.conversationId) ??
        basename(filePath, ".jsonl");
      const threadId = asString(value.threadId) ??
        asString(value.thread_id) ??
        asString(value.conversationId) ??
        asString(value.conversation_id);
      const cwd = asString(value.cwd) ?? asString(value.workdir) ?? asString(value.workingDirectory);
      const projectRootHint = asString(value.projectRoot) ??
        asString(value.project_root) ??
        asString(value.workspacePath) ??
        options.projectHintFromPath?.(filePath);
      const metadata = {
        parserVersion: options.parserVersion,
        lineNo,
        eventType: asString(value.eventType) ?? asString(value.type),
        toolName: asString(value.toolName) ?? asString(value.tool_name) ?? asString(value.name),
        redactionCategories: redacted.categories,
      };

      events.push({
        id: `${options.provider}:${sourceHash.slice(0, 16)}:${lineNo}:${sha256(redacted.text).slice(0, 12)}`,
        provider: options.provider,
        sourceKind: options.sourceKind ?? "session",
        sourcePath: filePath,
        sourceHash,
        sessionId,
        threadId,
        cwd,
        projectRootHint,
        timestamp,
        role: normalizeRole(value.role ?? value.type),
        text: redacted.text,
        redactedCount: redacted.redactedCount,
        metadata,
      });
    }

    return { sourcePath: filePath, sourceHash, events, badLines };
  } catch (error) {
    return {
      sourcePath: filePath,
      sourceHash: sha256(filePath),
      events: [],
      badLines: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractText(value: Record<string, unknown>): string | undefined {
  const direct = asString(value.text) ?? asString(value.message);
  if (direct) {
    return direct;
  }
  const content = value.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return asString(record.text) ?? asString(record.content);
        }
        return undefined;
      })
      .filter((item): item is string => Boolean(item))
      .join(" ");
  }
  if (value.message && typeof value.message === "object") {
    return extractText(value.message as Record<string, unknown>);
  }
  return undefined;
}

function extractTimestamp(value: Record<string, unknown>): number | undefined {
  const raw = value.timestamp ?? value.createdAt ?? value.created_at ?? value.time;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 10_000_000_000 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function normalizeRole(value: unknown): AgentHistoryRole | undefined {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") {
    return value;
  }
  if (value === "tool_use" || value === "tool_result") {
    return "tool";
  }
  return undefined;
}
