import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  filterToolsByMode,
  listHiddenToolDescriptors,
  resolveMcpToolMode,
} from "./tool-mode.js";

const tools = [
  { name: "memory_context_fast", description: "fast" },
  { name: "memory_recall", description: "recall" },
  { name: "memory_evolve", description: "evolve" },
  { name: "memory_health", description: "health" },
  { name: "memory_tools_discover", description: "discover" },
];

describe("mcp tool-mode", () => {
  it("resolves known modes and falls back", () => {
    expect(resolveMcpToolMode("FULL")).toBe("full");
    expect(resolveMcpToolMode("minimal")).toBe("minimal");
    expect(resolveMcpToolMode("nope")).toBe("default");
  });

  it("default mode hides evolve but keeps health/discover", () => {
    const listed = filterToolsByMode(tools, "default").map((t) => t.name);
    expect(listed).toContain("memory_context_fast");
    expect(listed).toContain("memory_health");
    expect(listed).not.toContain("memory_evolve");
    const hidden = listHiddenToolDescriptors(tools, "default").map((t) => t.name);
    expect(hidden).toContain("memory_evolve");
  });

  it("full mode advertises everything and hides nothing", () => {
    expect(filterToolsByMode(tools, "full")).toHaveLength(tools.length);
    expect(listHiddenToolDescriptors(tools, "full")).toEqual([]);
  });

  it("default mode lists only the realtime sequence and hides scan or batch tools", () => {
    const realtime = [
      { name: "memory_save", description: "save" },
      { name: "memory_health", description: "health" },
      { name: "memory_context_fast", description: "fast" },
      { name: "memory_explain", description: "explain" },
      { name: "memory_recall", description: "recall" },
      { name: "memory_scan_directory", description: "scan" },
      { name: "memory_evolve", description: "evolve" },
      { name: "memory_ingest", description: "ingest" },
      { name: "memory_working_set_ingest", description: "ws" },
      { name: "memory_skill_publish", description: "skill" },
      { name: "memory_evolution_run", description: "run" },
      { name: "memory_cleanup", description: "cleanup" },
      { name: "memory_lookup", description: "lookup" },
      { name: "memory_observe", description: "observe" },
      { name: "memory_observe_light", description: "light" },
      { name: "memory_forget", description: "forget" },
      { name: "memory_namespaces", description: "ns" },
      { name: "memory_tools_discover", description: "discover" },
    ];

    expect(filterToolsByMode(realtime, "default").map((tool) => tool.name)).toEqual([
      "memory_context_fast",
      "memory_recall",
      "memory_lookup",
      "memory_observe",
      "memory_save",
      "memory_observe_light",
      "memory_explain",
      "memory_forget",
      "memory_health",
      "memory_namespaces",
      "memory_tools_discover",
    ]);
    const hidden = listHiddenToolDescriptors(realtime, "default").map((tool) => tool.name);
    for (const name of [
      "memory_scan_directory",
      "memory_evolve",
      "memory_ingest",
      "memory_working_set_ingest",
      "memory_skill_publish",
      "memory_evolution_run",
      "memory_cleanup",
    ]) {
      expect(hidden).toContain(name);
    }
  });

  it("skill and quickstart use context_fast → recall → observe/save → explain", () => {
    const skill = readFileSync(
      new URL("../../../.agents/skills/mengshu/SKILL.md", import.meta.url),
      "utf8",
    );
    const quickstart = readFileSync(
      new URL("../../../docs/guides/local-agent-memory-quickstart.md", import.meta.url),
      "utf8",
    );
    const sequence = skill.split("**推荐启动序列**")[1]?.split("## ")[0] ?? "";
    const loop = quickstart.split("## 5. Agent")[1]?.split("## 6.")[0] ?? "";
    for (const text of [sequence, loop]) {
      expect(text.indexOf("memory_context_fast")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("memory_context_fast")).toBeLessThan(text.indexOf("memory_recall"));
      expect(text.indexOf("memory_recall")).toBeLessThan(text.indexOf("memory_observe"));
      expect(text.indexOf("memory_observe")).toBeLessThan(text.indexOf("memory_explain"));
      expect(text).toContain("ok-empty");
      expect(text).toContain("authority-filtered");
      expect(text).toContain("not-ready");
    }
    expect(skill).toContain("ms scan");
  });
});
