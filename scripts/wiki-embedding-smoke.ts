import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Embeddings } from "../packages/core/src/runtime/llm/embeddings.js";

// wiki-embedding-smoke.ts <config.json> [expectedDims]
// 入库前的 embedding 冒烟:真实调用一次全局配置的 embedding 服务,
// 只有返回向量维度与配置一致时才允许进入 apply(计划批次 7)。
const [configPath, dimsArg] = process.argv.slice(2);
if (!configPath) throw new Error("usage: wiki-embedding-smoke.ts <config.json> [expectedDims]");

const raw = JSON.parse(readFileSync(resolve(configPath), "utf8")) as {
  embedding?: Record<string, unknown>;
};
const emb = raw.embedding;
if (!emb || typeof emb.apiKey !== "string" || typeof emb.baseURL !== "string" || typeof emb.model !== "string") {
  throw new Error("config embedding.{apiKey,baseURL,model} must be strings");
}
const expected = Number(dimsArg);

const embedder = new Embeddings(
  { provider: "openai", apiKey: emb.apiKey, baseURL: emb.baseURL, model: emb.model },
  undefined,
  { concurrency: 1, maxBatchSize: 1 },
);
const vectors = await embedder.embedBatch(["mengshu wiki 入库前 embedding 冒烟"]);
if (vectors.length !== 1) throw new Error(`smoke returned ${vectors.length} vectors`);
const dims = vectors[0]!.length;
if (Number.isSafeInteger(expected) && expected > 0 && dims !== expected) {
  throw new Error(`embedding dims ${dims} != expected ${expected}`);
}
process.stdout.write(`${JSON.stringify({ status: "ok", model: emb.model, dims })}\n`);
