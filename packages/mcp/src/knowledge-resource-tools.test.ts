import { describe, expect, test, vi } from "vitest";

import type { AuthorityScope } from "../../core/src/domain/authority-scope.js";
import { createMcpMemoryTools } from "./tools.js";

const authority: AuthorityScope = {
  tenantId: "server-tenant",
  userId: "server-user",
  workspaceId: "workspace-a",
  sessionId: "session-a",
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
  workspaceId: authority.workspaceId,
  sessionId: authority.sessionId,
};

describe("MCP Knowledge resource tools", () => {
  test("tool discovery is capability-gated", () => {
    const without = createMcpMemoryTools({ service: {} as never, authority, defaultScope });
    expect(without.map((tool) => tool.name)).not.toContain("memory_knowledge_search");
    expect(without.map((tool) => tool.name)).not.toContain("memory_knowledge_read");

    const withCapability = createMcpMemoryTools({
      service: {} as never,
      authority,
      defaultScope,
      knowledgeResources: { search: vi.fn(), read: vi.fn() } as never,
    });
    expect(withCapability.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_knowledge_search",
      "memory_knowledge_read",
    ]));
  });

  test("search/read inherit server authority and accept no provider/path parameters", async () => {
    const search = vi.fn(async () => ({ resources: [], warnings: [] }));
    const read = vi.fn(async () => ({ resource: undefined, warnings: ["knowledge_resource_not_found"] }));
    const tools = createMcpMemoryTools({
      service: {} as never,
      authority,
      defaultScope,
      knowledgeResources: { search, read } as never,
    });
    const searchTool = tools.find((tool) => tool.name === "memory_knowledge_search")!;
    const readTool = tools.find((tool) => tool.name === "memory_knowledge_read")!;
    const attackerScope = {
      tenantId: "attacker",
      userId: "attacker",
      appId: defaultScope.appId,
      projectId: defaultScope.projectId,
      agentId: defaultScope.agentId,
      namespace: defaultScope.namespace,
      visibility: defaultScope.visibility,
    };

    await expect(searchTool.execute({
      scope: attackerScope,
      query: "runtime",
      limit: 5,
    })).resolves.toEqual({ resources: [], warnings: [] });
    expect(search).toHaveBeenCalledWith(defaultScope, { query: "runtime", limit: 5 });

    const ref = "11111111-1111-4111-8111-111111111111";
    const revision = "a".repeat(64);
    await expect(readTool.execute({
      scope: attackerScope,
      ref,
      revision,
      maxChars: 500,
    })).resolves.toMatchObject({ warnings: ["knowledge_resource_not_found"] });
    expect(read).toHaveBeenCalledWith(defaultScope, { ref, revision, maxChars: 500 });

    for (const forbidden of ["path", "url", "sql", "provider"]) {
      await expect(searchTool.execute({ query: "runtime", [forbidden]: "attacker" }))
        .rejects.toThrow(/accepts only scope, query, and limit/i);
      await expect(readTool.execute({ ref, revision, [forbidden]: "attacker" }))
        .rejects.toThrow(/accepts only scope, ref, revision, and maxChars/i);
    }
    expect(search).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
