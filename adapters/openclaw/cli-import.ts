/**
 * ms import — 从 OpenClaw 会话 JSONL 导入历史记忆。
 *
 * 流程：
 *   JSONL → 解析 user/assistant 消息 → 文本切分 → embedBatch + storeMemory
 *        → enqueue extract_graph job
 *   增量：~/.mengshu/import-state.json 记录已处理文件，重启后断点续传
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { MemoryService } from "../../core/service-types.js";
import type { MemoryRecord } from "../../core/types.js";
import type { DataType } from "../../db/types.js";
import { computeContentHash } from "../../processing/hash-utils.js";
import type { JobRepository } from "../../storage/repositories/types.js";
import { enqueueExtractGraphJob } from "../../graph/extract-graph-handler.js";

interface ParsedMessage {
  role: "user" | "assistant";
  text: string;
  sessionId: string;
  timestamp?: string;
}

interface ImportState {
  [filePath: string]: {
    status: "done" | "in-progress";
    chunksProcessed: number;
    importedAt?: string;
  };
}

export interface ImportOptions {
  service: MemoryService;
  embedBatch(texts: string[]): Promise<number[][]>;
  jobs?: JobRepository;
  dryRun?: boolean;
  chunkSize?: number;
  concurrency?: number;
  now?: () => number;
  stateFilePath?: string;
}

export interface RegisterImportOptions {
  service: MemoryService;
  embedBatch(texts: string[]): Promise<number[][]>;
  jobs?: JobRepository;
}

export interface CommanderLike {
  command(name: string): CommanderLike;
  description(text: string): CommanderLike;
  option(flag: string, description: string, defaultValue?: unknown): CommanderLike;
  action(handler: (...args: unknown[]) => unknown): CommanderLike;
}

const DEFAULT_STATE_PATH = path.join(os.homedir(), ".mengshu", "import-state.json");

function readState(stateFilePath: string): ImportState {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, "utf8")) as ImportState;
  } catch {
    return {};
  }
}

function writeState(stateFilePath: string, state: ImportState): void {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf8");
}

export async function parseSessionJsonl(filePath: string): Promise<ParsedMessage[]> {
  const sessionId = path.basename(filePath, ".jsonl");
  const messages: ParsedMessage[] = [];
  const rl = createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const role = (obj.role ?? obj.type) as string | undefined;
      if (role !== "user" && role !== "assistant") continue;

      let text = "";
      if (typeof obj.content === "string") {
        text = obj.content;
      } else if (Array.isArray(obj.content)) {
        text = (obj.content as Array<Record<string, unknown>>)
          .filter((c) => c.type === "text")
          .map((c) => c.text as string)
          .join(" ");
      }

      if (text.trim().length < 10) continue;

      messages.push({
        role: role as "user" | "assistant",
        text: text.trim(),
        sessionId,
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
      });
    } catch {
      // 静默跳过解析失败的行
    }
  }

  return messages;
}

export function splitIntoChunks(messages: ParsedMessage[], chunkSize: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const msg of messages) {
    const line = `${msg.role.toUpperCase()}: ${msg.text}`;
    const candidate = current ? `${current}\n\n${line}` : line;
    if (current && candidate.length > chunkSize) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function importFile(
  filePath: string,
  options: ImportOptions,
): Promise<{ chunksProcessed: number; skipped: boolean }> {
  const stateFilePath = options.stateFilePath ?? DEFAULT_STATE_PATH;
  const state = readState(stateFilePath);

  if (state[filePath]?.status === "done") {
    return { chunksProcessed: 0, skipped: true };
  }

  const messages = await parseSessionJsonl(filePath);
  const chunkSize = options.chunkSize ?? 2000;
  const chunks = splitIntoChunks(messages, chunkSize);

  if (options.dryRun) {
    return { chunksProcessed: chunks.length, skipped: false };
  }

  const now = options.now ?? Date.now;
  const scope = {
    tenantId: "local",
    appId: "openclaw",
    userId: "default",
    projectId: "default",
    agentId: path.basename(filePath, ".jsonl"),
    namespace: "memories",
  };

  const BATCH_SIZE = 20;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await options.embedBatch(batch);

    for (let j = 0; j < batch.length; j++) {
      const text = batch[j];
      const id = randomUUID();
      const record: MemoryRecord = {
        id,
        scope,
        kind: "observation",
        text,
        contentHash: computeContentHash(text),
        vector: vectors[j],
        importance: 0.5,
        category: "other",
        dataType: "memory" as DataType,
        tableName: "memories",
        metadata: { source: "openclaw-import", filePath },
        provenance: { source: "user", sessionId: scope.agentId, createdAt: now() },
        createdAt: now(),
        updatedAt: now(),
      };

      await options.service.storeMemory({ record });

      if (options.jobs) {
        await enqueueExtractGraphJob(options.jobs, {
          chunkId: id,
          text,
          scope,
        }).catch(() => {});
      }
    }
  }

  state[filePath] = {
    status: "done",
    chunksProcessed: chunks.length,
    importedAt: new Date().toISOString(),
  };
  writeState(stateFilePath, state);

  return { chunksProcessed: chunks.length, skipped: false };
}

export function registerImportCliCommand(
  memory: CommanderLike,
  options: RegisterImportOptions,
): void {
  memory
    .command("import")
    .description("从 OpenClaw 会话 JSONL 文件导入历史记忆")
    .option("--file <path>", "指定单个 JSONL 文件路径")
    .option("--dry-run", "预览模式，不写入数据库")
    .option("--chunk-size <size>", "每个 chunk 的最大字符数", 2000)
    .action(async (...args: unknown[]) => {
      const opts = args[args.length - 2] as Record<string, unknown>;
      const filePath = opts["file"] as string | undefined;

      if (!filePath) {
        console.error("错误：请使用 --file <path> 指定 JSONL 文件");
        return;
      }

      const result = await importFile(filePath, {
        service: options.service,
        embedBatch: options.embedBatch,
        jobs: options.jobs,
        dryRun: Boolean(opts["dryRun"]),
        chunkSize: Number(opts["chunkSize"]) || 2000,
      });

      if (result.skipped) {
        console.log(`跳过（已导入）：${filePath}`);
      } else {
        console.log(`导入完成：${filePath}，共处理 ${result.chunksProcessed} 个 chunk`);
      }
    });
}
