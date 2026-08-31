import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { InMemorySkillCandidateRepository } from "./skill-candidate-repository.js";

const scope: MemoryScope = {
  tenantId: "tenant-1", userId: "user-1", appId: "codex", projectId: "project-1",
  agentId: "agent-1", namespace: "memories", visibility: "private",
  workspaceId: "workspace-1", sessionId: "session-1",
};

describe("InMemorySkillCandidateRepository", () => {
  test("filters by the complete canonical authority scope", async () => {
    const repository = new InMemorySkillCandidateRepository({ now: () => 1_000 });
    const create = (candidateScope: MemoryScope, id: string) => repository.create({
      id,
      scope: candidateScope,
      title: id,
      topicLabel: "deploy",
      triggerConditions: [], preconditions: [], steps: ["verify"], successSignals: [],
      antiPatterns: [], riskBoundaries: [], highRisk: false,
      evidenceMemoryIds: ["memory-1"], evidenceChunkIds: [], confidence: 0.9,
      status: "pending",
    });
    const exact = await create(scope, "exact");
    await create({ ...scope, sessionId: "session-2" }, "other-session");
    await create({ ...scope, agentId: "agent-2" }, "other-agent");
    await create({ ...scope, visibility: "workspace" }, "other-visibility");

    await expect(repository.list({ scope })).resolves.toEqual([exact]);
  });
});
