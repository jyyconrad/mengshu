#!/usr/bin/env tsx
/**
 * mengshu CLI 入口
 *
 * 独立运行时启动 MCP stdio server；
 * 若全局配置不存在则先引导交互式设置。
 */
import fs from "node:fs";
import { resolveConfigPath } from "../core/paths.js";
import { runInteractiveSetup } from "../adapters/openclaw/cli-setup.js";

const configPath = resolveConfigPath();

if (!fs.existsSync(configPath)) {
  // 首次使用，引导设置
  const result = await runInteractiveSetup();
  if (!result.configWritten) {
    process.exit(0);
  }
  console.log("\n配置完成，启动 MCP server...\n");
}

// 启动 MCP server
await import("../scripts/mengshu-mcp.js");
