import { describe, expect, test } from "vitest";
import type { MemoryService } from "../domain/service-types.js";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { retentionSweep } from "./retention.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

class FakeMemoryService implements Pick<MemoryService, "delete"> {
  deletes: unknown[] = [];

  async delete(input: Parameters<MemoryService["delete"]>[0]) {
    this.deletes.push(input);
    return { deleted: 3 };
  }
}

describe("retentionSweep", () => {
  test("deletes by cutoff and writes audit", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1710000000000 });
    const service = new FakeMemoryService();

    const result = await retentionSweep({
      scope,
      olderThanMs: 1000,
      now: 1710000000000,
      service: service as unknown as MemoryService,
      audit: store.audit,
      actor: "system",
    });

    expect(result).toEqual({ cutoff: 1709999999000, deleted: 3 });
    expect(service.deletes).toEqual([
      {
        filter: {
          scope,
          createdAt: { $lt: 1709999999000 },
        },
      },
    ]);
    await expect(store.audit.list({ scope })).resolves.toMatchObject([
      {
        action: "retention_sweep",
        metadata: {
          deleted: 3,
          cutoff: 1709999999000,
        },
      },
    ]);
  });
});
