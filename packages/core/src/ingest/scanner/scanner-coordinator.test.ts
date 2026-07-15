import { describe, expect, test, vi } from "vitest";
import type { MemoryConfig } from "../../../../../config.js";
import type { DatabaseProvider, MemoryEntry } from "../../db/types.js";
import type { MemoryScope } from "../../domain/types.js";
import { createEmbeddingSpace } from "../../domain/embedding-space.js";
import {
  EmbeddingWriteGuard,
  type ActiveEmbeddingSpaceRegistryState,
} from "../../storage/embedding-space-policy.js";
import { ScannerCoordinator } from "./scanner-coordinator.js";

const config: MemoryConfig = {
  embedding: {
    provider: "openai",
    apiKey: "test-only",
    model: "text-embedding-3-small",
    baseURL: "https://api.openai.com/v1",
  },
};

const scope: MemoryScope = {
  tenantId: "tenant-scan",
  userId: "default",
  appId: "codex",
  projectId: "project-scan",
  agentId: "scanner",
  namespace: "knowledge",
  visibility: "workspace",
};

function makeDb(): DatabaseProvider {
  return {
    initialize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    store: vi.fn(async (entries) => ({
      inserted: entries.length,
      duplicates: 0,
      records: entries.map((entry: MemoryEntry) => ({
        requestedId: entry.id,
        persistedId: entry.id,
        stored: true,
      })),
    })),
    query: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
    deleteByFilter: vi.fn(async () => 0),
    existsByContentHash: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  };
}

const embeddingSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
  normalization: "none",
});

function gate(
  registry: ActiveEmbeddingSpaceRegistryState,
  enforcement: "enforced" | "legacy-write-through" = "enforced",
): EmbeddingWriteGuard {
  const guard = new EmbeddingWriteGuard(embeddingSpace, enforcement);
  guard.update(registry);
  return guard;
}

function legacyGate(): EmbeddingWriteGuard {
  return gate({ status: "unavailable" }, "legacy-write-through");
}

type ScannerInternals = {
  embeddings: { embedBatch(texts: string[]): Promise<number[][]> };
  fileScanner: { scan(directory: string): Promise<string[]> };
  markdownProcessor: {
    processFile(file: string): Promise<{
      chunks: string[];
      metadata: Record<string, unknown>;
    }>;
  };
  processChunkBatch(
    chunks: string[],
    metadata: Record<string, unknown>,
    filePath: string,
  ): Promise<{ stored: number; duplicates: number }>;
};

describe("ScannerCoordinator canonical authority scope", () => {
  test("scope 缺失时在 embedding/store 前 fail-closed", async () => {
    const db = makeDb();
    const coordinator = new ScannerCoordinator(config, db, {
      embeddingWriteGuard: legacyGate(),
    });
    const internals = coordinator as unknown as ScannerInternals;
    const embedBatch = vi.fn(async () => [[0.1, 0.2]]);
    internals.embeddings = { embedBatch };

    await expect(
      internals.processChunkBatch(["content"], {}, "/docs/a.md"),
    ).rejects.toThrow(/requires canonical authority scope/i);

    expect(embedBatch).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("每个 scanner 新写完整持久化 canonical scope，default user 也不省略", async () => {
    const db = makeDb();
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: legacyGate(),
    });
    const internals = coordinator as unknown as ScannerInternals;
    internals.embeddings = {
      embedBatch: vi.fn(async (texts) => texts.map(() => [0.1, 0.2])),
    };

    await expect(
      internals.processChunkBatch(["first", "second"], { language: "zh" }, "/docs/a.md"),
    ).resolves.toEqual({ stored: 2, duplicates: 0 });

    const [entries] = vi.mocked(db.store).mock.calls[0] as [MemoryEntry[]];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        tableName: "knowledge",
        dataType: "document",
        tenantId: "tenant-scan",
        userId: "default",
        canonicalProjectId: "project-scan",
        productId: "codex",
        producerId: "scanner",
        namespace: "knowledge",
        visibility: "workspace",
      });
    }
  });

  test("缺少显式 write gate 时构造即 fail-closed", () => {
    expect(() => new ScannerCoordinator(config, makeDb(), { scope } as never)).toThrow(/embedding write guard/i);
  });

  test.each([
    ["missing", { status: "missing" } as const, "registry-active-space-missing"],
    ["unavailable", { status: "unavailable" } as const, "registry-unavailable"],
    ["mismatch", {
      status: "ready",
      activeSpace: createEmbeddingSpace({
        ...embeddingSpace.fingerprint,
        model: "other-model",
      }),
    } as const, "active-space-mismatch"],
  ])("Postgres-like enforced gate %s 时 scan=0 embed/store", async (_name, registry, reasonCode) => {
    const db = makeDb();
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: gate(registry),
    });
    const internals = coordinator as unknown as ScannerInternals;
    const embedBatch = vi.fn(async () => [[0.1, 0.2]]);
    const scan = vi.fn(async () => ["/docs/a.md"]);
    internals.embeddings = { embedBatch };
    internals.fileScanner = { scan };

    await expect(coordinator.scanDirectory("/docs")).rejects.toMatchObject({ reasonCode });
    await expect(internals.processChunkBatch(["content"], {}, "/docs/a.md")).rejects.toMatchObject({ reasonCode });
    expect(scan).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(db.existsByContentHash).not.toHaveBeenCalled();
    expect(db.store).not.toHaveBeenCalled();
  });

  test("active match gate 正常 embedding/store", async () => {
    const db = makeDb();
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: gate({ status: "ready", activeSpace: embeddingSpace }),
    });
    const internals = coordinator as unknown as ScannerInternals;
    const embedBatch = vi.fn(async () => [[0.1, 0.2]]);
    internals.embeddings = { embedBatch };

    await expect(internals.processChunkBatch(["content"], {}, "/docs/a.md")).resolves.toEqual({
      stored: 1,
      duplicates: 0,
    });
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(db.store).toHaveBeenCalledTimes(1);
  });

  test("长扫描期间 registry 变化时下一 batch 立即阻断", async () => {
    const db = makeDb();
    const mutableGate = gate({ status: "ready", activeSpace: embeddingSpace });
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: mutableGate,
    });
    const internals = coordinator as unknown as ScannerInternals;
    const embedBatch = vi.fn(async () => [[0.1, 0.2]]);
    internals.embeddings = { embedBatch };

    await internals.processChunkBatch(["first"], {}, "/docs/a.md");
    mutableGate.update({ status: "missing" });
    await expect(internals.processChunkBatch(["second"], {}, "/docs/b.md")).rejects.toMatchObject({
      reasonCode: "registry-active-space-missing",
    });

    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(db.store).toHaveBeenCalledTimes(1);
  });

  test("active/legacy gate 下 scanDirectory 汇总成功文件并隔离单文件失败", async () => {
    const db = makeDb();
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      batchSize: 1,
      embeddingWriteGuard: legacyGate(),
    });
    const internals = coordinator as unknown as ScannerInternals;
    internals.fileScanner = { scan: vi.fn(async () => ["/docs/a.md", "/docs/b.md"]) };
    internals.markdownProcessor = {
      processFile: vi.fn(async (file) => {
        if (file.endsWith("b.md")) throw new Error("broken markdown");
        return { chunks: ["first", "second"], metadata: { language: "zh" } };
      }),
    };
    internals.embeddings = {
      embedBatch: vi.fn(async (texts) => texts.map(() => [0.1, 0.2])),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(coordinator.scanDirectory("/docs")).resolves.toEqual({
      directory: "/docs",
      totalFiles: 2,
      processedFiles: 1,
      totalChunks: 2,
      storedChunks: 2,
      duplicateChunks: 0,
      failedFiles: 1,
    });
    expect(db.store).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to process file /docs/b.md:",
      expect.objectContaining({ message: "broken markdown" }),
    );
    consoleError.mockRestore();
  });

  test("只做 batch 内局部 hash 去重，不调用全局 exists oracle", async () => {
    const db = makeDb();
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: legacyGate(),
      idFactory: (() => {
        let sequence = 0;
        return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
      })(),
    });
    const internals = coordinator as unknown as ScannerInternals;
    const embedBatch = vi.fn(async () => [[0.1, 0.2]]);
    internals.embeddings = { embedBatch };

    await expect(internals.processChunkBatch(["duplicate", "duplicate"], {}, "/docs/a.md")).resolves.toEqual({
      stored: 1,
      duplicates: 1,
    });
    expect(db.existsByContentHash).not.toHaveBeenCalled();
    expect(embedBatch).toHaveBeenCalledWith(["duplicate"]);
    expect(db.store).toHaveBeenCalledTimes(1);
  });

  test("消费 provider outcome 统计并保留 requested/persisted identity，不虚报并发 duplicate", async () => {
    const db = makeDb();
    vi.mocked(db.store).mockResolvedValue({
      inserted: 1,
      duplicates: 1,
      records: [
        { requestedId: "00000000-0000-4000-8000-000000000001", persistedId: "00000000-0000-4000-8000-000000000001", stored: true },
        { requestedId: "00000000-0000-4000-8000-000000000002", persistedId: "99999999-9999-4999-8999-999999999999", stored: false },
      ],
    });
    let sequence = 0;
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: legacyGate(),
      idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    });
    const internals = coordinator as unknown as ScannerInternals;
    internals.embeddings = { embedBatch: vi.fn(async () => [[0.1], [0.2]]) };

    await expect(internals.processChunkBatch(["first", "second"], {}, "/docs/a.md")).resolves.toEqual({
      stored: 1,
      duplicates: 1,
    });
    expect(db.existsByContentHash).not.toHaveBeenCalled();
  });

  test("provider outcome 计数与 record stored 标志矛盾时 fail-closed", async () => {
    const db = makeDb();
    vi.mocked(db.store).mockResolvedValue({
      inserted: 0,
      duplicates: 1,
      records: [{ requestedId: "00000000-0000-4000-8000-000000000001", persistedId: "existing", stored: true }],
    });
    const coordinator = new ScannerCoordinator(config, db, {
      scope,
      embeddingWriteGuard: legacyGate(),
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    });
    const internals = coordinator as unknown as ScannerInternals;
    internals.embeddings = { embedBatch: vi.fn(async () => [[0.1]]) };

    await expect(internals.processChunkBatch(["first"], {}, "/docs/a.md"))
      .rejects.toThrow(/inconsistent store outcome/i);
  });
});
