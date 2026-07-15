import { describe, expect, test } from "vitest";
import { createEmbeddingSpace } from "../../domain/embedding-space.js";
import {
  MARK_EMBEDDING_SPACE_QUERYABILITY_SQL,
  PostgresEmbeddingSpaceRegistryAdapter,
  READ_ACTIVE_EMBEDDING_SPACE_SQL,
  READ_ACTIVE_EMBEDDING_SPACE_FOR_SWITCH_SQL,
  READ_EMBEDDING_SPACE_BY_ID_SQL,
  SWITCH_ACTIVE_EMBEDDING_SPACE_SQL,
  type EmbeddingSpaceRegistryQueryClient,
  type EmbeddingSpaceRegistryQueryResult,
} from "./postgres-embedding-space-registry.js";
import { PostgresProvider } from "./postgres.js";

type Row = Record<string, unknown>;

class FakeClient implements EmbeddingSpaceRegistryQueryClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  activeRows: Row[] = [];
  descriptorRows: Row[] = [];
  async end(): Promise<void> {}
  releaseCount = 0;
  release(): void {
    this.releaseCount += 1;
  }

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<EmbeddingSpaceRegistryQueryResult<T>> {
    this.calls.push({ sql, params });
    if (sql === READ_ACTIVE_EMBEDDING_SPACE_SQL) {
      return { rows: this.activeRows as T[] };
    }
    if (sql === READ_ACTIVE_EMBEDDING_SPACE_FOR_SWITCH_SQL) {
      return { rows: this.activeRows as T[] };
    }
    if (sql === READ_EMBEDDING_SPACE_BY_ID_SQL) {
      return { rows: this.descriptorRows as T[] };
    }
    if (sql === MARK_EMBEDDING_SPACE_QUERYABILITY_SQL) {
      return { rows: [{ embedding_space_id: params[0] }] as unknown as T[], rowCount: 1 };
    }
    if (sql === SWITCH_ACTIVE_EMBEDDING_SPACE_SQL) {
      if (this.activeRows[0]?.embedding_space_id !== params[0]) {
        return { rows: [], rowCount: 0 };
      }
      this.activeRows = [...this.descriptorRows];
      return { rows: [{ embedding_space_id: params[1] }] as unknown as T[], rowCount: 1 };
    }
    return { rows: [] };
  }
}

class FakePool extends FakeClient {
  connectCount = 0;

  constructor(readonly dedicated: FakeClient) {
    super();
  }

  async connect(): Promise<FakeClient> {
    this.connectCount += 1;
    return this.dedicated;
  }
}

class SharedSwitchDatabase {
  current: Row;
  readonly descriptors = new Map<string, Row>();
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  constructor(initial: Row, target: Row) {
    this.current = initial;
    this.descriptors.set(String(initial.embedding_space_id), initial);
    this.descriptors.set(String(target.embedding_space_id), target);
  }

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  unlock(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

class ConcurrentSwitchClient implements EmbeddingSpaceRegistryQueryClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  private ownsLock = false;

  constructor(private readonly db: SharedSwitchDatabase) {}

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<EmbeddingSpaceRegistryQueryResult<T>> {
    this.calls.push({ sql, params });
    if (sql === READ_ACTIVE_EMBEDDING_SPACE_FOR_SWITCH_SQL) {
      await this.db.lock();
      this.ownsLock = true;
      return { rows: [this.db.current] as T[], rowCount: 1 };
    }
    if (sql === READ_ACTIVE_EMBEDDING_SPACE_SQL) {
      return { rows: [this.db.current] as T[], rowCount: 1 };
    }
    if (sql === READ_EMBEDDING_SPACE_BY_ID_SQL) {
      const row = this.db.descriptors.get(String(params[0]));
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }
    if (sql === MARK_EMBEDDING_SPACE_QUERYABILITY_SQL) {
      return { rows: [{ embedding_space_id: params[0] }] as unknown as T[], rowCount: 1 };
    }
    if (sql === SWITCH_ACTIVE_EMBEDDING_SPACE_SQL) {
      if (this.db.current.embedding_space_id !== params[0]) return { rows: [], rowCount: 0 };
      this.db.current = this.db.descriptors.get(String(params[1]))!;
      return { rows: [{ embedding_space_id: params[1] }] as unknown as T[], rowCount: 1 };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      if (this.ownsLock) {
        this.ownsLock = false;
        this.db.unlock();
      }
    }
    return { rows: [], rowCount: 0 };
  }
}

const space = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
  normalization: "none",
});

const targetSpace = createEmbeddingSpace({
  provider: "openai-compatible",
  baseURL: "https://api.siliconflow.cn/v1",
  model: "Qwen/Qwen3-Embedding-0.6B",
  dim: 1024,
  normalization: "none",
});

function rowFor(value = space): Row {
  return {
    embedding_space_id: value.embeddingSpaceId,
    provider: value.fingerprint.provider,
    base_url: value.fingerprint.baseURL,
    model: value.fingerprint.model,
    dimensions: value.fingerprint.dim,
    normalization: value.fingerprint.normalization,
    state: value.state,
  };
}

describe("PostgresEmbeddingSpaceRegistryAdapter", () => {
  test("读取空 active pointer 返回 null", async () => {
    const client = new FakeClient();
    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).readActive()).resolves.toBeNull();
  });

  test("读取并校验 active descriptor", async () => {
    const client = new FakeClient();
    client.activeRows = [rowFor()];

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).readActive()).resolves.toEqual(space);
  });

  test("active pointer 异常返回多行时 fail-closed", async () => {
    const client = new FakeClient();
    client.activeRows = [rowFor(), rowFor()];

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).readActive())
      .rejects.toThrow(/multiple rows/i);
  });

  test("descriptor fingerprint 与 ID 不一致时 fail-closed", async () => {
    const client = new FakeClient();
    client.activeRows = [{ ...rowFor(), model: "text-embedding-3-large" }];

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).readActive())
      .rejects.toThrow(/descriptor|fingerprint|embedding space/i);
  });

  test("注册 descriptor 和 singleton active pointer，且验证最终 active 未漂移", async () => {
    const client = new FakeClient();
    client.descriptorRows = [rowFor()];
    client.activeRows = [rowFor()];

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).registerActive(space))
      .resolves.toEqual(space);

    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
    expect(client.calls.some((call) => call.params.includes(space.embeddingSpaceId))).toBe(true);
  });

  test("同 fingerprint 但 persisted state 不一致时拒绝注册", async () => {
    const client = new FakeClient();
    client.descriptorRows = [{ ...rowFor(), state: "reembedded" }];
    client.activeRows = [{ ...rowFor(), state: "reembedded" }];

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).registerActive(space))
      .rejects.toThrow(/descriptor|state|mismatch/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("调用方 descriptor ID 被篡改时在 BEGIN 前拒绝", async () => {
    const client = new FakeClient();
    const invalid = {
      ...space,
      embeddingSpaceId: `${space.embeddingSpaceId.slice(0, -1)}0`,
    };

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).registerActive(invalid))
      .rejects.toThrow(/fingerprint\/ID mismatch/i);
    expect(client.calls).toEqual([]);
  });

  test("已有其它 active pointer 时 rollback 并拒绝覆盖", async () => {
    const other = createEmbeddingSpace({
      ...space.fingerprint,
      model: "text-embedding-3-large",
      dim: 3072,
    });
    const client = new FakeClient();
    client.descriptorRows = [rowFor()];
    client.activeRows = [rowFor(other)];

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).registerActive(space))
      .rejects.toThrow(/active|mismatch|冲突/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("PostgresProvider 读取可走 pool，注册事务只走 dedicated client 并 release", async () => {
    const dedicated = new FakeClient();
    dedicated.activeRows = [rowFor()];
    dedicated.descriptorRows = [rowFor()];
    const pool = new FakePool(dedicated);
    pool.activeRows = [rowFor()];
    const provider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");
    (provider as unknown as { pool: FakePool }).pool = pool;

    await expect(provider.getActiveEmbeddingSpace()).resolves.toEqual(space);
    await expect(provider.registerActiveEmbeddingSpace(space)).resolves.toEqual(space);

    expect(pool.connectCount).toBe(1);
    expect(pool.calls.map((call) => call.sql)).toEqual([READ_ACTIVE_EMBEDDING_SPACE_SQL]);
    expect(dedicated.calls[0]?.sql).toBe("BEGIN");
    expect(dedicated.calls.at(-1)?.sql).toBe("COMMIT");
    expect(dedicated.releaseCount).toBe(1);
  });

  test("PostgresProvider 注册失败时 dedicated client rollback 后仍 release", async () => {
    const other = createEmbeddingSpace({
      ...space.fingerprint,
      model: "text-embedding-3-large",
      dim: 3072,
    });
    const dedicated = new FakeClient();
    dedicated.descriptorRows = [rowFor()];
    dedicated.activeRows = [rowFor(other)];
    const pool = new FakePool(dedicated);
    const provider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");
    (provider as unknown as { pool: FakePool }).pool = pool;

    await expect(provider.registerActiveEmbeddingSpace(space)).rejects.toThrow(/active.*mismatch/i);

    expect(dedicated.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(dedicated.releaseCount).toBe(1);
  });

  test("显式 switch 在同一事务锁定 expected-current，将旧 space 降为 unknown 后切到 queryable target", async () => {
    const client = new FakeClient();
    client.activeRows = [rowFor(space)];
    client.descriptorRows = [rowFor(targetSpace)];
    const adapter = new PostgresEmbeddingSpaceRegistryAdapter(client);

    await expect(adapter.switchActive(space.embeddingSpaceId, targetSpace, {
      maintenance: true,
      quiescenceConfirmed: true,
    })).resolves.toEqual(targetSpace);

    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.some((call) => call.sql === READ_ACTIVE_EMBEDDING_SPACE_FOR_SWITCH_SQL))
      .toBe(true);
    expect(client.calls.filter((call) => call.sql === MARK_EMBEDDING_SPACE_QUERYABILITY_SQL)
      .map((call) => call.params)).toEqual([
      [space.embeddingSpaceId, "unknown-unqueryable"],
      [targetSpace.embeddingSpaceId, "known-queryable"],
    ]);
    expect(client.calls.some((call) =>
      call.sql === SWITCH_ACTIVE_EMBEDDING_SPACE_SQL &&
      call.params[0] === space.embeddingSpaceId &&
      call.params[1] === targetSpace.embeddingSpaceId)).toBe(true);
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("switch 必须 maintenance+quiescence，且错误/并发过期 expected-current 不能改 pointer", async () => {
    const other = createEmbeddingSpace({ ...space.fingerprint, model: "other-model" });
    const client = new FakeClient();
    client.activeRows = [rowFor(other)];
    client.descriptorRows = [rowFor(targetSpace)];
    const adapter = new PostgresEmbeddingSpaceRegistryAdapter(client);

    await expect(adapter.switchActive(space.embeddingSpaceId, targetSpace, {
      maintenance: true,
      quiescenceConfirmed: false,
    } as never)).rejects.toThrow(/maintenance|quiescence/i);
    expect(client.calls).toEqual([]);

    await expect(adapter.switchActive(space.embeddingSpaceId, targetSpace, {
      maintenance: true,
      quiescenceConfirmed: true,
    })).rejects.toThrow(/expected-current|changed/i);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some((call) => call.sql === SWITCH_ACTIVE_EMBEDDING_SPACE_SQL)).toBe(false);
  });

  test("两个并发 switch 在 FOR UPDATE 后只有一个能从同一 expected-current 提交", async () => {
    const shared = new SharedSwitchDatabase(rowFor(space), rowFor(targetSpace));
    const firstClient = new ConcurrentSwitchClient(shared);
    const secondClient = new ConcurrentSwitchClient(shared);
    const gate = { maintenance: true, quiescenceConfirmed: true } as const;

    const results = await Promise.allSettled([
      new PostgresEmbeddingSpaceRegistryAdapter(firstClient)
        .switchActive(space.embeddingSpaceId, targetSpace, gate),
      new PostgresEmbeddingSpaceRegistryAdapter(secondClient)
        .switchActive(space.embeddingSpaceId, targetSpace, gate),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/expected-current|changed/i);
    expect(shared.current.embedding_space_id).toBe(targetSpace.embeddingSpaceId);
    expect([...firstClient.calls, ...secondClient.calls]
      .filter((call) => call.sql === SWITCH_ACTIVE_EMBEDDING_SPACE_SQL)).toHaveLength(1);
  });

  test("switch target 不能用 reembedded 冒充可查询状态", async () => {
    const client = new FakeClient();
    const reembedded = createEmbeddingSpace(targetSpace.fingerprint, "reembedded");

    await expect(new PostgresEmbeddingSpaceRegistryAdapter(client).switchActive(
      space.embeddingSpaceId,
      reembedded,
      { maintenance: true, quiescenceConfirmed: true },
    )).rejects.toThrow(/known-queryable/i);
    expect(client.calls).toEqual([]);
  });

  test("PostgresProvider switch 只在 schema v12 上使用 dedicated client 并 release", async () => {
    const dedicated = new FakeClient();
    dedicated.activeRows = [rowFor(space)];
    dedicated.descriptorRows = [rowFor(targetSpace)];
    const pool = new FakePool(dedicated);
    const provider = new PostgresProvider({
      host: "unused", port: 5432, database: "unused", user: "unused", password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, { pool, schemaVersion: 12 });

    await expect(provider.switchActiveEmbeddingSpace(space.embeddingSpaceId, targetSpace, {
      maintenance: true,
      quiescenceConfirmed: true,
    })).resolves.toEqual(targetSpace);
    expect(pool.connectCount).toBe(1);
    expect(dedicated.releaseCount).toBe(1);
  });
});
