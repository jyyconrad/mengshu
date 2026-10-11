import { describe, expect, it } from "vitest";
import {
  listAgentSessionHookRecommendations,
  mapOpenClawEventToSessionHooks,
  recommendAgentSessionHook,
} from "./agent-session-hooks.js";

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
    expect(mapOpenClawEventToSessionHooks("agent_end")).toEqual(["session_end", "task_complete"]);
  });
});
