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
