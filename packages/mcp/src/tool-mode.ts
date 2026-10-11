/**
 * MCP tool facade modes (Cognee / FactMem ergonomics).
 *
 * - default: curated tools for coding/work Agents
 * - minimal: read-mostly bootstrap set
 * - full: advertise every registered tool (legacy behavior)
 *
 * Hidden tools remain callable when the client knows the name; ListTools is filtered.
 * `memory_tools_discover` lists tools not advertised in the current mode.
 */

export type McpToolMode = "default" | "minimal" | "full";

export interface McpToolDescriptor {
  name: string;
  description: string;
}

/** Curated default surface for coding/work Agents. */
export const MCP_DEFAULT_TOOL_NAMES: readonly string[] = [
  "memory_context_fast",
  "memory_recall",
  "memory_save",
  "memory_observe",
  "memory_observe_light",
  "memory_forget",
  "memory_lookup",
  "memory_explain",
  "memory_tools_discover",
  "memory_health",
  "memory_namespaces",
] as const;

export const MCP_MINIMAL_TOOL_NAMES: readonly string[] = [
  "memory_context_fast",
  "memory_recall",
  "memory_tools_discover",
  "memory_health",
] as const;

export function resolveMcpToolMode(
  raw: string | undefined | null,
  fallback: McpToolMode = "default",
): McpToolMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "full" || value === "default" || value === "minimal") {
    return value;
  }
  return fallback;
}

export function resolveMcpToolModeFromEnv(
  env: Record<string, string | undefined> = process.env,
  fallback: McpToolMode = "default",
): McpToolMode {
  return resolveMcpToolMode(env.MENGSHU_MCP_TOOL_MODE, fallback);
}

export function filterToolsByMode<T extends McpToolDescriptor>(
  tools: readonly T[],
  mode: McpToolMode,
): T[] {
  if (mode === "full") {
    return [...tools];
  }
  const allow = new Set(mode === "minimal" ? MCP_MINIMAL_TOOL_NAMES : MCP_DEFAULT_TOOL_NAMES);
  allow.add("memory_tools_discover");
  allow.add("memory_health");
  return tools.filter((tool) => allow.has(tool.name));
}

export function listHiddenToolDescriptors(
  tools: readonly McpToolDescriptor[],
  mode: McpToolMode,
): Array<{ name: string; description: string }> {
  if (mode === "full") {
    return [];
  }
  const visible = new Set(filterToolsByMode(tools, mode).map((tool) => tool.name));
  return tools
    .filter((tool) => !visible.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description }));
}
