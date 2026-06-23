/**
 * 回填 observation metadata 集成测试。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { DatabaseProvider, MemoryEntry, TableName, TableStats } from "../../../../packages/core/src/db/types.js";
import { registerBackfillObservationMetadataCommand } from "./backfill-observation-metadata.js";

interface CommandOption {
  flags: string;
  description: string;
  defaultValue?: unknown;
}

interface MockCommanderLike {
  _commands: Array<{
    name: string;
    description: string;
    options: CommandOption[];
    action: (...args: unknown[]) => unknown;
  }>;
  command(name: string): MockCommanderLike;
  description(text: string): MockCommanderLike;
  option(flags: string, description: string, defaultValue?: unknown): MockCommanderLike;
  action(handler: (...args: unknown[]) => unknown): MockCommanderLike;
}

function createMockCommander(): MockCommanderLike {
  const mock: MockCommanderLike = {
    _commands: [],
    command(name: string) {
      const cmd = {
        name,
        description: "",
        options: [] as CommandOption[],
        action: (() => {}) as (...args: unknown[]) => unknown,
      };
      this._commands.push(cmd);
      return {
        _commands: this._commands,
        command: this.command.bind(this),
        description(text: string) {
          cmd.description = text;
          return this;
        },
        option(flags: string, description: string, defaultValue?: unknown) {
          cmd.options.push({ flags, description, defaultValue });
          return this;
        },
        action(handler: (...args: unknown[]) => unknown) {
          cmd.action = handler;
          return this;
        },
      };
    },
    description(text: string) {
      return this;
    },
    option(flags: string, description: string, defaultValue?: unknown) {
      return this;
    },
    action(handler: (...args: unknown[]) => unknown) {
      return this;
    },
  };
  return mock;
}

class MockDatabaseProvider implements DatabaseProvider {
  private entries: MemoryEntry[] = [];

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async store(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      const idx = this.entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        this.entries[idx] = entry;
      } else {
        this.entries.push(entry);
      }
    }
  }

  async query(options: {
    query?: string;
    vector?: number[];
    limit?: number;
    minScore?: number;
    dataTypes?: string[];
    filter?: Record<string, unknown>;
    tableName?: string;
    searchAll?: boolean;
  }): Promise<Array<MemoryEntry & { score: number }>> {
    let results = [...this.entries];

    // Filter by dataTypes (memory)
    if (options.dataTypes && options.dataTypes.length > 0) {
      results = results.filter((e) => options.dataTypes!.includes(e.dataType));
    }

    // Filter by metadata.kind (legacy filter support)
    if (options.filter?.kind) {
      results = results.filter((e) => e.metadata.kind === options.filter?.kind);
    }

    // Filter by id
    if (options.filter?.id) {
      results = results.filter((e) => e.id === options.filter?.id);
    }

    const limit = options.limit ?? 100;
    return results.slice(0, limit).map((e) => ({ ...e, score: 0.9 }));
  }

  async delete(ids: string[]): Promise<void> {
    this.entries = this.entries.filter((e) => !ids.includes(e.id));
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (filter.kind && e.metadata.kind !== filter.kind) return true;
      return false;
    });
    return before - this.entries.length;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    return this.entries.filter((e) => contentHashes.includes(e.contentHash)).map((e) => e.contentHash);
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    if (!filter) return this.entries.length;
    return this.entries.filter((e) => {
      if (filter.kind && e.metadata.kind !== filter.kind) return false;
      return true;
    }).length;
  }

  async getTableNames(): Promise<TableName[]> {
    return ["memories"];
  }

  async ensureTable(tableName: TableName): Promise<void> {}

  async getTableStats(): Promise<TableStats[]> {
    return [{ name: "memories", count: this.entries.length, dataType: "memory" }];
  }

  /**
   * 按 id 增量合并 metadata（模拟 Postgres `metadata || patch::jsonb`）。
   * 关键：仅 patch 指定字段，不覆盖整个 metadata，已有字段保留。
   */
  async updateMetadata(
    id: string,
    metadataPatch: Record<string, unknown>,
    _tableName?: TableName,
  ): Promise<boolean> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const existing = this.entries[idx];
    this.entries[idx] = {
      ...existing,
      metadata: { ...existing.metadata, ...metadataPatch },
    };
    return true;
  }

  // Test helpers
  getEntries(): MemoryEntry[] {
    return [...this.entries];
  }

  clearEntries(): void {
    this.entries = [];
  }
}

describe("backfill-observation-metadata", () => {
  let mockDb: MockDatabaseProvider;
  let mockCommander: MockCommanderLike;

  beforeEach(() => {
    mockDb = new MockDatabaseProvider();
    mockCommander = createMockCommander();
  });

  it("应该注册 backfill-observation-metadata 命令", () => {
    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });

    expect(mockCommander._commands).toHaveLength(1);
    expect(mockCommander._commands[0].name).toBe("backfill-observation-metadata");
    expect(mockCommander._commands[0].options).toHaveLength(3);
  });

  it("dry-run 应该统计缺失字段的 observation", async () => {
    // 插入 3 条旧 observation（metadata 缺字段）
    const oldObservations: MemoryEntry[] = [
      {
        id: randomUUID(),
        text: "old observation 1",
        contentHash: "hash1",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          userId: undefined, // 缺失
          projectPath: undefined, // 缺失
          agentName: undefined, // 缺失
          tenantId: "local",
          appId: "openclaw",
          projectId: "proj1",
          agentId: "agent1",
        },
        createdAt: Date.now() - 86400000,
      },
      {
        id: randomUUID(),
        text: "old observation 2",
        contentHash: "hash2",
        vector: [0.2, 0.3, 0.4],
        importance: 0.6,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          userId: "alice", // 有
          projectPath: undefined, // 缺失
          agentName: undefined, // 缺失
          tenantId: "local",
          appId: "openclaw",
          projectId: "proj2",
          agentId: "agent2",
        },
        createdAt: Date.now() - 86400000,
      },
      {
        id: randomUUID(),
        text: "old observation 3",
        contentHash: "hash3",
        vector: [0.3, 0.4, 0.5],
        importance: 0.7,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          userId: undefined, // 缺失
          projectPath: "proj3", // 有
          agentName: undefined, // 缺失
          tenantId: "local",
          appId: "openclaw",
          projectId: "proj3",
          agentId: "default",
        },
        createdAt: Date.now() - 86400000,
      },
    ];

    // 插入 1 条新 observation（已有字段）
    const newObservation: MemoryEntry = {
      id: randomUUID(),
      text: "new observation",
      contentHash: "hash4",
      vector: [0.4, 0.5, 0.6],
      importance: 0.8,
      category: "core",
      dataType: "memory",
      metadata: {
        kind: "observation",
        userId: "bob",
        projectPath: "proj4",
        agentName: "agent4",
        tenantId: "local",
        appId: "openclaw",
        projectId: "proj4",
        agentId: "agent4",
      },
      createdAt: Date.now(),
    };

    await mockDb.store([...oldObservations, newObservation]);

    // 注册命令
    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });

    // 执行 dry-run
    const cmd = mockCommander._commands[0];
    let consoleOutput = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(" ") + "\n";
    };

    await cmd.action({ dryRun: true, apply: false, limit: "1000" });

    console.log = originalLog;

    // 验证输出
    expect(consoleOutput).toContain("[Dry-run] Backfill observation metadata");
    expect(consoleOutput).toContain("Affected: 3 records");
    expect(consoleOutput).toContain("Sample (first");
  });

  it("apply 应该真实回填缺失字段", async () => {
    // 插入 2 条旧 observation
    const oldObservations: MemoryEntry[] = [
      {
        id: randomUUID(),
        text: "old observation 1",
        contentHash: "hash1",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          userId: undefined,
          projectPath: undefined,
          agentName: undefined,
          tenantId: "local",
          appId: "openclaw",
          projectId: "proj1",
          agentId: "agent1",
        },
        createdAt: Date.now() - 86400000,
      },
      {
        id: randomUUID(),
        text: "old observation 2",
        contentHash: "hash2",
        vector: [0.2, 0.3, 0.4],
        importance: 0.6,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          userId: "alice",
          projectPath: undefined,
          agentName: undefined,
          tenantId: "local",
          appId: "openclaw",
          projectId: "proj2",
          agentId: "agent2",
        },
        createdAt: Date.now() - 86400000,
      },
    ];

    await mockDb.store(oldObservations);

    // 注册命令
    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });

    // 执行 apply
    const cmd = mockCommander._commands[0];
    let consoleOutput = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(" ") + "\n";
    };

    await cmd.action({ dryRun: false, apply: true, limit: "1000" });

    console.log = originalLog;

    // 验证输出
    expect(consoleOutput).toContain("[Apply] Backfill observation metadata");
    expect(consoleOutput).toContain("Affected: 2 records");
    expect(consoleOutput).toContain("Applied: 2 records");

    // 验证数据库中的记录已更新
    const entries = mockDb.getEntries();
    expect(entries).toHaveLength(2);

    const entry1 = entries.find((e) => e.text === "old observation 1");
    expect(entry1).toBeDefined();
    expect(entry1!.metadata.userId).toBe("default"); // proj1 scope 无 userId，补 default
    expect(entry1!.metadata.projectPath).toBe("proj1");
    expect(entry1!.metadata.agentName).toBe("agent1");

    const entry2 = entries.find((e) => e.text === "old observation 2");
    expect(entry2).toBeDefined();
    expect(entry2!.metadata.userId).toBe("alice"); // 已有，不改
    expect(entry2!.metadata.projectPath).toBe("proj2"); // 从 scope 回填
    expect(entry2!.metadata.agentName).toBe("agent2");
  });

  it("应该跳过新 observation（已有全部字段）", async () => {
    // 插入 1 条新 observation（已有字段）
    const newObservation: MemoryEntry = {
      id: randomUUID(),
      text: "new observation",
      contentHash: "hash1",
      vector: [0.1, 0.2, 0.3],
      importance: 0.8,
      category: "core",
      dataType: "memory",
      metadata: {
        kind: "observation",
        userId: "bob",
        projectPath: "proj1",
        agentName: "agent1",
        tenantId: "local",
        appId: "openclaw",
        projectId: "proj1",
        agentId: "agent1",
      },
      createdAt: Date.now(),
    };

    await mockDb.store([newObservation]);

    // 注册命令
    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });

    // 执行 dry-run
    const cmd = mockCommander._commands[0];
    let consoleOutput = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(" ") + "\n";
    };

    await cmd.action({ dryRun: true, apply: false, limit: "1000" });

    console.log = originalLog;

    // 验证未发现需要回填的记录
    expect(consoleOutput).toContain("未发现需要回填的记录");
  });

  it("limit 应该限制回填数量", async () => {
    // 插入 5 条旧 observation
    const oldObservations: MemoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: randomUUID(),
      text: `old observation ${i + 1}`,
      contentHash: `hash${i + 1}`,
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "core",
      dataType: "memory",
      metadata: {
        kind: "observation",
        userId: undefined,
        projectPath: undefined,
        agentName: undefined,
        tenantId: "local",
        appId: "openclaw",
        projectId: `proj${i + 1}`,
        agentId: `agent${i + 1}`,
      },
      createdAt: Date.now() - 86400000,
    }));

    await mockDb.store(oldObservations);

    // 注册命令
    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });

    // 执行 dry-run with limit=3
    const cmd = mockCommander._commands[0];
    let consoleOutput = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(" ") + "\n";
    };

    await cmd.action({ dryRun: true, apply: false, limit: "3" });

    console.log = originalLog;

    // 验证只扫描 3 条
    expect(consoleOutput).toContain("Affected: 3 records");
  });

  it("应该识别真实 observation（无 metadata.kind，仅靠 eventType/source）", async () => {
    // 模拟真实 Postgres 数据：record.kind 不持久化，observation 靠 eventType + source 识别
    const realObservation: MemoryEntry = {
      id: randomUUID(),
      text: "real observation without metadata.kind",
      contentHash: "hash-real",
      vector: [0.1, 0.2, 0.3],
      importance: 0.4,
      category: "core",
      dataType: "memory",
      metadata: {
        // 注意：无 kind 字段（真实 recordToMemoryEntry 不写 kind）
        eventType: "user_input",
        source: "agent-fast-path" as unknown as "agent",
        projectId: "real-proj",
        agentId: "real-agent",
        // userId/projectPath/agentName 全缺
      },
      createdAt: Date.now() - 86400000,
    };

    // 一条普通 memory（非 observation，无 eventType/agent-fast-path source）
    const normalMemory: MemoryEntry = {
      id: randomUUID(),
      text: "normal preference memory",
      contentHash: "hash-normal",
      vector: [0.4, 0.5, 0.6],
      importance: 0.7,
      category: "preference",
      dataType: "memory",
      metadata: {
        source: "user",
        // 即使缺 userId 也不应被回填（非 observation）
      },
      createdAt: Date.now(),
    };

    await mockDb.store([realObservation, normalMemory]);

    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });

    const cmd = mockCommander._commands[0];
    let consoleOutput = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput += args.join(" ") + "\n";
    };

    await cmd.action({ dryRun: false, apply: true, limit: "1000" });

    console.log = originalLog;

    // 只有 observation 被回填，普通 memory 不动
    expect(consoleOutput).toContain("Applied: 1 records");

    const entries = mockDb.getEntries();
    const obs = entries.find((e) => e.text === "real observation without metadata.kind");
    expect(obs).toBeDefined();
    expect(obs!.metadata.userId).toBe("default"); // scope 无 userId，补 default
    expect(obs!.metadata.projectPath).toBe("real-proj"); // 从 metadata.projectId 回填
    expect(obs!.metadata.agentName).toBe("real-agent"); // 从 metadata.agentId 回填

    const normal = entries.find((e) => e.text === "normal preference memory");
    expect(normal).toBeDefined();
    expect(normal!.metadata.userId).toBeUndefined(); // 非 observation，未回填
  });

  it("apply 应该调用 updateMetadata 而非 store（store 在 content_hash 冲突时 DO NOTHING）", async () => {
    const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
    let storeCalled = false;

    const obsId = randomUUID();
    const spyDb = Object.assign(new MockDatabaseProvider(), {
      async store(this: MockDatabaseProvider, entries: MemoryEntry[]) {
        storeCalled = true;
        return MockDatabaseProvider.prototype.store.call(this, entries);
      },
      async updateMetadata(
        this: MockDatabaseProvider,
        id: string,
        patch: Record<string, unknown>,
        tableName?: TableName,
      ) {
        updateCalls.push({ id, patch });
        return MockDatabaseProvider.prototype.updateMetadata.call(this, id, patch, tableName);
      },
    });

    await spyDb.store([
      {
        id: obsId,
        text: "obs needing backfill",
        contentHash: "hash-spy",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          projectId: "proj-spy",
          agentId: "agent-spy",
        },
        createdAt: Date.now() - 86400000,
      },
    ]);

    // 重置 store 标志（上面的 seed 用到了 store）
    storeCalled = false;

    registerBackfillObservationMetadataCommand(mockCommander, { db: spyDb });
    const cmd = mockCommander._commands[0];
    const originalLog = console.log;
    console.log = () => {};
    await cmd.action({ dryRun: false, apply: true, limit: "1000" });
    console.log = originalLog;

    // 回填阶段只调 updateMetadata，不调 store
    expect(storeCalled).toBe(false);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe(obsId);
    expect(updateCalls[0].patch).toMatchObject({
      userId: "default",
      projectPath: "proj-spy",
      agentName: "agent-spy",
    });
  });

  it("updateMetadata 应增量合并，保留 metadata 已有字段", async () => {
    const obsId = randomUUID();
    await mockDb.store([
      {
        id: obsId,
        text: "obs preserve existing",
        contentHash: "hash-preserve",
        vector: [0.1, 0.2, 0.3],
        importance: 0.5,
        category: "core",
        dataType: "memory",
        metadata: {
          kind: "observation",
          eventType: "user_input",
          sessionId: "sess-123",
          projectId: "proj-x",
          agentId: "agent-x",
        },
        createdAt: Date.now() - 86400000,
      },
    ]);

    registerBackfillObservationMetadataCommand(mockCommander, { db: mockDb });
    const cmd = mockCommander._commands[0];
    const originalLog = console.log;
    console.log = () => {};
    await cmd.action({ dryRun: false, apply: true, limit: "1000" });
    console.log = originalLog;

    const obs = mockDb.getEntries().find((e) => e.id === obsId);
    expect(obs).toBeDefined();
    // 回填字段
    expect(obs!.metadata.projectPath).toBe("proj-x");
    expect(obs!.metadata.agentName).toBe("agent-x");
    // 原有字段保留（merge 不覆盖）
    expect(obs!.metadata.eventType).toBe("user_input");
    expect(obs!.metadata.sessionId).toBe("sess-123");
    expect(obs!.metadata.kind).toBe("observation");
  });

  it("apply 时若 db 不支持 updateMetadata 应友好报错", async () => {
    // 构造一个不实现 updateMetadata 的 db
    const dbWithoutUpdate: DatabaseProvider = {
      async initialize() {},
      async close() {},
      async store() {},
      async query() {
        return [
          {
            id: randomUUID(),
            text: "obs",
            contentHash: "h",
            vector: [0.1],
            importance: 0.5,
            category: "core",
            dataType: "memory",
            metadata: { kind: "observation", projectId: "p", agentId: "a" },
            createdAt: Date.now(),
            score: 0.9,
          } as MemoryEntry & { score: number },
        ];
      },
      async delete() {},
      async deleteByFilter() {
        return 0;
      },
      async existsByContentHash() {
        return [];
      },
      async count() {
        return 0;
      },
    };

    registerBackfillObservationMetadataCommand(mockCommander, { db: dbWithoutUpdate });
    const cmd = mockCommander._commands[0];

    let errorOutput = "";
    const originalError = console.error;
    const originalExitCode = process.exitCode;
    console.error = (...args: unknown[]) => {
      errorOutput += args.join(" ") + "\n";
    };

    await cmd.action({ dryRun: false, apply: true, limit: "1000" });

    console.error = originalError;
    expect(errorOutput).toContain("不支持 metadata 回填");
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});
