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

/**
 * Realtime default surface, in the Agent usage order:
 * context_fast → recall/lookup → observe/save → explain.
 * Scan, evolve, ingest, working-set, and skill mutation tools stay off this list.
 */
export const MCP_DEFAULT_TOOL_NAMES: readonly string[] = [
  "memory_context_fast",
  "memory_recall",
  "memory_wiki_read",
  "memory_lookup",
  "memory_observe",
  "memory_save",
  "memory_observe_light",
  "memory_explain",
  "memory_forget",
  "memory_health",
  "memory_namespaces",
  "memory_tools_discover",
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
  const ordered = mode === "minimal" ? MCP_MINIMAL_TOOL_NAMES : MCP_DEFAULT_TOOL_NAMES;
  const allow = new Set<string>(ordered);
  allow.add("memory_tools_discover");
  allow.add("memory_health");
  const rank = new Map(ordered.map((name, index) => [name, index]));
  return tools
    .filter((tool) => allow.has(tool.name))
    .sort((left, right) => (rank.get(left.name) ?? 1_000) - (rank.get(right.name) ?? 1_000));
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
