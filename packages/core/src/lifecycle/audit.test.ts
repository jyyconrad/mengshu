import { describe, expect, test } from "vitest";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { auditLifecycle } from "./audit.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

describe("auditLifecycle", () => {
  test("writes governance audit record with actor and reason", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1710000000000 });

    const record = await auditLifecycle(store.audit, {
      scope,
      action: "forget",
      targetId: "mem-1",
      actor: "owner",
      reason: "user request",
    });

    expect(record).toMatchObject({
      scope,
      action: "forget",
      targetId: "mem-1",
      metadata: {
        actor: "owner",
        reason: "user request",
      },
    });
  });
});
