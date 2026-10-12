import { describe, expect, it, vi } from "vitest";
import {
  SESSION_HOOK_WRITE_DISCIPLINE,
  dispatchSessionEvent,
  listAgentSessionHookRecommendations,
  listSessionHookHostBindings,
  mapHostEventToSessionTriggers,
  mapOpenClawEventToSessionHooks,
  parseSessionEvent,
  recommendAgentSessionHook,
  resolveSessionEvent,
  sessionEventDedupKey,
  sessionHookFlushPlan,
} from "./agent-session-hooks.js";

const VALID_EVENT = Object.freeze({
  trigger: "session_start",
  runId: "run-1",
  sessionId: "session-1",
  projectId: "project-1",
  user: "user-1",
});

describe("agent session hooks", () => {
  it("recommends recall on session_start and capture on end/complete", () => {
    expect(recommendAgentSessionHook("session_start").actions[0]).toBe("memory_context_fast");
    expect(recommendAgentSessionHook("pre_compact").openClawEvent).toBeNull();
    expect(recommendAgentSessionHook("session_end").openClawEvent).toBe("agent_end");
    expect(recommendAgentSessionHook("task_complete").actions).toContain("memory_save");
  });

  it("lists all triggers and maps OpenClaw events without inventing APIs", () => {
    expect(listAgentSessionHookRecommendations()).toHaveLength(4);
    expect(mapOpenClawEventToSessionHooks("before_prompt_build")).toEqual(["session_start"]);
    expect(mapOpenClawEventToSessionHooks("agent_end")).toEqual(["session_end"]);
  });
});

describe("SessionEvent payload contract", () => {
  it("accepts the minimum fields plus an optional transcript summary", () => {
    const parsed = parseSessionEvent({
      ...VALID_EVENT,
      transcriptSummary: "decided to keep 5type writes typed",
      extraHostField: "ignored",
    });
    expect(parsed).toEqual({
      ok: true,
      event: {
        trigger: "session_start",
        runId: "run-1",
        sessionId: "session-1",
        projectId: "project-1",
        user: "user-1",
        transcriptSummary: "decided to keep 5type writes typed",
      },
    });
  });

  it.each([
    ["trigger", "missing_trigger"],
    ["runId", "missing_runId"],
    ["sessionId", "missing_sessionId"],
    ["projectId", "missing_projectId"],
    ["user", "missing_user"],
  ] as const)("skips when %s is missing and records the reason", (field, reason) => {
    const input = { ...VALID_EVENT };
    delete (input as Record<string, unknown>)[field];
    expect(parseSessionEvent(input)).toEqual({
      ok: false,
      skipped: true,
      reason,
    });
  });

  it("skips unknown triggers and blank required strings", () => {
    expect(parseSessionEvent({ ...VALID_EVENT, trigger: "flush_plan" })).toEqual({
      ok: false,
      skipped: true,
      reason: "unknown_trigger",
    });
    expect(parseSessionEvent({ ...VALID_EVENT, sessionId: "  " })).toEqual({
      ok: false,
      skipped: true,
      reason: "missing_sessionId",
    });
  });

  it("resolves session_start to recall and compact/end/complete to typed capture", () => {
    expect(resolveSessionEvent(VALID_EVENT)).toMatchObject({
      status: "ready",
      kind: "recall",
      recommendation: recommendAgentSessionHook("session_start"),
    });
    for (const trigger of ["pre_compact", "task_complete", "session_end"] as const) {
      expect(resolveSessionEvent({ ...VALID_EVENT, trigger })).toMatchObject({
        status: "ready",
        kind: "typed_capture",
        recommendation: recommendAgentSessionHook(trigger),
      });
    }
  });

  it("dedupes only inside the caller-supplied seen set", () => {
    const seen = new Set<string>();
    const capture = {
      ...VALID_EVENT,
      trigger: "session_end" as const,
      transcriptSummary: "prefer typed experience writes",
    };
    const first = resolveSessionEvent(capture, { seen });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    seen.add(first.dedupKey);
    expect(sessionEventDedupKey(first.event)).toBe(first.dedupKey);
    expect(resolveSessionEvent(capture, { seen })).toEqual({
      status: "duplicate",
      skipped: true,
      reason: "duplicate_session_hash",
      blocking: false,
      dedupKey: first.dedupKey,
    });
  });
});

describe("session hook dispatch", () => {
  it("does not call handlers when the payload is incomplete", async () => {
    const recall = vi.fn();
    const typedCapture = vi.fn();
    const result = await dispatchSessionEvent(
      { trigger: "session_start" },
      { recall, typedCapture },
    );
    expect(result).toEqual({
      status: "skipped",
      skipped: true,
      reason: "missing_runId",
      blocking: false,
    });
    expect(recall).not.toHaveBeenCalled();
    expect(typedCapture).not.toHaveBeenCalled();
  });

  it("swallows handler failures as observable non-blocking results", async () => {
    const result = await dispatchSessionEvent(
      { ...VALID_EVENT, trigger: "task_complete" },
      {
        typedCapture: () => {
          throw new Error("admission rejected");
        },
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      kind: "typed_capture",
      reason: "admission rejected",
      blocking: false,
    });
  });

  it("does not report success or consume dedup when the handler is missing", async () => {
    const seen = new Set<string>();
    const missing = await dispatchSessionEvent(VALID_EVENT, {}, { seen });
    expect(missing).toMatchObject({
      status: "skipped",
      skipped: true,
      reason: "handler_missing",
      blocking: false,
    });
    expect(seen.size).toBe(0);
    const recall = vi.fn();
    const later = await dispatchSessionEvent(VALID_EVENT, { recall }, { seen });
    expect(later.status).toBe("ok");
    expect(recall).toHaveBeenCalledOnce();
  });

  it("redacts secrets in transcript summaries before handlers see them", async () => {
    const secret = "sk-hooksummarysecretvalue1234567890";
    const captured: string[] = [];
    const parsed = parseSessionEvent({
      ...VALID_EVENT,
      trigger: "session_end",
      transcriptSummary: `store ${secret} after the task`,
    });
    expect(JSON.stringify(parsed)).not.toContain(secret);
    const result = await dispatchSessionEvent(
      { ...VALID_EVENT, trigger: "session_end", transcriptSummary: `store ${secret} after the task` },
      {
        typedCapture: (event) => {
          captured.push(event.transcriptSummary ?? "");
        },
      },
    );
    expect(result.status).toBe("ok");
    expect(captured).toEqual([expect.stringContaining("[REDACTED:api_key]")]);
    expect(captured.join("\n")).not.toContain(secret);
  });

  it("redacts secrets that a failed handler would otherwise echo", async () => {
    const secret = "sk-hookfailsecretvalue1234567890";
    const result = await dispatchSessionEvent(
      { ...VALID_EVENT, trigger: "task_complete", transcriptSummary: `keep ${secret}` },
      {
        typedCapture: () => {
          throw new Error(`admission rejected token ${secret}`);
        },
      },
    );
    expect(result).toMatchObject({ status: "failed", blocking: false });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[REDACTED:api_key]");
  });

  it("never throws, even when the handler rejects", async () => {
    await expect(dispatchSessionEvent(null, {
      recall: async () => {
        throw new Error("boom");
      },
    })).resolves.toMatchObject({ status: "skipped", blocking: false });
    await expect(dispatchSessionEvent(VALID_EVENT, {
      recall: async () => {
        throw new Error("boom");
      },
    })).resolves.toMatchObject({ status: "failed", blocking: false, reason: "boom" });
  });
});

describe("host hook mapping matrix", () => {
  it("maps real OpenClaw events and keeps every flush-plan null", () => {
    const rows = listSessionHookHostBindings();
    expect(sessionHookFlushPlan()).toBeNull();
    expect(rows.every((row) => row.flushPlan === null)).toBe(true);

    const openclaw = rows.filter((row) => row.host === "openclaw");
    expect(openclaw).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trigger: "session_start",
        binding: "native",
        nativeEvent: "before_prompt_build",
      }),
      expect.objectContaining({
        trigger: "session_start",
        binding: "native",
        nativeEvent: "before_agent_start",
      }),
      expect.objectContaining({
        trigger: "task_complete",
        binding: "skill-only",
        nativeEvent: null,
      }),
      expect.objectContaining({
        trigger: "session_end",
        binding: "native",
        nativeEvent: "agent_end",
      }),
      expect.objectContaining({
        trigger: "pre_compact",
        binding: "skill-only",
        nativeEvent: null,
      }),
    ]));

    expect(mapHostEventToSessionTriggers("openclaw", "before_agent_start")).toEqual(["session_start"]);
    expect(mapHostEventToSessionTriggers("openclaw", "agent_end")).toEqual(["session_end"]);
    expect(mapHostEventToSessionTriggers("codex", "PreCompact")).toEqual([]);
  });

  it("marks Codex, Claude Code, and Cursor as Skill-only for every trigger", () => {
    const skillHosts = listSessionHookHostBindings().filter((row) =>
      row.host === "codex" || row.host === "claude-code" || row.host === "cursor");
    expect(skillHosts).toHaveLength(12);
    expect(skillHosts.every((row) => row.binding === "skill-only" && row.nativeEvent === null)).toBe(true);
  });
});

describe("session hook write discipline", () => {
  it("forbids transcript dumps, silent ADD, invented flush-plans, and blocking failures", () => {
    expect(SESSION_HOOK_WRITE_DISCIPLINE).toEqual({
      dumpWholeTranscript: false,
      requireVerifiedSemanticType: true,
      allowedSemanticTypes: ["profile", "task_context", "rules", "experience", "resource"],
      silentAdd: false,
      inventFlushPlan: false,
      blockTurnOnFailure: false,
    });
  });
});

