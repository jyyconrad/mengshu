/**
 * eval 命令组：评估相关工具
 *
 * 子命令：
 * - validate-config: 验证配置与 embedding 服务连通性
 * - review: 人工审核 golden case 执行结果
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { createHash } from "node:crypto";

interface EvalConfig {
  embedding: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  llm?: {
    extractionModel: string;
    summarizationModel: string;
  };
  dbType?: string;
}

function getGlobalConfigPath(): string {
  return path.join(os.homedir(), ".mengshu", "config.json");
}

function loadGlobalConfig(): EvalConfig {
  const configPath = getGlobalConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function getValidationRunDir(timestamp?: string): string {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(os.homedir(), ".mengshu", "eval-corpus", "openclaw", "validation-runs", ts);
}

async function testEmbeddingConnectivity(config: EvalConfig): Promise<{
  success: boolean;
  latencyMs: number;
  error?: string;
  model?: string;
  dimensions?: number;
}> {
  const startTime = Date.now();

  try {
    const response = await fetch(`${config.embedding.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.embedding.apiKey}`,
      },
      body: JSON.stringify({
        model: config.embedding.model,
        input: "connectivity test",
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        latencyMs,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    return {
      success: true,
      latencyMs,
      model: data.model || config.embedding.model,
      dimensions: embedding ? embedding.length : undefined,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function saveConfigSnapshot(config: EvalConfig, outputDir: string): void {
  const snapshot = {
    timestamp: new Date().toISOString(),
    configPath: getGlobalConfigPath(),
    config: {
      embedding: {
        baseURL: config.embedding.baseURL,
        model: config.embedding.model,
        apiKeyHash: createHash("sha256").update(config.embedding.apiKey).digest("hex").slice(0, 16),
      },
      llm: config.llm,
      dbType: config.dbType,
    },
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "config-snapshot.json"),
    JSON.stringify(snapshot, null, 2),
  );
}

function saveConnectivityTest(
  result: Awaited<ReturnType<typeof testEmbeddingConnectivity>>,
  outputDir: string,
): void {
  fs.writeFileSync(
    path.join(outputDir, "connectivity-test.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        ...result,
      },
      null,
      2,
    ),
  );
}

async function saveEmbeddingSample(config: EvalConfig, outputDir: string): Promise<void> {
  const sampleText = "OpenClaw 配置过 WAL Protocol";
  const startTime = Date.now();

  try {
    const response = await fetch(`${config.embedding.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.embedding.apiKey}`,
      },
      body: JSON.stringify({
        model: config.embedding.model,
        input: sampleText,
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      const embedding = data.data?.[0]?.embedding || [];
      const embeddingHash = createHash("sha256")
        .update(JSON.stringify(embedding))
        .digest("hex")
        .slice(0, 16);

      fs.writeFileSync(
        path.join(outputDir, "embedding-sample.json"),
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            text: sampleText,
            embedding_preview: embedding.slice(0, 10),
            embedding_hash: `sha256:${embeddingHash}`,
            embedding_dimensions: embedding.length,
            model: config.embedding.model,
            provider: config.embedding.baseURL,
            latencyMs,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.warn("Warning: Failed to save embedding sample:", error);
  }
}

async function validateConfig(): Promise<void> {
  console.log("🔍 Validating configuration...\n");

  // 1. 读取配置
  console.log("📄 Reading config from", getGlobalConfigPath());
  const config = loadGlobalConfig();
  console.log(`✓ Config loaded`);
  console.log(`  Embedding: ${config.embedding.model} @ ${config.embedding.baseURL}\n`);

  // 2. 测试连通性
  console.log("🌐 Testing embedding connectivity...");
  const connectivityResult = await testEmbeddingConnectivity(config);

  if (connectivityResult.success) {
    console.log(`✓ Connectivity test passed (${connectivityResult.latencyMs}ms)`);
    console.log(`  Model: ${connectivityResult.model}`);
    console.log(`  Dimensions: ${connectivityResult.dimensions}\n`);
  } else {
    console.error(`✗ Connectivity test failed (${connectivityResult.latencyMs}ms)`);
    console.error(`  Error: ${connectivityResult.error}\n`);
    process.exit(1);
  }

  // 3. 保存验证数据
  const outputDir = getValidationRunDir();
  console.log("💾 Saving validation data to", outputDir);

  saveConfigSnapshot(config, outputDir);
  console.log("  ✓ Config snapshot saved");

  saveConnectivityTest(connectivityResult, outputDir);
  console.log("  ✓ Connectivity test result saved");

  await saveEmbeddingSample(config, outputDir);
  console.log("  ✓ Embedding sample saved\n");

  console.log("✅ Configuration validation complete!");
  console.log(`📂 Validation data saved to: ${outputDir}`);
}

export function registerEvalCliCommands(program: Command): void {
  const evalCmd = program
    .command("eval")
    .description("Evaluation tools for OpenClaw history golden set");

  evalCmd
    .command("validate-config")
    .description("Validate config and test embedding connectivity")
    .action(async () => {
      try {
        await validateConfig();
      } catch (error: unknown) {
        console.error("Error:", error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Placeholder for future commands
  evalCmd
    .command("review")
    .description("Human review of golden case execution (coming soon)")
    .action(() => {
      console.log("⚠️  Human review tool is not yet implemented.");
      console.log("Coming soon in Phase 4 of the evaluation plan.");
    });
}
