import { describe, expect, test, vi } from "vitest";

import type { AuthorityScope } from "../../core/src/domain/authority-scope.js";
import { createMcpMemoryServer } from "./server.js";
import { createMcpStdioServer } from "./stdio-server.js";

const authority: AuthorityScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  allow: {
    appIds: ["codex"],
    projectIds: ["project-a"],
    agentIds: ["agent-a"],
    namespaces: ["memory"],
    visibilities: ["private"],
  },
};
const defaultScope = {
  tenantId: authority.tenantId,
  userId: authority.userId,
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
};

describe("Knowledge resource MCP server composition", () => {
  test("facade and stdio advertise Knowledge tools only when capability is injected", async () => {
    const base = { service: {} as never, authority, defaultScope };
    const without = createMcpMemoryServer(base);
    expect(without.listTools().map((tool) => tool.name)).not.toContain("memory_knowledge_search");

    const search = vi.fn(async () => ({ resources: [], warnings: [] }));
    const read = vi.fn(async () => ({ resource: undefined, warnings: ["knowledge_resource_not_found"] }));
    const capability = { search, read } as never;
    const facade = createMcpMemoryServer({ ...base, knowledgeResources: capability });
    const stdio = createMcpStdioServer({ ...base, knowledgeResources: capability });

    expect(facade.listTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_knowledge_search",
      "memory_knowledge_read",
    ]));
    expect(stdio.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_knowledge_search",
      "memory_knowledge_read",
    ]));
    await expect(facade.callTool("memory_knowledge_search", { query: "runtime" }))
      .resolves.toEqual({ resources: [], warnings: [] });
    expect(search).toHaveBeenCalledWith(defaultScope, { query: "runtime" });
  });
});
