import { afterEach, describe, expect, test } from "vitest";
import type { MemoryService } from "../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../core/types.js";
import { createConsoleApi } from "./api.js";
import { startMemoryServer, type RunningMemoryServer } from "../server/daemon.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

const record: MemoryRecord = {
  id: "mem-1",
  scope,
  kind: "fact",
  text: "Memory console smoke",
  contentHash: "hash-1",
  importance: 0.5,
  category: "fact",
  dataType: "memory",
  tableName: "memories",
  metadata: {},
  provenance: {},
  createdAt: 1710000000000,
};

class FakeMemoryService implements MemoryService {
  async storeMemory() {
    return { id: "mem-1", stored: true };
  }

  async recall(): Promise<RecallResult> {
    return { scope, query: "console", hits: [{ record, score: 0.9, source: "vector" }] };
  }

  async buildContext(): Promise<ContextBlock> {
    return { scope, content: "", hits: [], tokenEstimate: 0 };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: 1 };
  }
}

describe("web console smoke", () => {
  let running: RunningMemoryServer | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  test("serves console shell and REST overview", async () => {
    const service = new FakeMemoryService();
    running = await startMemoryServer({
      service,
      console: createConsoleApi({ service }),
      host: "127.0.0.1",
      port: 0,
    });

    const html = await fetch(`${running.url}/console`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("Memory Console");

    const overview = await fetch(`${running.url}/v1/console/overview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ metrics: { memories: 1 } });
  });
});
