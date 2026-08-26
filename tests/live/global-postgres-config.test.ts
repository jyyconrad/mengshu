import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { parseGlobalPostgresConfig } from "./global-postgres-config.js";

describe("global PostgreSQL live config", () => {
  test("只从已加载的 Mengshu 全局配置解析 PostgreSQL，不依赖 live 专用凭据", () => {
    expect(parseGlobalPostgresConfig({
      embedding: {
        provider: "openai", apiKey: "fixture-key",
        baseURL: "https://embedding.example/v1", model: "text-embedding-3-small",
      },
      dbType: "postgres",
      postgres: {
        host: "postgres.internal", port: 5432, database: "mengshu",
        user: "mengshu", password: "fixture-password", ssl: true,
      },
    })).toEqual({
      host: "postgres.internal", port: 5432, database: "mengshu",
      user: "mengshu", password: "fixture-password", ssl: true,
    });
  });

  test("全局配置未选择 PostgreSQL 时 fail-closed", () => {
    expect(() => parseGlobalPostgresConfig({
      embedding: {
        provider: "openai", apiKey: "fixture-key",
        baseURL: "https://embedding.example/v1", model: "text-embedding-3-small",
      },
      dbType: "lancedb",
    })).toThrow(/dbType=postgres/);
  });

  test("live gate shell 不启动或管理数据库中间件", () => {
    const script = fs.readFileSync(
      path.resolve(import.meta.dirname, "run-postgres-v9-e2e.sh"),
      "utf8",
    );
    expect(script).not.toMatch(/\bdocker\b|MENGSHU_LIVE_PG_|POSTGRES_PASSWORD|pg_isready/);
    expect(script).toContain("MENGSHU_RUN_LIVE_TESTS=1");
  });

  test("live gate 与 runner 不创建临时数据库配置，也不重置全局 public schema", () => {
    const sources = [
      "global-postgres-config.ts",
      "postgres-v9-runtime.e2e.test.ts",
      "production-rest-runtime-eval.e2e.test.ts",
      "../eval/runners/runtime-e2e.ts",
    ].map((relativePath) => fs.readFileSync(path.resolve(import.meta.dirname, relativePath), "utf8"));
    const combined = sources.join("\n");

    expect(combined).not.toMatch(/MENGSHU_HOME|MENGSHU_LIVE_PG_|allowReset|resetDatabase/);
    expect(combined).not.toMatch(/DROP\s+(?:TABLE|DATABASE)|TRUNCATE/i);
    expect(combined).not.toMatch(/DROP\s+SCHEMA\s+public|CREATE\s+SCHEMA\s+public/i);
    expect(combined).not.toMatch(/DELETE\s+FROM\s+memories(?![\s\S]*WHERE\s+id\s*=)/i);
    expect(combined).not.toMatch(/mkdtempSync|writeFileSync\([^)]*config\.json/);
  });

  test("隔离 schema 位于 search_path 首位，public 仅保留共享扩展类型解析", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "global-postgres-config.ts"),
      "utf8",
    );

    expect(source).toContain("`-c search_path=${schema},public`");
    expect(source).not.toContain("`-c search_path=public,${schema}`");
  });
});
