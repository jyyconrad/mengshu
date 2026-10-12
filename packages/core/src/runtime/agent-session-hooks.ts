/**
 * Recommended session / compact / task-complete hooks for coding Agents.
 *
 * Real host bindings (do not invent APIs):
 * - OpenClaw: `before_prompt_build` | `before_agent_start` (recall),
 *   `agent_end` (capture). `registerMemoryFlushPlan` exists but mengshu keeps
 *   returning null until OpenClaw documents a stable flush-plan object shape.
 * - Codex / Claude Code / Cursor: no native PreCompact plugin hook in this
 *   repo's plugin packs — use MCP tools via the `mengshu` Skill at the
 *   recommended triggers below.
 */

import { createHash } from "node:crypto";

import type { MemorySemanticType } from "../domain/types.js";

export type AgentSessionHookTrigger =
  | "session_start"
  | "session_end"
  | "pre_compact"
  | "task_complete";

export type RecommendedMemoryAction =
  | "memory_context_fast"
  | "memory_recall"
  | "memory_observe"
  | "memory_save"
  | "memory_explain";

export interface AgentSessionHookRecommendation {
  readonly trigger: AgentSessionHookTrigger;
  readonly purpose: string;
  readonly actions: readonly RecommendedMemoryAction[];
  readonly notes: readonly string[];
  /** OpenClaw host event name when a real binding exists; otherwise null. */
  readonly openClawEvent: "before_prompt_build" | "agent_end" | null;
}

export type SessionHookKind = "recall" | "typed_capture";

export type SessionHookHost = "openclaw" | "codex" | "claude-code" | "cursor";

export type SessionHookBindingKind = "native" | "skill-only";

export interface SessionEvent {
  readonly trigger: AgentSessionHookTrigger;
  readonly runId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly user: string;
  readonly transcriptSummary?: string;
}

export type SessionEventSkipReason =
  | "missing_trigger"
  | "unknown_trigger"
  | "missing_runId"
  | "missing_sessionId"
  | "missing_projectId"
  | "missing_user"
  | "duplicate_session_hash";

export type ParseSessionEventResult =
  | { readonly ok: true; readonly event: SessionEvent }
  | {
      readonly ok: false;
      readonly skipped: true;
      readonly reason: Exclude<SessionEventSkipReason, "duplicate_session_hash">;
    };

export type SessionHookReady = {
  readonly status: "ready";
  readonly kind: SessionHookKind;
  readonly event: SessionEvent;
  readonly recommendation: AgentSessionHookRecommendation;
  readonly dedupKey: string;
};

export type SessionHookSkipped = {
  readonly status: "skipped";
  readonly skipped: true;
  readonly reason: Exclude<SessionEventSkipReason, "duplicate_session_hash">;
  readonly blocking: false;
};

export type SessionHookDuplicate = {
  readonly status: "duplicate";
  readonly skipped: true;
  readonly reason: "duplicate_session_hash";
  readonly blocking: false;
  readonly dedupKey: string;
};

export type SessionHookFailed = {
  readonly status: "failed";
  readonly kind: SessionHookKind;
  readonly event: SessionEvent;
  readonly reason: string;
  readonly blocking: false;
};

export type SessionHookOk = {
  readonly status: "ok";
  readonly kind: SessionHookKind;
  readonly event: SessionEvent;
  readonly recommendation: AgentSessionHookRecommendation;
  readonly dedupKey: string;
  readonly blocking: false;
};

export type SessionHookResolution =
  | SessionHookReady
  | SessionHookSkipped
  | SessionHookDuplicate;

export type SessionHookDispatchResult =
  | SessionHookOk
  | SessionHookSkipped
  | SessionHookDuplicate
  | SessionHookFailed;

export interface SessionHookHandlers {
  readonly recall?: (event: SessionEvent) => Promise<void> | void;
  readonly typedCapture?: (event: SessionEvent) => Promise<void> | void;
}

export interface SessionHookHostBinding {
  readonly host: SessionHookHost;
  readonly trigger: AgentSessionHookTrigger;
  readonly binding: SessionHookBindingKind;
  readonly nativeEvent: string | null;
  readonly flushPlan: null;
}

export const SESSION_HOOK_WRITE_DISCIPLINE = Object.freeze({
  dumpWholeTranscript: false,
  requireVerifiedSemanticType: true,
  allowedSemanticTypes: Object.freeze([
    "profile",
    "task_context",
    "rules",
    "experience",
    "resource",
  ] as const satisfies readonly MemorySemanticType[]),
  silentAdd: false,
  inventFlushPlan: false,
  blockTurnOnFailure: false,
});

const TRIGGERS = new Set<AgentSessionHookTrigger>([
  "session_start",
  "session_end",
  "pre_compact",
  "task_complete",
]);

const SKILL_ONLY_HOSTS = ["codex", "claude-code", "cursor"] as const satisfies readonly SessionHookHost[];
const TRIGGER_ORDER = [
  "session_start",
  "pre_compact",
  "task_complete",
  "session_end",
] as const satisfies readonly AgentSessionHookTrigger[];

const TABLE: Readonly<Record<AgentSessionHookTrigger, AgentSessionHookRecommendation>> =
  Object.freeze({
    session_start: Object.freeze({
      trigger: "session_start" as const,
      purpose: "Load 5-slot governed context before planning or editing.",
      actions: Object.freeze(["memory_context_fast", "memory_recall"] as const),
      notes: Object.freeze([
        "Prefer context_fast; deepen with recall only when a slot is empty but required.",
        "OpenClaw maps this to before_prompt_build / before_agent_start auto-recall.",
      ]),
      openClawEvent: "before_prompt_build" as const,
    }),
    session_end: Object.freeze({
      trigger: "session_end" as const,
      purpose: "Capture durable preferences / decisions before the session closes.",
      actions: Object.freeze(["memory_observe", "memory_save"] as const),
      notes: Object.freeze([
        "Only persist verified 5type facts; do not dump the whole transcript.",
        "OpenClaw maps this to agent_end auto-capture when enabled.",
      ]),
      openClawEvent: "agent_end" as const,
    }),
    pre_compact: Object.freeze({
      trigger: "pre_compact" as const,
      purpose: "Flush durable lessons before the host drops long context.",
      actions: Object.freeze(["memory_observe", "memory_save", "memory_explain"] as const),
      notes: Object.freeze([
        "MCP hosts (Codex/Claude/Cursor): Agent should call observe/save before compacting.",
        "OpenClaw registerMemoryFlushPlan is registered but returns null (no invented plan shape).",
        "Treat pre_compact like a scoped session_end: typed writes only.",
      ]),
      openClawEvent: null,
    }),
    task_complete: Object.freeze({
      trigger: "task_complete" as const,
      purpose: "Persist reusable experience / rules after a successful task.",
      actions: Object.freeze(["memory_observe", "memory_save"] as const),
      notes: Object.freeze([
        "Mark semanticType=experience or rules when causal lessons are confirmed.",
        "OpenClaw agent_end also covers task completion when the host ends the turn.",
      ]),
      openClawEvent: "agent_end" as const,
    }),
  });

export function recommendAgentSessionHook(
  trigger: AgentSessionHookTrigger,
): AgentSessionHookRecommendation {
  return TABLE[trigger];
}

export function listAgentSessionHookRecommendations(): readonly AgentSessionHookRecommendation[] {
  return Object.freeze([
    TABLE.session_start,
    TABLE.pre_compact,
    TABLE.task_complete,
    TABLE.session_end,
  ]);
}

/** Map OpenClaw lifecycle event names onto mengshu session-hook triggers. */
export function mapOpenClawEventToSessionHooks(
  event: "before_prompt_build" | "before_agent_start" | "agent_end",
): readonly AgentSessionHookTrigger[] {
  if (event === "before_prompt_build" || event === "before_agent_start") {
    return Object.freeze(["session_start"] as const);
  }
  return Object.freeze(["session_end", "task_complete"] as const);
}

const HOST_BINDINGS: readonly SessionHookHostBinding[] = Object.freeze([
  Object.freeze({
    host: "openclaw" as const,
    trigger: "session_start" as const,
    binding: "native" as const,
    nativeEvent: "before_prompt_build",
    flushPlan: null,
  }),
  Object.freeze({
    host: "openclaw" as const,
    trigger: "session_start" as const,
    binding: "native" as const,
    nativeEvent: "before_agent_start",
    flushPlan: null,
  }),
  Object.freeze({
    host: "openclaw" as const,
    trigger: "task_complete" as const,
    binding: "native" as const,
    nativeEvent: "agent_end",
    flushPlan: null,
  }),
  Object.freeze({
    host: "openclaw" as const,
    trigger: "session_end" as const,
    binding: "native" as const,
    nativeEvent: "agent_end",
    flushPlan: null,
  }),
  Object.freeze({
    host: "openclaw" as const,
    trigger: "pre_compact" as const,
    binding: "skill-only" as const,
    nativeEvent: null,
    flushPlan: null,
  }),
  ...SKILL_ONLY_HOSTS.flatMap((host) =>
    TRIGGER_ORDER.map((trigger) =>
      Object.freeze({
        host,
        trigger,
        binding: "skill-only" as const,
        nativeEvent: null,
        flushPlan: null,
      }),
    ),
  ),
]);

export function listSessionHookHostBindings(): readonly SessionHookHostBinding[] {
  return HOST_BINDINGS;
}

export function mapHostEventToSessionTriggers(
  host: SessionHookHost,
  nativeEvent: string,
): readonly AgentSessionHookTrigger[] {
  if (host === "openclaw" &&
      (nativeEvent === "before_prompt_build" ||
        nativeEvent === "before_agent_start" ||
        nativeEvent === "agent_end")) {
    return mapOpenClawEventToSessionHooks(nativeEvent);
  }
  return Object.freeze([]);
}

/** OpenClaw exposes a flush-plan slot; mengshu never invents a plan object. */
export function sessionHookFlushPlan(): null {
  return null;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: "runId" | "sessionId" | "projectId" | "user",
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hookKind(trigger: AgentSessionHookTrigger): SessionHookKind {
  return trigger === "session_start" ? "recall" : "typed_capture";
}

export function parseSessionEvent(input: unknown): ParseSessionEventResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, skipped: true, reason: "missing_trigger" };
  }
  const record = input as Record<string, unknown>;
  const triggerValue = record.trigger;
  if (typeof triggerValue !== "string" || triggerValue.trim().length === 0) {
    return { ok: false, skipped: true, reason: "missing_trigger" };
  }
  if (!TRIGGERS.has(triggerValue as AgentSessionHookTrigger)) {
    return { ok: false, skipped: true, reason: "unknown_trigger" };
  }
  const trigger = triggerValue as AgentSessionHookTrigger;
  const runId = readRequiredString(record, "runId");
  if (!runId) return { ok: false, skipped: true, reason: "missing_runId" };
  const sessionId = readRequiredString(record, "sessionId");
  if (!sessionId) return { ok: false, skipped: true, reason: "missing_sessionId" };
  const projectId = readRequiredString(record, "projectId");
  if (!projectId) return { ok: false, skipped: true, reason: "missing_projectId" };
  const user = readRequiredString(record, "user");
  if (!user) return { ok: false, skipped: true, reason: "missing_user" };

  const summaryValue = record.transcriptSummary;
  const transcriptSummary = typeof summaryValue === "string" && summaryValue.trim().length > 0
    ? summaryValue.trim()
    : undefined;

  return {
    ok: true,
    event: Object.freeze({
      trigger,
      runId,
      sessionId,
      projectId,
      user,
      ...(transcriptSummary === undefined ? {} : { transcriptSummary }),
    }),
  };
}

export function sessionEventDedupKey(event: SessionEvent): string {
  return createHash("sha256")
    .update(
      [event.sessionId, event.trigger, event.runId, event.transcriptSummary ?? ""].join("\0"),
      "utf8",
    )
    .digest("hex");
}

export function resolveSessionEvent(
  input: unknown,
  options: { readonly seen?: ReadonlySet<string> } = {},
): SessionHookResolution {
  const parsed = parseSessionEvent(input);
  if (!parsed.ok) {
    return {
      status: "skipped",
      skipped: true,
      reason: parsed.reason,
      blocking: false,
    };
  }
  const dedupKey = sessionEventDedupKey(parsed.event);
  if (options.seen?.has(dedupKey)) {
    return {
      status: "duplicate",
      skipped: true,
      reason: "duplicate_session_hash",
      blocking: false,
      dedupKey,
    };
  }
  return {
    status: "ready",
    kind: hookKind(parsed.event.trigger),
    event: parsed.event,
    recommendation: TABLE[parsed.event.trigger],
    dedupKey,
  };
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "session_hook_failed";
}

export async function dispatchSessionEvent(
  input: unknown,
  handlers: SessionHookHandlers = {},
  options: { readonly seen?: Set<string> } = {},
): Promise<SessionHookDispatchResult> {
  const resolved = resolveSessionEvent(input, options);
  if (resolved.status !== "ready") {
    return resolved;
  }
  const handler = resolved.kind === "recall" ? handlers.recall : handlers.typedCapture;
  try {
    await handler?.(resolved.event);
    options.seen?.add(resolved.dedupKey);
    return {
      status: "ok",
      kind: resolved.kind,
      event: resolved.event,
      recommendation: resolved.recommendation,
      dedupKey: resolved.dedupKey,
      blocking: false,
    };
  } catch (error) {
    return {
      status: "failed",
      kind: resolved.kind,
      event: resolved.event,
      reason: failureReason(error),
      blocking: false,
    };
  }
}
