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
} from "../../../config.js";
import type { DataType } from "../../../db/types.js";
import type { MemoryService } from "../../../core/service-types.js";
import type { MemoryRecord, MemoryScope } from "../../../core/types.js";
import {
  AuthorityScopeError,
  type AuthorityScope,
} from "../../../packages/core/src/domain/authority-scope.js";
import type { AgentFastPathService } from
  "../../../packages/api/src/agent-fast-path/index.js";
import type { MemoryWriteCommandExecutor } from "./memory-write.js";
import { computeContentHash } from "../../../processing/hash-utils.js";
import { looksLikePromptInjection } from "../../../retrieval/prompt-safety.js";
import {
  resolveOpenClawAuthorityScope,
  resolveOpenClawHostScope,
} from "./authority.js";

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

export interface OpenClawAgentHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

export interface OpenClawRecallTurnGuard {
  claim(prompt: string, context?: OpenClawAgentHookContext): boolean;
  clear(context?: OpenClawAgentHookContext): void;
}

export interface AutoRecallContext {
  agentFastPath: Pick<AgentFastPathService, "context">;
  authority: AuthorityScope;
  defaultScope: MemoryScope;
  hostContext?: OpenClawAgentHookContext;
  turnGuard?: OpenClawRecallTurnGuard;
  recallIncludeDocuments?: boolean;
  logger?: HookLogger;
}

export interface AutoCaptureContext {
  service: MemoryService;
  authority: AuthorityScope;
  defaultScope: MemoryScope;
  hostContext?: OpenClawAgentHookContext;
  memoryWrite?: MemoryWriteCommandExecutor;
  /** @deprecated Explicit test-only compatibility path. */
  unsafeLegacyWrite?: true;
  embedBatch?(texts: string[]): Promise<number[][]>;
  existsByContentHash?(contentHashes: string[]): Promise<string[]>;
  shouldCapture?: (text: string, options?: { maxChars?: number }) => boolean;
  detectCategory?: (text: string) => MemoryCategory;
  captureMaxChars?: number;
  embeddingModel?: string;
  idFactory?: () => string;
  now?: () => number;
  logger?: HookLogger;
  enqueueGraphExtraction?: (chunkId: string, text: string, scope: import("../../../core/types.js").MemoryScope) => Promise<void>;
}

interface RecallTurnGuardEntry {
  readonly agentId: string;
  readonly session: string;
  readonly expiresAt: number;
}

const DEFAULT_RECALL_TURN_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_RECALL_TURN_MAX_ENTRIES = 512;

function hookCoordinates(context?: OpenClawAgentHookContext): {
  agentId: string;
  session: string;
} {
  return {
    agentId: typeof context?.agentId === "string" ? context.agentId : "",
    session: typeof context?.sessionId === "string"
      ? context.sessionId
      : typeof context?.sessionKey === "string"
        ? context.sessionKey
        : "",
  };
}

export function createOpenClawRecallTurnGuard(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): OpenClawRecallTurnGuard {
  const ttlMs = options.ttlMs ?? DEFAULT_RECALL_TURN_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_RECALL_TURN_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("OpenClaw recall turn guard requires positive integer limits");
  }
  const entries = new Map<string, RecallTurnGuardEntry>();

  const pruneExpired = (timestamp: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  };

  return {
    claim(prompt, context) {
      const timestamp = now();
      pruneExpired(timestamp);
      const coordinates = hookCoordinates(context);
      const key = JSON.stringify([
        coordinates.agentId,
        coordinates.session,
        computeContentHash(prompt),
      ]);
      if (entries.has(key)) return false;
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(key, { ...coordinates, expiresAt: timestamp + ttlMs });
      return true;
    },
    clear(context) {
      const coordinates = hookCoordinates(context);
      for (const [key, entry] of entries) {
        if (entry.agentId === coordinates.agentId && entry.session === coordinates.session) {
          entries.delete(key);
        }
      }
    },
  };
}

function resolveHookBoundary(
  authority: AuthorityScope,
  defaultScope: MemoryScope,
  event: BeforeAgentStartEvent | AgentEndEvent,
  hostContext?: OpenClawAgentHookContext,
): { authority: AuthorityScope; scope: MemoryScope } {
  const hostBoundary = resolveOpenClawHostScope(authority, defaultScope, hostContext);
  const eventScope = resolveOpenClawAuthorityScope(
    hostBoundary.authority,
    hostBoundary.scope,
    event,
  );
  if (hostContext?.agentId !== undefined && eventScope.agentId !== hostBoundary.scope.agentId) {
    throw new AuthorityScopeError(
      "CLIENT_VALUE_AMBIGUOUS",
      "OpenClaw hook event agentId conflicts with trusted host agentId",
      "agentId",
    );
  }
  return {
    authority: hostBoundary.authority,
    scope: eventScope,
  };
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
  const { scope } = resolveHookBoundary(
    context.authority,
    context.defaultScope,
    event,
    context.hostContext,
  );
  if (context.turnGuard && !context.turnGuard.claim(event.prompt, context.hostContext)) {
    return undefined;
  }

  try {
    const result = await context.agentFastPath.context({
      scope,
      task: event.prompt,
    });
    if (result.telemetry.nodesUsed === 0) {
      return undefined;
    }

    context.logger?.info?.(`mengshu: injecting ${result.telemetry.nodesUsed} memories into context`);
    return {
      prependContext: result.content,
    };
  } catch {
    context.logger?.warn("mengshu: recall failed [RECALL_FAILED]");
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
  // Resolve before capture/embedding. Authority violations are not swallowed by
  // the legacy capture error handler and therefore fail the host event closed.
  const { authority, scope } = resolveHookBoundary(
    context.authority,
    context.defaultScope,
    event,
    context.hostContext,
  );

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

    if (context.unsafeLegacyWrite !== true) {
      if (!context.memoryWrite) {
        throw new Error("OpenClaw memory write capability is unavailable");
      }
      const eventKey = typeof event.messageId === "string" && event.messageId.trim().length > 0
        ? event.messageId
        : randomUUID();
      const hostSessionId = context.hostContext?.sessionId;
      const hostAgentId = context.hostContext?.agentId;
      for (const [index, text] of toCapture.entries()) {
        const category = detectCategoryFn(text);
        await context.memoryWrite.executeMemoryWrite({
          type: "observeAuto",
          intent: "auto",
          idempotencyKey: `openclaw-capture:${eventKey}:${index}`,
          serverAuthority: authority,
          clientScope: scope,
          text,
          kind: category === "core" || category === "other"
            ? "other"
            : category,
          category,
          dataType: "memory",
          tableName: "memories",
          metadata: {
            source: "user",
            sessionId: hostSessionId ?? event.sessionId,
            conversationId: event.conversationId,
            messageId: event.messageId,
            projectPath: event.projectPath,
            workspacePath: event.workspacePath,
            agentId: hostAgentId ?? event.agentId,
            agentName: event.agentName,
            groupId: event.groupId,
            groupName: event.groupName,
            userName: event.userName,
            userEmail: event.userEmail,
          },
          provenance: {
            source: "user",
            sessionId: hostSessionId ??
              (typeof event.sessionId === "string" ? event.sessionId : undefined),
            conversationId: typeof event.conversationId === "string"
              ? event.conversationId
              : undefined,
            messageId: typeof event.messageId === "string" ? event.messageId : undefined,
          },
        });
      }
      context.logger?.info?.(`mengshu: auto-captured ${toCapture.length} new memories`);
      return;
    }

    // Legacy-only request-local dedupe. Production dedupe belongs to the Kernel.
    const seenHashes = new Set<string>();
    const newEntries = toCapture.flatMap((text) => {
      const contentHash = computeContentHash(text);
      if (seenHashes.has(contentHash)) return [];
      seenHashes.add(contentHash);
      return [{
        text,
        contentHash,
        category: detectCategoryFn(text),
        importance: 0.7,
      }];
    });

    if (newEntries.length === 0) {
      return;
    }

    if (!context.embedBatch) {
      throw new Error("OpenClaw legacy embedding capability is unavailable");
    }
    const vectors = await context.embedBatch(newEntries.map((entry) => entry.text));
    const now = context.now ?? Date.now;
    for (const [index, entry] of newEntries.entries()) {
      const enrichedMetadata: Record<string, unknown> = {
        source: "user" as const,
        createdAt: now(),
        updatedAt: now(),
        embeddingModel: context.embeddingModel,
        sessionId: context.hostContext?.sessionId ?? event.sessionId as string | undefined,
        conversationId: event.conversationId as string | undefined,
        messageId: event.messageId as string | undefined,
        projectPath: event.projectPath as string | undefined,
        workspacePath: event.workspacePath as string | undefined,
        agentId: context.hostContext?.agentId ?? event.agentId as string | undefined,
        agentName: event.agentName as string | undefined,
        groupId: event.groupId as string | undefined,
        groupName: event.groupName as string | undefined,
        userName: event.userName as string | undefined,
        userEmail: event.userEmail as string | undefined,
      };

      const id = context.idFactory?.() ?? randomUUID();
      const record: MemoryRecord = {
        id,
        scope,
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
      const outcome = await context.service.storeMemory({ record });
      if (outcome.stored && context.enqueueGraphExtraction) {
        await context.enqueueGraphExtraction(outcome.id, entry.text, record.scope).catch(() => {
          // 图谱提取入队失败不影响记忆写入
        });
      }
    }

    context.logger?.info?.(`mengshu: auto-captured ${newEntries.length} new memories`);
  } catch {
    context.logger?.warn("mengshu: capture failed [CAPTURE_FAILED]");
  }
}
