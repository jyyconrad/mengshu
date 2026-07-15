import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runInteractiveSetup } from "./setup.js";

let homeDir: string;
let originalLog: typeof console.log;
let logs: string[];

function createFakeReadline(lines: string[]) {
  const answers = [...lines];
  return () => ({
    question(_question: string, callback: (answer: string) => void) {
      callback(answers.shift() ?? "");
    },
    close() {},
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "mengshu-setup-"));
  process.env.MENGSHU_HOME = homeDir;
  originalLog = console.log;
  logs = [];
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
});

afterEach(() => {
  console.log = originalLog;
  rmSync(homeDir, { recursive: true, force: true });
  delete process.env.MENGSHU_HOME;
});

describe("runInteractiveSetup 数据库配置", () => {
  test("PostgreSQL 选项写入 postgres 配置并把密码放入 env", async () => {
    const createReadline = createFakeReadline([
      "1", // Embedding: OpenAI
      "1", // embedding model
      "sk-embed",
      "y", // LLM 使用同一服务商
      "1", // LLM model
      "1", // PostgreSQL
      "pg.local",
      "15432",
      "mengshu_test",
      "mengshu_user",
      "MENGSHU_PG_PASSWORD",
      "pg-secret",
      "y",
      "y",
    ]);

    const result = await runInteractiveSetup({ createReadline });

    expect(result.configWritten).toBe(true);
    const config = readJson(join(homeDir, "config.json"));
    expect(config.dbType).toBe("postgres");
    expect(config.postgres).toEqual({
      host: "pg.local",
      port: 15432,
      database: "mengshu_test",
      user: "mengshu_user",
      password: "${MENGSHU_PG_PASSWORD}",
      ssl: true,
    });
    expect(config).not.toHaveProperty("dbPath");
    expect(readFileSync(join(homeDir, ".env"), "utf8")).toContain("MENGSHU_PG_PASSWORD=pg-secret");
    expect(statSync(join(homeDir, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(homeDir, ".env")).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("postgres (mengshu_user@pg.local:15432/mengshu_test)");
  });

  test("Supabase 选项写入 supabase.serviceKey 并把 service role key 放入 env", async () => {
    const createReadline = createFakeReadline([
      "1", // Embedding: OpenAI
      "1", // embedding model
      "sk-embed",
      "y", // LLM 使用同一服务商
      "1", // LLM model
      "3", // Supabase
      "https://project.supabase.co",
      "MENGSHU_SUPABASE_SERVICE_KEY",
      "service-secret",
      "y",
    ]);

    const result = await runInteractiveSetup({ createReadline });

    expect(result.configWritten).toBe(true);
    const config = readJson(join(homeDir, "config.json"));
    expect(config.dbType).toBe("supabase");
    expect(config.supabase).toEqual({
      url: "https://project.supabase.co",
      serviceKey: "${MENGSHU_SUPABASE_SERVICE_KEY}",
    });
    expect(config).not.toHaveProperty("dbPath");
    expect(readFileSync(join(homeDir, ".env"), "utf8")).toContain(
      "MENGSHU_SUPABASE_SERVICE_KEY=service-secret",
    );
    expect(logs.join("\n")).toContain("supabase (https://project.supabase.co)");
  });
});
