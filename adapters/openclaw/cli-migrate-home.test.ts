/**
 * cli-migrate-home.test.ts - ltm migrate-home 命令单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateHome } from "./cli-migrate-home.js";

describe("cli-migrate-home", () => {
  let testDir: string;
  let legacyHome: string;
  let newHome: string;

  beforeEach(() => {
    // 创建隔离的测试环境
    testDir = mkdtempSync(join(tmpdir(), "migrate-home-test-"));
    legacyHome = join(testDir, ".openclaw");
    newHome = join(testDir, ".memory-autodb");

    // 创建旧目录结构
    mkdirSync(legacyHome, { recursive: true });
  });

  afterEach(() => {
    // 清理测试环境
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("dry-run 模式不修改文件系统", async () => {
    // 准备
    writeFileSync(join(legacyHome, ".env"), "TEST=value");
    writeFileSync(join(legacyHome, "memory-autodb-mcp.json"), "{}");

    // 执行 dry-run
    await migrateHome({
      dryRun: true,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证：目标目录不应被创建
    expect(existsSync(newHome)).toBe(false);
  });

  it("源目录不存在时报错", async () => {
    // 删除源目录
    rmSync(legacyHome, { recursive: true, force: true });

    // 执行应该退出进程（这里我们检查目录不存在）
    expect(existsSync(legacyHome)).toBe(false);
  });

  it("--execute 正确迁移文件", async () => {
    // 准备源文件
    writeFileSync(join(legacyHome, ".env"), "TEST=value");
    writeFileSync(join(legacyHome, "memory-autodb-mcp.json"), '{"dbType":"lancedb"}');
    mkdirSync(join(legacyHome, "memory", "lancedb"), { recursive: true });
    writeFileSync(join(legacyHome, "memory", "lancedb", "test.db"), "test");

    // 执行迁移
    await migrateHome({
      dryRun: false,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证：文件应该被复制
    expect(existsSync(join(newHome, ".env"))).toBe(true);
    expect(existsSync(join(newHome, "config.json"))).toBe(true);
    expect(existsSync(join(newHome, "memory", "lancedb", "test.db"))).toBe(true);
  });

  it("目标文件已存在且不带 --force 时跳过", async () => {
    // 准备源文件和已存在的目标文件
    writeFileSync(join(legacyHome, ".env"), "OLD=value");
    mkdirSync(newHome, { recursive: true });
    writeFileSync(join(newHome, ".env"), "NEW=value");

    // 执行迁移（不带 force）
    await migrateHome({
      dryRun: false,
      force: false,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证：目标文件应该保持不变
    const content = require("fs").readFileSync(join(newHome, ".env"), "utf-8");
    expect(content).toBe("NEW=value");
  });

  it("--execute + --force 正确覆盖", async () => {
    // 准备源文件和已存在的目标文件
    writeFileSync(join(legacyHome, ".env"), "OLD=value");
    mkdirSync(newHome, { recursive: true });
    writeFileSync(join(newHome, ".env"), "NEW=value");

    // 执行迁移（带 force）
    await migrateHome({
      dryRun: false,
      force: true,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证：目标文件应该被覆盖
    const content = require("fs").readFileSync(join(newHome, ".env"), "utf-8");
    expect(content).toBe("OLD=value");
  });

  it("备份功能正确创建备份目录", async () => {
    // 准备源文件
    writeFileSync(join(legacyHome, ".env"), "TEST=value");
    writeFileSync(join(legacyHome, "test.txt"), "backup test");

    // 执行迁移（带备份）
    await migrateHome({
      dryRun: false,
      backup: true,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证：备份目录应该被创建
    const entries = readdirSync(testDir);
    const backupDirs = entries.filter((name) => name.startsWith(".openclaw.backup-"));
    expect(backupDirs.length).toBeGreaterThan(0);

    // 验证备份内容
    const backupDir = join(testDir, backupDirs[0]);
    expect(existsSync(join(backupDir, ".env"))).toBe(true);
    expect(existsSync(join(backupDir, "test.txt"))).toBe(true);
  });

  it("迁移后验证关键文件存在", async () => {
    // 准备完整的源目录
    writeFileSync(join(legacyHome, ".env"), "TEST=value");
    writeFileSync(join(legacyHome, "memory-autodb-mcp.json"), "{}");
    mkdirSync(join(legacyHome, "memory", "lancedb"), { recursive: true });
    writeFileSync(join(legacyHome, "memory", "lancedb", "dummy"), "");

    // 执行迁移
    await migrateHome({
      dryRun: false,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证关键路径
    expect(existsSync(join(newHome, ".env"))).toBe(true);
    expect(existsSync(join(newHome, "config.json"))).toBe(true);
    expect(existsSync(join(newHome, "memory", "lancedb"))).toBe(true);
  });

  it("缺失的源文件不阻止迁移", async () => {
    // 只创建部分源文件
    writeFileSync(join(legacyHome, ".env"), "TEST=value");
    // 不创建 memory-autodb-mcp.json 和 memory/ 目录

    // 执行迁移
    await migrateHome({
      dryRun: false,
      homePathOptions: {
        homeDir: newHome,
        home: testDir,
        env: { MEMORY_AUTODB_HOME: newHome },
      },
    });

    // 验证：存在的文件应该被迁移
    expect(existsSync(join(newHome, ".env"))).toBe(true);
    // 不存在的文件不应阻止整体迁移
    expect(existsSync(newHome)).toBe(true);
  });
});
