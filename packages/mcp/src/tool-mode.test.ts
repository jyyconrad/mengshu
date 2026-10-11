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
});
