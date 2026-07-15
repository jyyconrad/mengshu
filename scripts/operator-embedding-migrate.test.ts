import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, test, vi } from "vitest";

import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";

import {
  OPERATOR_EMBEDDING_APPLY_TOKEN,
  OperatorEmbeddingMigrationError,
  classifyEmbeddingRow,
  createOperatorEmbeddingBatchProvider,
  loadOperatorEmbeddingManifest,
  runOperatorEmbeddingMigration,
  runOperatorEmbeddingMigrationCli,
  type OperatorEmbeddingCliDependencies,
  type OperatorEmbeddingClient,
  type OperatorEmbeddingManifest,
  type OperatorEmbeddingRow,
} from "./operator-embedding-migrate.js";

const vector = (first: number, second: number): number[] => [
  first,
  second,
  ...Array(1022).fill(0) as number[],
];
const qwen = vector(1, 0);
const bge = vector(0, 1);

const manifest: OperatorEmbeddingManifest = {
  version: 1,
  expected: {
    total: 4,
    validated: 2,
    reembed: 2,
    memories: 2,
    knowledge: 2,
  },
  expectedCurrentSpaceId: `embedding-space:v1:${"1".repeat(64)}`,
  target: {
    provider: "openai",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-Embedding-0.6B",
    dim: 1024,
    normalization: "none",
  },
  centroidMargin: 0.1,
  scanBatchSize: 2,
  apiBatchSize: 2,
};

const record = (
  table: "memories" | "knowledge",
  index: number,
  overrides: Partial<OperatorEmbeddingRow> = {},
): OperatorEmbeddingRow => ({
  table,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  text: `secret-text-${index}`,
  contentHash: String(index).padStart(64, "a"),
  vector: table === "memories" ? qwen : vector(0.99, 0.01),
  metadata: { embeddingModel: "Qwen/Qwen3-Embedding-0.6B" },
  embeddingSpaceId: null,
  embeddingSpaceState: null,
  receiptOperation: null,
  ...overrides,
});

function manifestText(value: unknown = manifest): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function configText(): string {
  return JSON.stringify({
    embedding: {
      provider: "openai",
      apiKey: "${MENGSHU_MIGRATION_TEST_KEY}",
      baseURL: "${MENGSHU_MIGRATION_TEST_URL}",
      model: "BAAI/bge-m3",
    },
    dbType: "postgres",
    postgres: {
      host: "localhost",
      port: 5432,
      database: "mengshu",
      user: "mengshu",
      password: "${MENGSHU_MIGRATION_TEST_PG_PASSWORD}",
      ssl: false,
    },
    llm: {
      provider: "openai",
      apiKey: "${DEEPSEEK_API_KEY}",
      model: "unused-by-embedding-migration",
    },
  });
}

function withCliFiles(run: (paths: { config: string; manifest: string }) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "mengshu-embedding-migration-"));
  const config = join(directory, "config.json");
  const manifestPath = join(directory, "manifest.json");
  writeFileSync(config, configText(), "utf8");
  writeFileSync(manifestPath, manifestText(), "utf8");
  return run({ config, manifest: manifestPath }).finally(() => rmSync(directory, { recursive: true }));
}

type StoredRow = OperatorEmbeddingRow;

class FakeClient implements OperatorEmbeddingClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly shadow = new Map<string, StoredRow>();
  readonly receipts = new Map<string, "validated" | "applied">();
  readonly rows: StoredRow[];
  descriptorInserted = false;
  driftRecordId: string | null = null;
  driftMetadataRecordId: string | null = null;
  transactionOpen = false;
  corruptVerification = false;
  invalidClassificationTable = false;
  validatedBulkDrift = false;
  invalidReembedText = false;

  constructor(rows: StoredRow[]) {
    this.rows = rows;
  }

  private source(row: StoredRow): StoredRow {
    return this.shadow.get(`${row.table}:${row.id}`) ?? row;
  }

  private model(row: StoredRow): string {
    const source = this.source(row);
    const values = new Set(
      ["embeddingModel", "embedding_model", "model", "modelName"]
        .map((key) => source.metadata[key])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    );
    return values.size === 1 ? [...values][0]!.toLowerCase() : "";
  }

  private centroids(): { qwen: number[]; bge: number[] } | null {
    const memories = this.rows.filter((row) => row.table === "memories");
    const average = (matching: StoredRow[]): number[] | null => {
      if (matching.length === 0) return null;
      return Array.from({ length: 1024 }, (_, index) =>
        matching.reduce((sum, row) => sum + this.source(row).vector[index]!, 0) / matching.length);
    };
    const qwenCentroid = average(memories.filter((row) => this.model(row).includes("qwen")));
    const bgeCentroid = average(memories.filter((row) => this.model(row).includes("bge")));
    return qwenCentroid && bgeCentroid ? { qwen: qwenCentroid, bge: bgeCentroid } : null;
  }

  private classified(table: "memories" | "knowledge"): Array<{
    row: StoredRow;
    operation: "validated" | "reembed";
    receipt: "validated" | "applied" | null;
  }> {
    const centroids = this.centroids();
    return this.rows.filter((row) => row.table === table).map((row) => {
      const source = this.source(row);
      const receipt = this.receipts.get(`${table}:${row.id}`) ?? row.receiptOperation;
      const classification = classifyEmbeddingRow({ ...source, receiptOperation: receipt }, centroids, 0.1);
      return { row, operation: classification.operation, receipt };
    });
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.calls.push({ sql, params });
    if (sql === "BEGIN") this.transactionOpen = true;
    if (sql === "COMMIT" || sql === "ROLLBACK") this.transactionOpen = false;
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("embedding-migrate:classify")) {
      const rows = (["memories", "knowledge"] as const).map((table) => {
        const classified = this.classified(table);
        return {
          table_name: table,
          total_count: classified.length,
          validated_count: classified.filter((item) => item.operation === "validated").length,
          reembed_count: classified.filter((item) => item.operation === "reembed").length,
          already_migrated_count: classified.filter((item) => item.receipt !== null).length,
        };
      }).filter((row) => row.total_count > 0);
      if (this.invalidClassificationTable && rows[0]) rows[0].table_name = "invalid" as "memories";
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    if (sql.includes("embedding-migrate:validated-bulk")) {
      const table = sql.includes('UPDATE "memories"') ? "memories" : "knowledge";
      const target = params[2] as string;
      const eligible = this.classified(table).filter((item) =>
        item.receipt === null && item.operation === "validated");
      const appliedEligible = this.validatedBulkDrift ? eligible.slice(0, -1) : eligible;
      for (const { row } of appliedEligible) {
        row.embeddingSpaceId = target;
        row.embeddingSpaceState = "known-queryable";
        row.metadata = {
          ...row.metadata,
          embeddingSpaceId: target,
          embeddingSpaceState: "known-queryable",
          embedding_space_id: target,
          embedding_space_state: "known-queryable",
        };
        this.receipts.set(`${table}:${row.id}`, "validated");
      }
      return { rows: [{
        eligible_count: eligible.length,
        updated_count: appliedEligible.length,
        receipt_count: appliedEligible.length,
      }] as unknown as Row[], rowCount: 1 };
    }
    if (sql.includes("embedding-migrate:reembed-scan")) {
      const table = sql.includes('JOIN "memories" record') ? "memories" : "knowledge";
      const afterId = params[2] as string | null;
      const limit = params[3] as number;
      const selected = this.classified(table)
        .filter((item) => item.receipt === null && item.operation === "reembed")
        .map(({ row }) => this.source(row))
        .filter((row) => !afterId || row.id > afterId)
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          text: this.invalidReembedText ? null : row.text,
          content_hash: row.contentHash,
          vector: `[${row.vector.join(",")}]`,
          metadata: row.metadata,
          embedding_space_id: row.embeddingSpaceId,
          embedding_space_state: row.embeddingSpaceState,
          receipt_operation: null,
        }));
      return { rows: selected as unknown as Row[], rowCount: selected.length };
    }
    if (sql.includes("embedding-migrate:scan")) {
      const table = params[0] as "memories" | "knowledge";
      const afterId = params[2] as string | null;
      const limit = params[3] as number;
      const result = this.rows
        .filter((row) => row.table === table && (!afterId || row.id > afterId))
        .slice(0, limit)
        .map((row) => ({
        id: row.id,
        text: row.text,
        content_hash: row.contentHash,
        vector: `[${row.vector.join(",")}]`,
        metadata: row.metadata,
        embedding_space_id: row.embeddingSpaceId,
        embedding_space_state: row.embeddingSpaceState,
        receipt_operation: this.receipts.get(`${table}:${row.id}`) ?? row.receiptOperation,
      }));
      return { rows: result as unknown as Row[], rowCount: result.length };
    }
    if (sql.includes("embedding-migrate:descriptor")) {
      this.descriptorInserted = true;
      return { rows: [{
        embedding_space_id: params[0],
        provider: params[1],
        base_url: params[2],
        model: params[3],
        dimensions: params[4],
        normalization: params[5],
        state: "known-queryable",
      }] as unknown as Row[], rowCount: 1 };
    }
    if (sql.includes("embedding-migrate:shadow")) {
      const table = params[1] as "memories" | "knowledge";
      let inserted = 0;
      for (const source of this.rows.filter((row) => row.table === table)) {
        const key = `${table}:${source.id}`;
        if (!this.shadow.has(key)) {
          this.shadow.set(key, { ...source });
          inserted += 1;
        }
      }
      const total = this.rows.filter((row) => row.table === table).length;
      return { rows: [{
        inserted_count: inserted,
        captured_count: total,
        total_count: total,
      }] as unknown as Row[], rowCount: 1 };
    }
    if (sql.includes("embedding-migrate:lock")) {
      const table = params[0] as "memories" | "knowledge";
      const ids = JSON.parse(params[1] as string) as Array<{ id: string }>;
      const locked = ids.map(({ id }) => {
        const source = this.rows.find((row) => row.table === table && row.id === id)!;
        return {
          id,
          content_hash: this.driftRecordId === id ? "f".repeat(64) : source.contentHash,
          vector: `[${source.vector.join(",")}]`,
          metadata: this.driftMetadataRecordId === id
            ? { ...source.metadata, concurrent: true }
            : source.metadata,
          embedding_space_id: source.embeddingSpaceId,
          embedding_space_state: source.embeddingSpaceState,
        };
      });
      return {
        rows: locked as unknown as Row[],
        rowCount: locked.length,
      };
    }
    if (sql.includes("embedding-migrate:update")) {
      const table = params[0] as "memories" | "knowledge";
      const updates = JSON.parse(params[1] as string) as Array<{
        id: string;
        operation: "validated" | "applied";
        vector: string | null;
        embedding_space_id: string;
        metadata: Record<string, unknown>;
      }>;
      for (const update of updates) {
        const source = this.rows.find((row) => row.table === table && row.id === update.id)!;
        if (update.operation === "applied" && update.vector) {
          source.vector = JSON.parse(update.vector) as number[];
        }
        source.embeddingSpaceId = update.embedding_space_id;
        source.embeddingSpaceState = "known-queryable";
        source.metadata = update.metadata;
      }
      return { rows: updates.map(({ id }) => ({ id })) as unknown as Row[], rowCount: updates.length };
    }
    if (sql.includes("embedding-migrate:receipt")) {
      const table = params[0] as "memories" | "knowledge";
      const receipts = JSON.parse(params[1] as string) as Array<{
        record_id: string;
        operation: "validated" | "applied";
      }>;
      for (const receipt of receipts) {
        this.receipts.set(`${table}:${receipt.record_id}`, receipt.operation);
      }
      return {
        rows: receipts.map(({ record_id }) => ({ record_id })) as unknown as Row[],
        rowCount: receipts.length,
      };
    }
    if (sql.includes("embedding-migrate:verify")) {
      const table = params[0] as "memories" | "knowledge";
      const target = params[2] as string;
      const rows = this.rows.filter((row) => row.table === table);
      const operations = rows.map((row) => this.receipts.get(`${table}:${row.id}`));
      const stamped = rows.filter((row) =>
        row.embeddingSpaceId === target &&
        row.embeddingSpaceState === "known-queryable" &&
        row.metadata.embeddingSpaceId === target &&
        row.metadata.embeddingSpaceState === "known-queryable").length;
      return { rows: [{
        total_count: rows.length,
        stamped_count: this.corruptVerification ? stamped - 1 : stamped,
        exact_receipt_rows: operations.filter(Boolean).length,
        validated_count: operations.filter((item) => item === "validated").length,
        applied_count: operations.filter((item) => item === "applied").length,
      }] as unknown as Row[], rowCount: 1 };
    }
    throw new Error("unexpected fake query");
  }
}

function fixtureRows(): StoredRow[] {
  return [
    record("memories", 1, { contentHash: "a".repeat(32) }),
    record("memories", 2, {
      contentHash: "123e4567-e89b-12d3-a456-426614174000",
      vector: bge,
      metadata: { embeddingModel: "BAAI/bge-m3" },
    }),
    record("knowledge", 3, {
      id: "00000000-0000-8000-8000-000000000003",
    }),
    record("knowledge", 4, {
      text: "",
      vector: vector(0.01, 0.99),
      metadata: { embeddingModel: "text-embedding-3-small" },
    }),
  ];
}

describe("operator embedding migration", () => {
  test("manifest 固定目标 Qwen 1024，并以原始文件 SHA 作为 apply 权限边界", () => {
    const loaded = loadOperatorEmbeddingManifest(manifestText());
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.sha256).toBe(createHash("sha256").update(manifestText()).digest("hex"));

    for (const invalid of [
      { ...manifest, target: { ...manifest.target, model: "other" } },
      { ...manifest, target: { ...manifest.target, dim: 768 } },
      { ...manifest, centroidMargin: 0.09 },
      { ...manifest, expected: { ...manifest.expected, total: 5 } },
      { ...manifest, apiBatchSize: 21 },
      { ...manifest, scanBatchSize: 1001 },
      { ...manifest, expectedCurrentSpaceId: "embedding-space:v1:invalid" },
      { ...manifest, target: { ...manifest.target, provider: "INVALID PROVIDER" } },
      { ...manifest, target: { ...manifest.target, provider: "siliconflow" } },
    ]) {
      expect(() => loadOperatorEmbeddingManifest(manifestText(invalid))).toThrow(
        OperatorEmbeddingMigrationError,
      );
    }
  });

  test("分类规则对 memories、显式 Qwen 与 legacy OpenAI centroid 保持 fail-closed", () => {
    const centroids = { qwen, bge };
    expect(classifyEmbeddingRow(record("memories", 1), centroids, 0.1).operation)
      .toBe("validated");
    expect(classifyEmbeddingRow(record("memories", 2, {
      metadata: { embeddingModel: "BAAI/bge-m3" },
    }), centroids, 0.1).operation).toBe("reembed");
    expect(classifyEmbeddingRow(record("knowledge", 3), centroids, 0.1).operation)
      .toBe("validated");
    expect(classifyEmbeddingRow(record("knowledge", 4, {
      vector: vector(0.52, 0.48),
      metadata: { embeddingModel: "text-embedding-3-small" },
    }), centroids, 0.1).operation).toBe("reembed");
    expect(classifyEmbeddingRow(record("knowledge", 5, {
      vector: vector(0.9, 0.1),
      metadata: { embeddingModel: "text-embedding-3-small" },
    }), centroids, 0.1).operation).toBe("validated");
    expect(classifyEmbeddingRow(record("knowledge", 6, {
      metadata: { embeddingModel: "text-embedding-3-small" },
    }), null, 0.1).operation).toBe("reembed");
  });

  test("默认 dry-run 只读取并核验真实期望数，不输出正文、metadata 或连接信息", async () => {
    const client = new FakeClient(fixtureRows());
    const result = await runOperatorEmbeddingMigration(client, manifest, "a".repeat(64));

    expect(result).toEqual({
      mode: "dry-run",
      total: 4,
      validated: 2,
      reembed: 2,
      alreadyMigrated: 0,
      shadowCaptured: 0,
      updated: 0,
      activeSwitch: "pending",
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("embedding-migrate:classify");
    expect(client.calls[0]?.sql).not.toMatch(/r\.text|vector::text/i);
    expect(JSON.stringify(result)).not.toMatch(/secret|metadata|password|host|baseURL/i);

    const untouched = new FakeClient(fixtureRows());
    await expect(runOperatorEmbeddingMigration(untouched, manifest, "not-a-sha"))
      .rejects.toMatchObject({ code: "INVALID_MANIFEST_SHA" });
    expect(untouched.calls).toEqual([]);

    const invalidAggregate = new FakeClient(fixtureRows());
    invalidAggregate.invalidClassificationTable = true;
    await expect(runOperatorEmbeddingMigration(invalidAggregate, manifest, "1".repeat(64)))
      .rejects.toMatchObject({ code: "INVALID_ROW" });
  });

  test("apply 在任何数据库写入前校验四重 gate 与 embedder target fingerprint", async () => {
    const client = new FakeClient(fixtureRows());
    const embedder = {
      target: manifest.target,
      embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => Array(1024).fill(0.01))),
    };
    const base = {
      mode: "apply" as const,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "a".repeat(64),
      embedder,
    };
    for (const options of [
      { ...base, maintenance: false },
      { ...base, quiescenceConfirmed: false },
      { ...base, confirmationToken: "wrong" },
      { ...base, expectedManifestSha256: "b".repeat(64) },
      { ...base, embedder: { ...embedder, target: { ...manifest.target, model: "wrong" } } },
    ]) {
      await expect(
        runOperatorEmbeddingMigration(client, manifest, "a".repeat(64), options),
      ).rejects.toBeInstanceOf(OperatorEmbeddingMigrationError);
    }
    expect(client.calls).toEqual([]);
  });

  test("apply 先为所有行建 shadow，validated 不调用模型，reembed 在事务外批量调用模型", async () => {
    const client = new FakeClient(fixtureRows());
    const embedder = {
      target: manifest.target,
      embedBatch: vi.fn(async (texts: readonly string[]) => {
        expect(client.transactionOpen).toBe(false);
        return texts.map(() => Array(1024).fill(0.01));
      }),
    };

    const result = await runOperatorEmbeddingMigration(client, manifest, "c".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "c".repeat(64),
      embedder,
    });

    expect(result).toMatchObject({ shadowCaptured: 4, updated: 4, activeSwitch: "pending" });
    expect(client.shadow.size).toBe(4);
    expect(client.shadow.get("memories:00000000-0000-4000-8000-000000000001")?.contentHash)
      .toBe("a".repeat(32));
    expect(client.rows[0]?.contentHash).toBe("a".repeat(32));
    expect(client.rows[1]?.contentHash).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(embedder.embedBatch).toHaveBeenCalledTimes(2);
    expect(embedder.embedBatch.mock.calls.every(([texts]) => texts.length === 1)).toBe(true);
    expect(embedder.embedBatch.mock.calls.flatMap(([texts]) => [...texts])).toContain("");
    expect(client.calls.filter(({ sql }) => sql.includes("embedding-migrate:lock"))).toHaveLength(2);
    expect(client.calls.filter(({ sql }) => sql.includes("embedding-migrate:update"))).toHaveLength(2);
    expect(client.calls.filter(({ sql }) => sql.includes("embedding-migrate:receipt"))).toHaveLength(2);
    expect(client.calls.filter(({ sql }) => sql.includes("embedding-migrate:validated-bulk")))
      .toHaveLength(2);
    expect(client.calls.filter(({ sql }) => sql.includes("embedding-migrate:reembed-scan")))
      .toHaveLength(2);
    const classifySql = client.calls.find(({ sql }) => sql.includes("embedding-migrate:classify"))?.sql ?? "";
    expect(classifySql).toMatch(/AVG\(source_vector\)[\s\S]+embeddingModel[\s\S]+embedding_model[\s\S]+modelName/);
    expect(classifySql).toContain("<=>");
    const validatedSql = client.calls.find(({ sql }) =>
      sql.includes("embedding-migrate:validated-bulk"))?.sql ?? "";
    expect(validatedSql).toMatch(/sha256[\s\S]+record\.vector::text/);
    expect(validatedSql).not.toMatch(/SELECT[\s\S]+record\.text/);
    expect(validatedSql).toMatch(/record\.content_hash = eligible\.source_content_hash/);
    expect(validatedSql).toMatch(/record\.metadata = eligible\.old_metadata/);
    expect(validatedSql).toMatch(/eligible_count[\s\S]+updated_count/);
    const verifySql = client.calls.find(({ sql }) => sql.includes("embedding-migrate:verify"))?.sql ?? "";
    expect(verifySql).toContain("target_vector_sha256");
    expect(verifySql).toContain("source_snapshot_sha256");
    expect(verifySql).toContain("checksum_count");
    expect(client.receipts).toEqual(new Map([
      ["memories:00000000-0000-4000-8000-000000000001", "validated"],
      ["memories:00000000-0000-4000-8000-000000000002", "applied"],
      ["knowledge:00000000-0000-8000-8000-000000000003", "validated"],
      ["knowledge:00000000-0000-4000-8000-000000000004", "applied"],
    ]));
    expect(client.rows.every((item) => item.embeddingSpaceState === "known-queryable")).toBe(true);
    expect(client.rows.every((item) => item.metadata.embeddingSpaceState === "known-queryable"))
      .toBe(true);
  });

  test("PostgreSQL scan batch 与 remote API batch 分离，单次模型请求永不超过 manifest 上限", async () => {
    const apiManifest: OperatorEmbeddingManifest = {
      ...manifest,
      expected: { total: 4, validated: 1, reembed: 3, memories: 4, knowledge: 0 },
      scanBatchSize: 4,
      apiBatchSize: 2,
    };
    const client = new FakeClient([
      record("memories", 1),
      ...[2, 3, 4].map((index) => record("memories", index, {
        vector: bge,
        metadata: { embeddingModel: "BAAI/bge-m3" },
      })),
    ]);
    const embedBatch = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => Array(1024).fill(0.01)));
    await runOperatorEmbeddingMigration(client, apiManifest, "7".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "7".repeat(64),
      embedder: { target: manifest.target, embedBatch },
    });
    expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([2, 1]);
    expect(client.calls.filter(({ sql }) => sql.includes("embedding-migrate:update"))).toHaveLength(1);
  });

  test("reembed 事务内发现 content_hash/vector 漂移即回滚，不写 receipt", async () => {
    const client = new FakeClient(fixtureRows());
    client.driftRecordId = "00000000-0000-4000-8000-000000000002";
    const embedder = {
      target: manifest.target,
      embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => Array(1024).fill(0.01))),
    };
    await expect(runOperatorEmbeddingMigration(client, manifest, "d".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "d".repeat(64),
      embedder,
    })).rejects.toThrow(/drift/i);
    expect(client.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(client.receipts.has("memories:00000000-0000-4000-8000-000000000002"))
      .toBe(false);

    const metadataDrift = new FakeClient(fixtureRows());
    metadataDrift.driftMetadataRecordId = "00000000-0000-4000-8000-000000000002";
    await expect(runOperatorEmbeddingMigration(metadataDrift, manifest, "d".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "d".repeat(64),
      embedder,
    })).rejects.toThrow(/drift/i);
    expect(metadataDrift.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
  });

  test("相同 manifest 可重跑；已有 receipt 维持原分类且不再调用模型", async () => {
    const client = new FakeClient(fixtureRows());
    const embedder = {
      target: manifest.target,
      embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(() => Array(1024).fill(0.01))),
    };
    const options = {
      mode: "apply" as const,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "e".repeat(64),
      embedder,
    };
    await runOperatorEmbeddingMigration(client, manifest, "e".repeat(64), options);
    embedder.embedBatch.mockClear();
    const second = await runOperatorEmbeddingMigration(client, manifest, "e".repeat(64), options);
    expect(second).toMatchObject({ alreadyMigrated: 4, updated: 0 });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  test("全部成功后才通过显式 foundation capability 切换 active space", async () => {
    const client = new FakeClient(fixtureRows());
    const switchActive = vi.fn(async () => undefined);
    const result = await runOperatorEmbeddingMigration(client, manifest, "f".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "f".repeat(64),
      embedder: {
        target: manifest.target,
        embedBatch: async (texts) => texts.map(() => Array(1024).fill(0.01)),
      },
      switchActive,
    });
    expect(result.activeSwitch).toBe("completed");
    expect(switchActive).toHaveBeenCalledWith(expect.objectContaining({
      maintenance: true,
      quiescenceConfirmed: true,
    }));
  });

  test("安全 CLI 默认 READ ONLY dry-run，并解析 config 环境变量但不回显密钥", async () => {
    vi.stubEnv("MENGSHU_MIGRATION_TEST_KEY", "migration-test-secret");
    vi.stubEnv("MENGSHU_MIGRATION_TEST_URL", manifest.target.baseURL);
    vi.stubEnv("MENGSHU_MIGRATION_TEST_PG_PASSWORD", "postgres-test-secret");
    await withCliFiles(async (paths) => {
      const client = new FakeClient(fixtureRows());
      let connectedEmbeddingKey: string | undefined;
      let connectedPostgresPassword: string | undefined;
      const close = vi.fn(async () => undefined);
      const dependencies: OperatorEmbeddingCliDependencies = {
        connect: async (config) => {
          connectedEmbeddingKey = config.embedding.apiKey;
          connectedPostgresPassword = config.postgres?.password;
          return { client, close };
        },
        createEmbedder: vi.fn(() => { throw new Error("dry-run must not create embedder"); }),
        switchActive: vi.fn(async () => { throw new Error("dry-run must not switch"); }),
      };
      const report = await runOperatorEmbeddingMigrationCli([
        "--config", paths.config,
        "--manifest", paths.manifest,
      ], dependencies);
      expect(report.mode).toBe("dry-run");
      expect(connectedEmbeddingKey).toBe("migration-test-secret");
      expect(connectedPostgresPassword).toBe("postgres-test-secret");
      expect(client.calls[0]?.sql).toBe("BEGIN READ ONLY");
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(JSON.stringify(report)).not.toMatch(/migration-test-secret|postgres-test-secret/);
      expect(close).toHaveBeenCalledOnce();
    });
    vi.unstubAllEnvs();
  });

  test("CLI unresolved placeholder 在连接数据库前 fail-closed", async () => {
    vi.stubEnv("MENGSHU_MIGRATION_TEST_URL", manifest.target.baseURL);
    const connect = vi.fn<OperatorEmbeddingCliDependencies["connect"]>();
    await withCliFiles(async (paths) => {
      await expect(runOperatorEmbeddingMigrationCli([
        "--config", paths.config,
        "--manifest", paths.manifest,
      ], {
        connect,
        createEmbedder: vi.fn(),
        switchActive: vi.fn(),
      })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    });
    expect(connect).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  test("旧 config BGE 只提供密钥与同一 endpoint，实际 embedder 固定使用 manifest Qwen target", () => {
    const provider = createOperatorEmbeddingBatchProvider({
      embedding: {
        provider: "openai",
        apiKey: "migration-test-secret",
        baseURL: "https://api.siliconflow.cn/v1/",
        model: "BAAI/bge-m3",
      },
      dbType: "postgres",
      postgres: {
        host: "localhost",
        port: 5432,
        database: "mengshu",
        user: "mengshu",
        password: "postgres-test-secret",
      },
    }, manifest);
    expect(provider.target).toEqual(manifest.target);
    expect(provider.target.model).toBe("Qwen/Qwen3-Embedding-0.6B");
    expect(() => createOperatorEmbeddingBatchProvider({
      embedding: {
        provider: "openai",
        apiKey: "migration-test-secret",
        baseURL: "https://different.invalid/v1",
        model: "BAAI/bge-m3",
      },
      dbType: "postgres",
      postgres: {
        host: "localhost", port: 5432, database: "mengshu", user: "mengshu", password: "secret",
      },
    }, manifest)).toThrow(/endpoint/i);
  });

  test("CLI apply 只把 manifest 固定 expectedCurrentSpaceId 交给 foundation switch", async () => {
    vi.stubEnv("MENGSHU_MIGRATION_TEST_KEY", "migration-test-secret");
    vi.stubEnv("MENGSHU_MIGRATION_TEST_URL", manifest.target.baseURL);
    vi.stubEnv("MENGSHU_MIGRATION_TEST_PG_PASSWORD", "postgres-test-secret");
    await withCliFiles(async (paths) => {
      const client = new FakeClient(fixtureRows());
      const switchActive = vi.fn(async () => undefined);
      const sha = createHash("sha256").update(manifestText()).digest("hex");
      const report = await runOperatorEmbeddingMigrationCli([
        "--config", paths.config,
        "--manifest", paths.manifest,
        "--apply",
        "--maintenance",
        "--quiescence-confirmed",
        "--confirmation-token", OPERATOR_EMBEDDING_APPLY_TOKEN,
        "--manifest-sha256", sha,
      ], {
        connect: async () => ({ client, close: async () => undefined }),
        createEmbedder: () => ({
          target: manifest.target,
          embedBatch: async (texts) => texts.map(() => Array(1024).fill(0.01)),
        }),
        switchActive,
      });
      expect(report.activeSwitch).toBe("completed");
      expect(switchActive).toHaveBeenCalledWith(
        expect.anything(),
        manifest.expectedCurrentSpaceId,
        expect.objectContaining({ embeddingSpaceId: expect.stringContaining("embedding-space:v1:") }),
      );
    });
    vi.unstubAllEnvs();
  });

  test("embedding provider 失败或 target mismatch 时绝不切换 active", async () => {
    const switchActive = vi.fn(async () => undefined);
    const base = {
      mode: "apply" as const,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "9".repeat(64),
      switchActive,
    };
    await expect(runOperatorEmbeddingMigration(
      new FakeClient(fixtureRows()),
      manifest,
      "9".repeat(64),
      {
        ...base,
        embedder: {
          target: { ...manifest.target, baseURL: "https://mismatch.invalid/v1" },
          embedBatch: async () => [],
        },
      },
    )).rejects.toMatchObject({ code: "EMBEDDER_TARGET_MISMATCH" });
    expect(switchActive).not.toHaveBeenCalled();

    await expect(runOperatorEmbeddingMigration(
      new FakeClient(fixtureRows()),
      manifest,
      "9".repeat(64),
      {
        ...base,
        embedder: {
          target: manifest.target,
          embedBatch: async () => { throw new Error("provider included sensitive payload"); },
        },
      },
    )).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    expect(switchActive).not.toHaveBeenCalled();

    await expect(runOperatorEmbeddingMigration(
      new FakeClient(fixtureRows()),
      manifest,
      "9".repeat(64),
      {
        ...base,
        embedder: {
          target: manifest.target,
          embedBatch: async () => [],
        },
      },
    )).rejects.toMatchObject({ code: "EMBEDDING_BATCH_INVALID" });
    expect(switchActive).not.toHaveBeenCalled();
  });

  test("server-side post-apply 独立列/metadata/receipt 验收失败时绝不切换", async () => {
    const client = new FakeClient(fixtureRows());
    client.corruptVerification = true;
    const switchActive = vi.fn(async () => undefined);
    await expect(runOperatorEmbeddingMigration(client, manifest, "8".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "8".repeat(64),
      embedder: {
        target: manifest.target,
        embedBatch: async (texts) => texts.map(() => Array(1024).fill(0.01)),
      },
      switchActive,
    })).rejects.toMatchObject({ code: "POST_APPLY_VERIFICATION_FAILED" });
    expect(switchActive).not.toHaveBeenCalled();
  });

  test("validated server bulk 的shadow全字段CAS数量不一致即回滚且不切换", async () => {
    const client = new FakeClient(fixtureRows());
    client.validatedBulkDrift = true;
    const switchActive = vi.fn(async () => undefined);
    await expect(runOperatorEmbeddingMigration(client, manifest, "6".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "6".repeat(64),
      embedder: {
        target: manifest.target,
        embedBatch: async (texts) => texts.map(() => Array(1024).fill(0.01)),
      },
      switchActive,
    })).rejects.toMatchObject({ code: "SOURCE_DRIFT" });
    expect(client.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(switchActive).not.toHaveBeenCalled();
  });

  test("document空文本允许reembed，但null/非字符串仍fail-closed", async () => {
    const client = new FakeClient(fixtureRows());
    client.invalidReembedText = true;
    await expect(runOperatorEmbeddingMigration(client, manifest, "5".repeat(64), {
      mode: "apply",
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
      expectedManifestSha256: "5".repeat(64),
      embedder: {
        target: manifest.target,
        embedBatch: async (texts) => texts.map(() => Array(1024).fill(0.01)),
      },
    })).rejects.toMatchObject({ code: "INVALID_ROW" });
  });
});

const operatorLiveEnabled = process.env.MENGSHU_RUN_OPERATOR_EMBEDDING_LIVE === "1";

describe.skipIf(!operatorLiveEnabled)("operator embedding migration PostgreSQL live", () => {
  test("server classification + validated bulk + reembed-only network path", async () => {
    const database = process.env.MENGSHU_LIVE_PG_DATABASE ?? "";
    const port = Number(process.env.MENGSHU_LIVE_PG_PORT);
    if (
      !/^mengshu_live_[a-z0-9_]+$/.test(database) ||
      process.env.MENGSHU_LIVE_PG_ALLOW_RESET !== "1" ||
      !Number.isSafeInteger(port)
    ) {
      throw new Error("operator live test requires an explicitly resettable mengshu_live_* database");
    }
    const config = {
      host: process.env.MENGSHU_LIVE_PG_HOST ?? "",
      port,
      database,
      user: process.env.MENGSHU_LIVE_PG_USER ?? "",
      password: process.env.MENGSHU_LIVE_PG_PASSWORD ?? "",
      ssl: false as const,
    };
    const reset = new pg.Client(config);
    await reset.connect();
    await reset.query("DROP SCHEMA public CASCADE");
    await reset.query("CREATE SCHEMA public AUTHORIZATION CURRENT_USER");
    await reset.end();

    const provider = new PostgresProvider(config, "BAAI/bge-m3");
    await provider.initialize();
    await provider.applyScopeContentHashDedupeContract({
      maintenance: true,
      quiescenceConfirmed: true,
    });
    await provider.close();

    const client = new pg.Client(config);
    await client.connect();
    try {
      const insert = async (
        table: "memories" | "knowledge",
        id: string,
        contentHash: string,
        model: string,
        value: readonly number[],
      ) => client.query(`INSERT INTO "${table}" (
        id, text, content_hash, vector, metadata,
        tenant_id, user_id, canonical_project_id, product_id, producer_id,
        namespace, visibility, lifecycle_status, scope_key
      ) VALUES (
        $1::uuid, $2, $3, $4::vector, $5::jsonb,
        'tenant-live', 'user-live', 'project-live', 'mengshu', 'operator-live',
        'working-context', 'private', 'active', $6
      )`, [id, `live-row-${id}`, contentHash, JSON.stringify(value), JSON.stringify({
        embeddingModel: model,
      }), `scope-${id}`]);
      await insert("memories", "00000000-0000-4000-8000-000000000001", "a".repeat(32),
        "Qwen/Qwen3-Embedding-0.6B", qwen);
      await insert("memories", "00000000-0000-4000-8000-000000000002",
        "123e4567-e89b-12d3-a456-426614174000", "BAAI/bge-m3", bge);
      await insert("knowledge", "00000000-0000-8000-8000-000000000003", "c".repeat(32),
        "Qwen/Qwen3-Embedding-0.6B", vector(0.99, 0.01));
      await insert("knowledge", "00000000-0000-4000-8000-000000000004", "d".repeat(32),
        "openai", vector(0.01, 0.99));
      await client.query(
        "UPDATE knowledge SET text = '' WHERE id = '00000000-0000-4000-8000-000000000004'::uuid",
      );

      const liveManifest: OperatorEmbeddingManifest = {
        ...manifest,
        expected: { total: 4, validated: 2, reembed: 2, memories: 2, knowledge: 2 },
        scanBatchSize: 2,
        apiBatchSize: 2,
      };
      const loaded = loadOperatorEmbeddingManifest(`${JSON.stringify(liveManifest)}\n`);
      let embeddedTexts = 0;
      let liveFailure = "";
      const liveClient: OperatorEmbeddingClient = {
        query: async (sql, params = []) => {
          try {
            return await client.query(sql, [...params]);
          } catch (error) {
            const marker = sql.match(/embedding-migrate:[a-z-]+/)?.[0] ?? "transaction";
            liveFailure = `${marker}: ${error instanceof Error ? error.message : "database error"}`;
            throw error;
          }
        },
      };
      const migration = runOperatorEmbeddingMigration(liveClient, loaded.manifest, loaded.sha256, {
        mode: "apply",
        maintenance: true,
        quiescenceConfirmed: true,
        confirmationToken: OPERATOR_EMBEDDING_APPLY_TOKEN,
        expectedManifestSha256: loaded.sha256,
        embedder: {
          target: liveManifest.target,
          embedBatch: async (texts) => {
            embeddedTexts += texts.length;
            return texts.map(() => Array(1024).fill(0.01));
          },
        },
      });
      const report = await migration.catch((error) => {
        throw new Error(liveFailure || "operator live migration failed", { cause: error });
      });
      expect(report).toMatchObject({ validated: 2, reembed: 2, updated: 4 });
      expect(embeddedTexts).toBe(2);
      const receipts = await client.query<{ operation: string; count: number }>(
        `SELECT operation, COUNT(*)::integer AS count
         FROM mengshu_embedding_reembed_receipts
         GROUP BY operation ORDER BY operation`,
      );
      expect(receipts.rows).toEqual([
        { operation: "applied", count: 2 },
        { operation: "validated", count: 2 },
      ]);
    } finally {
      await client.end();
    }
  }, 60_000);
});
