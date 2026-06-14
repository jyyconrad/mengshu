#!/usr/bin/env node
/**
 * Standalone MCP stdio entry for memory-autodb.
 *
 * 用途：让 Codex、Claude Code、Claude Desktop 等本地 MCP 客户端绕过 OpenClaw CLI
 * 的插件加载链路，直接启动当前仓库里的 memory-autodb 工具表。
 *
 * 注意：stdio MCP 的 stdout 只能输出 JSON-RPC，诊断信息必须写 stderr。
 */

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentFastPathService } from "../api/agent-fast-path.js";
import { memoryConfigSchema, type MemoryCategory, type MemoryConfig } from "../config.js";
import { DefaultMemoryService } from "../core/memory-service.js";
import type { MemoryService, StoreMemoryInput } from "../core/service-types.js";
import { normalizeScope } from "../core/scope.js";
import type { MemoryKind, MemoryRecord, MemoryScope, MemorySemanticType } from "../core/types.js";
import { DatabaseFactory } from "../db/factory.js";
import { Embeddings } from "../processing/embeddings.js";
import { computeContentHash } from "../processing/hash-utils.js";
import { LegacyDatabaseAdapter } from "../storage/legacy-database-adapter.js";
import { startMcpStdioServer } from "../adapters/mcp/stdio-server.js";
import { extractRecords } from "../adapters/openclaw/agent-service-helper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG_PATH = "~/.openclaw/memory-autodb-mcp.json";
const DEFAULT_OPENCLAW_PLUGIN_CONFIG_PATH = "~/.openclaw/conf/plugins.json";
const DEFAULT_ENV_PATH = "~/.openclaw/.env";

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveMaybeRelative(input: string, baseDir: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function loadDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function ensureLocalNoProxy(): void {
  const localHosts = ["127.0.0.1", "localhost", "::1"];
  const current = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const parts = new Set(
    current
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  for (const host of localHosts) {
    parts.add(host);
  }
  const value = Array.from(parts).join(",");
  process.env.NO_PROXY = value;
  process.env.no_proxy = value;
}

function readJson(pathname: string): unknown {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function readConfig(configPath: string): unknown {
  if (fs.existsSync(configPath)) {
    return readJson(configPath);
  }

  const pluginConfigPath = expandHome(DEFAULT_OPENCLAW_PLUGIN_CONFIG_PATH);
  if (!fs.existsSync(pluginConfigPath)) {
    throw new Error(`memory-autodb config not found: ${configPath}`);
  }

  const plugins = readJson(pluginConfigPath) as {
    entries?: Record<string, { enabled?: boolean; config?: unknown }>;
  };
  const entry = plugins.entries?.["memory-autodb"];
  if (!entry?.enabled || !entry.config) {
    throw new Error(`memory-autodb plugin config is disabled or missing: ${pluginConfigPath}`);
  }
  return entry.config;
}

function resolveDbPath(cfg: MemoryConfig, configPath: string): string {
  const dbPath = cfg.dbPath ?? "~/.openclaw/memory/autodb";
  const configDir = path.dirname(configPath);
  return resolveMaybeRelative(dbPath, configDir);
}

function resolveCategory(value: unknown): MemoryCategory {
  switch (value) {
    case "core":
    case "preference":
    case "fact":
    case "entity":
    case "decision":
    case "task":
    case "plan":
    case "goal":
    case "other":
      return value;
    default:
      return "core";
  }
}

function resolveKind(value: unknown, category: MemoryCategory): MemoryKind {
  if (
    value === "preference" ||
    value === "decision" ||
    value === "entity" ||
    value === "fact" ||
    value === "task" ||
    value === "plan" ||
    value === "goal" ||
    value === "document" ||
    value === "knowledge" ||
    value === "observation" ||
    value === "other"
  ) {
    return value;
  }
  return category === "core" ? "other" : category;
}

function resolveSemanticType(value: unknown): MemorySemanticType | undefined {
  if (
    value === "profile" ||
    value === "task_context" ||
    value === "rules" ||
    value === "experience" ||
    value === "resource"
  ) {
    return value;
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function normalizeStoreInput(
  input: StoreMemoryInput,
  deps: {
    embeddings: Embeddings;
    defaultScope: MemoryScope;
    embeddingModel?: string;
  },
): Promise<StoreMemoryInput> {
  const source = input.record as Partial<MemoryRecord> & {
    scope?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  if (typeof source.text !== "string" || source.text.trim().length === 0) {
    throw new Error("memory record.text is required");
  }

  const now = Date.now();
  const providedId = typeof source.id === "string" && source.id.trim().length > 0
    ? source.id.trim()
    : undefined;
  const metadata = {
    ...(source.metadata ?? {}),
    externalId: providedId && !isUuid(providedId) ? providedId : source.metadata?.externalId,
    source: source.metadata?.source ?? "mcp",
    updatedAt: source.updatedAt ?? now,
    embeddingModel: deps.embeddingModel,
  };
  const category = resolveCategory(source.category);
  const tableName = source.tableName ?? (source.dataType === "knowledge" ? "knowledge" : "memories");
  const dataType = source.dataType ?? (tableName === "knowledge" ? "knowledge" : "memory");
  const vector = Array.isArray(source.vector) && source.vector.length > 0
    ? source.vector
    : await deps.embeddings.embed(source.text);

  const record: MemoryRecord = {
    id: providedId && isUuid(providedId) ? providedId : randomUUID(),
    scope: normalizeScope(source.scope, deps.defaultScope),
    kind: resolveKind(source.kind, category),
    semanticType: resolveSemanticType(source.semanticType),
    container: source.container,
    lifecycleStatus: source.lifecycleStatus ?? "active",
    confidence: typeof source.confidence === "number" ? source.confidence : 1,
    text: source.text,
    contentHash: source.contentHash ?? computeContentHash(source.text),
    importance: typeof source.importance === "number" ? source.importance : 0.7,
    category,
    dataType,
    tableName,
    metadata,
    provenance: {
      ...(source.provenance ?? {}),
      source: source.provenance?.source ?? "mcp",
      sessionId: source.provenance?.sessionId ?? source.scope?.sessionId ?? deps.defaultScope.sessionId,
      createdAt: source.provenance?.createdAt ?? source.createdAt ?? now,
    },
    sourceNodeIds: source.sourceNodeIds,
    supersededBy: source.supersededBy,
    promotedToSkillId: source.promotedToSkillId,
    version: source.version,
    createdAt: source.createdAt ?? now,
    updatedAt: source.updatedAt ?? now,
    vector,
  };

  return { record };
}

function createMcpFriendlyMemoryService(
  service: MemoryService,
  deps: {
    embeddings: Embeddings;
    defaultScope: MemoryScope;
    embeddingModel?: string;
  },
): MemoryService {
  return {
    storeMemory: async (input) => service.storeMemory(await normalizeStoreInput(input, deps)),
    recall: (input) => service.recall(input),
    buildContext: (input) => service.buildContext(input),
    delete: (input) => service.delete(input),
    health: () => service.health(),
  };
}

function observationToRecord(input: {
  scope: MemoryScope;
  text: string;
  metadata: Record<string, unknown>;
}): MemoryRecord {
  const now = Date.now();
  const eventType = typeof input.metadata.eventType === "string" ? input.metadata.eventType : "observation";
  const traceId = typeof input.metadata.traceId === "string" ? input.metadata.traceId : undefined;

  return {
    id: traceId && isUuid(traceId) ? traceId : randomUUID(),
    scope: input.scope,
    kind: "observation",
    semanticType: "task_context",
    container: "session_candidate",
    lifecycleStatus: "active",
    confidence: input.metadata.intent === "remember" ? 0.9 : 0.6,
    text: input.text,
    contentHash: computeContentHash(input.text),
    importance: input.metadata.intent === "remember" ? 0.8 : 0.4,
    category: "core",
    dataType: "memory",
    tableName: "memories",
    metadata: {
      ...input.metadata,
      source: "mcp",
      eventType,
      updatedAt: now,
    },
    provenance: {
      source: "mcp",
      sessionId: input.scope.sessionId,
      createdAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function main(): Promise<void> {
  process.chdir(path.resolve(__dirname, ".."));

  ensureLocalNoProxy();
  const envPath = expandHome(process.env.MEMORY_AUTODB_ENV ?? DEFAULT_ENV_PATH);
  loadDotEnv(envPath);
  ensureLocalNoProxy();

  const configPath = expandHome(process.env.MEMORY_AUTODB_CONFIG ?? DEFAULT_CONFIG_PATH);
  const rawConfig = readConfig(configPath);
  const cfg = memoryConfigSchema.parse(rawConfig);
  const db = DatabaseFactory.createProvider(cfg, resolveDbPath(cfg, configPath));
  const embeddings = new Embeddings(cfg.embedding, cfg.batchProcessing);
  const repository = new LegacyDatabaseAdapter(db, { appId: "memory-autodb" });
  const durableService = new DefaultMemoryService({ repository, embeddings });

  const defaultScope: MemoryScope = {
    tenantId: "local",
    appId: "memory-autodb",
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: "working-context",
    visibility: "private",
  };
  const service = createMcpFriendlyMemoryService(durableService, {
    embeddings,
    defaultScope,
    embeddingModel: cfg.embedding.model,
  });

  const agentFastPath = new AgentFastPathService({
    defaultScope,
    loadRecordsForScope: async (scope) => {
      const result = await service.recall({
        query: "",
        scope,
        limit: 50,
        minScore: 0,
        searchAll: true,
      });
      return extractRecords(result.hits);
    },
    recall: async (scope, query, opts) =>
      service.recall({
        query,
        scope,
        limit: opts?.limit ?? 10,
        minScore: opts?.minScore ?? 0.1,
        searchAll: true,
      }),
    storeObservation: async ({ scope, text, metadata }) => {
      const resolvedScope = normalizeScope(scope, defaultScope);
      const record = observationToRecord({ scope: resolvedScope, text, metadata });
      await service.storeMemory({ record });
      return { id: record.id };
    },
    enqueueJob: async ({ type }) => `standalone-${type}-${Date.now()}`,
    logger: {
      warn: (message) => process.stderr.write(`[memory-autodb] ${message}\n`),
    },
  });

  process.stderr.write(`memory-autodb MCP started (${configPath})\n`);
  await startMcpStdioServer({
    service,
    agentFastPath,
    namespaces: ["memories", "knowledge"],
  });

  await new Promise<void>(() => {
    // MCP stdio server lives until the host process exits.
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`memory-autodb MCP failed: ${message}\n`);
  process.exit(1);
});
