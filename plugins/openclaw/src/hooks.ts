/**
 * OpenClaw lifecycle hook handlers.
 *
 * 这些 handler 把 auto-recall/auto-capture 接入 `MemoryService`，避免生命周期
 * 钩子继续直接访问旧 `DatabaseProvider`。捕获规则由 index 注入，防止循环依赖。
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_CAPTURE_MAX_CHARS,
  type MemoryCategory,
} from "../../config.js";
import type { DataType } from "../../db/types.js";
import type { MemoryService } from "../../core/service-types.js";
import type { MemoryRecord } from "../../core/types.js";
import { computeContentHash } from "../../processing/hash-utils.js";
import {
  formatRelevantMemoriesContext,
  looksLikePromptInjection,
} from "../../retrieval/prompt-safety.js";
import { buildOpenClawScope } from "./scope.js";

export interface HookLogger {
  info?(message: string): void;
  warn(message: string): void;
}

export interface BeforeAgentStartEvent extends Record<string, unknown> {
  prompt?: string;
}

export interface AgentEndEvent extends Record<string, unknown> {
  success?: boolean;
  messages?: unknown[];
}

export interface AutoRecallContext {
  service: MemoryService;
  recallIncludeDocuments?: boolean;
  logger?: HookLogger;
}

export interface AutoCaptureContext {
  service: MemoryService;
  embedBatch(texts: string[]): Promise<number[][]>;
  existsByContentHash(contentHashes: string[]): Promise<string[]>;
  shouldCapture?: (text: string, options?: { maxChars?: number }) => boolean;
  detectCategory?: (text: string) => MemoryCategory;
  captureMaxChars?: number;
  embeddingModel?: string;
  idFactory?: () => string;
  now?: () => number;
  logger?: HookLogger;
  enqueueGraphExtraction?: (chunkId: string, text: string, scope: import("../../core/types.js").MemoryScope) => Promise<void>;
}

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
];

export function shouldCapture(text: string, options?: { maxChars?: number }): boolean {
  const maxChars = options?.maxChars ?? DEFAULT_CAPTURE_MAX_CHARS;
  if (text.length < 10 || text.length > maxChars) {
    return false;
  }
  if (text.includes("<relevant-memories>")) {
    return false;
  }
  if (text.startsWith("<") && text.includes("</")) {
    return false;
  }
  if (text.includes("**") && text.includes("\n-")) {
    return false;
  }
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  if (looksLikePromptInjection(text)) {
    return false;
  }
  return MEMORY_TRIGGERS.some((pattern) => pattern.test(text));
}

export function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want/i.test(lower)) {
    return "preference";
  }
  if (/rozhodli|decided|will use|budeme/i.test(lower)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) {
    return "entity";
  }
  if (/is|are|has|have|je|má|jsou/i.test(lower)) {
    return "fact";
  }
  return "other";
}

export function extractUserMessageTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") {
      continue;
    }
    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }
  return texts;
}

export async function handleBeforeAgentStartRecall(
  event: BeforeAgentStartEvent,
  context: AutoRecallContext,
): Promise<{ prependContext: string } | undefined> {
  if (!event.prompt || event.prompt.length < 5) {
    return undefined;
  }

  try {
    const result = await context.service.recall({
      query: event.prompt,
      limit: 3,
      minScore: 0.3,
      dataTypes: context.recallIncludeDocuments ? ["memory", "document"] : ["memory"],
    });

    const memoryHits = result.hits.filter((hit) => "text" in hit.record && "category" in hit.record);
    if (memoryHits.length === 0) {
      return undefined;
    }

    context.logger?.info?.(`mengshu: injecting ${memoryHits.length} memories into context`);
    return {
      prependContext: formatRelevantMemoriesContext(
        memoryHits.map((hit) => {
          const record = hit.record as MemoryRecord;
          return {
            category: record.category,
            text: record.text,
            dataType: record.dataType,
            metadata: record.metadata,
          };
        }),
      ),
    };
  } catch (err) {
    context.logger?.warn(`mengshu: recall failed: ${String(err)}`);
    return undefined;
  }
}

export async function handleAgentEndCapture(
  event: AgentEndEvent,
  context: AutoCaptureContext,
): Promise<void> {
  if (!event.success || !event.messages || event.messages.length === 0) {
    return;
  }

  try {
    const shouldCaptureFn = context.shouldCapture ?? shouldCapture;
    const detectCategoryFn = context.detectCategory ?? detectCategory;
    const texts = extractUserMessageTexts(event.messages);
    const toCapture = texts.filter(
      (text) => text && shouldCaptureFn(text, { maxChars: context.captureMaxChars }),
    );
    if (toCapture.length === 0) {
      return;
    }

    const hashes = toCapture.map((text) => computeContentHash(text));
    const existingHashes = await context.existsByContentHash(hashes);
    const existingSet = new Set(existingHashes);
    const newEntries = toCapture
      .filter((_, index) => !existingSet.has(hashes[index]))
      .map((text, index) => ({
        text,
        contentHash: hashes[index],
        category: detectCategoryFn(text),
        importance: 0.7,
      }));

    if (newEntries.length === 0) {
      return;
    }

    const vectors = await context.embedBatch(newEntries.map((entry) => entry.text));
    const now = context.now ?? Date.now;
    for (const [index, entry] of newEntries.entries()) {
      const enrichedMetadata: Record<string, unknown> = {
        source: "user" as const,
        createdAt: now(),
        updatedAt: now(),
        embeddingModel: context.embeddingModel,
        sessionId: event.sessionId as string | undefined,
        conversationId: event.conversationId as string | undefined,
        messageId: event.messageId as string | undefined,
        userId: event.userId as string | undefined,
        projectPath: event.projectPath as string | undefined,
        workspacePath: event.workspacePath as string | undefined,
        agentId: event.agentId as string | undefined,
        agentName: event.agentName as string | undefined,
        groupId: event.groupId as string | undefined,
        groupName: event.groupName as string | undefined,
        userName: event.userName as string | undefined,
        userEmail: event.userEmail as string | undefined,
      };

      const id = context.idFactory?.() ?? randomUUID();
      const record: MemoryRecord = {
        id,
        scope: buildOpenClawScope({ ...enrichedMetadata, tableName: "memories" }),
        kind: entry.category === "core" || entry.category === "other" ? "other" : entry.category,
        text: entry.text,
        contentHash: entry.contentHash,
        vector: vectors[index],
        importance: entry.importance,
        category: entry.category,
        dataType: "memory" as DataType,
        tableName: "memories",
        metadata: enrichedMetadata,
        provenance: {
          source: "user",
          sessionId: typeof enrichedMetadata.sessionId === "string" ? enrichedMetadata.sessionId : undefined,
          conversationId: typeof enrichedMetadata.conversationId === "string" ? enrichedMetadata.conversationId : undefined,
          messageId: typeof enrichedMetadata.messageId === "string" ? enrichedMetadata.messageId : undefined,
          createdAt: now(),
        },
        createdAt: now(),
        updatedAt: now(),
      };
      await context.service.storeMemory({ record });
      if (context.enqueueGraphExtraction) {
        await context.enqueueGraphExtraction(record.id, entry.text, record.scope).catch(() => {
          // 图谱提取入队失败不影响记忆写入
        });
      }
    }

    context.logger?.info?.(`mengshu: auto-captured ${newEntries.length} new memories`);
  } catch (err) {
    context.logger?.warn(`mengshu: capture failed: ${String(err)}`);
  }
}
