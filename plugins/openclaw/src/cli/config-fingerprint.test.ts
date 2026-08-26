import { describe, expect, test } from "vitest";
import { createConfigFingerprint } from "./config-fingerprint.js";

const baseConfig = {
  mode: "server",
  embedding: {
    provider: "openai",
    baseURL: "https://embedding.example/v1",
    model: "text-embedding-3-small",
    apiKey: "fake-embedding-secret",
  },
  llm: {
    provider: "openai",
    baseURL: "https://llm.example/v1",
    model: "gpt-test",
    extractionModel: "gpt-extract",
    summarizationModel: "gpt-summary",
    reasoningModel: "gpt-reason",
    maxTokens: 2048,
    apiKey: "fake-llm-secret",
  },
  dbType: "postgres",
  postgres: {
    host: "db.example",
    port: 5432,
    database: "mengshu",
    user: "mengshu",
    password: "fake-db-password",
    ssl: true,
  },
  server: {
    enabled: true,
    host: "127.0.0.1",
    port: 3847,
    secret: "fake-server-token",
    requireHttps: false,
  },
  features: {
    bm25: true,
    graph: true,
    summaryTree: true,
    webConsole: false,
    assetInjection: false,
  },
  autoCapture: true,
  autoRecall: true,
  recallIncludeDocuments: false,
  captureMaxChars: 500,
  scanner: {
    defaultIgnorePaths: ["node_modules", ".git"],
    customIgnoreRules: ["*.secret", "dist/**"],
    targetTable: "knowledge",
    autoEnrichMetadata: true,
  },
  batchProcessing: {
    maxBatchSize: 20,
    concurrency: 3,
    retryAttempts: 3,
  },
  knowledgeBases: {
    enabled: true,
    autoCreateTables: true,
    vectorDimensions: 1536,
    builtinCategories: ["personal", "work"],
    customCategories: ["engineering"],
  },
  routingRules: [
    {
      name: "personal",
      patterns: ["personal", "diary"],
      targetTable: "knowledge_personal",
      enabled: true,
    },
    {
      name: "work",
      patterns: ["work", "project"],
      targetTable: "knowledge_work",
      enabled: true,
    },
  ],
  tree: {
    summaryFaithfulness: {
      mode: "high_risk",
      sampleRate: 0.05,
      judgeModel: "gpt-judge",
      failAction: "fallback_extractive",
    },
  },
  promotion: {
    enabled: true,
    minEvidenceCount: 5,
    minTimeSpanDays: 3,
    generalizeThreshold: 5,
    minSimilarity: 0.78,
    autoConflictDowngrade: true,
  },
  tables: {
    memories: { enabled: true, autoIndex: true },
    knowledge: { enabled: true, autoIndex: false },
  },
};

describe("createConfigFingerprint", () => {
  test("同一运行语义稳定生成脱敏指纹且不受 secret 值变化影响", () => {
    const first = createConfigFingerprint(baseConfig);
    const differentSecrets = createConfigFingerprint({
      ...baseConfig,
      embedding: { ...baseConfig.embedding, apiKey: "another-embedding-secret" },
      llm: { ...baseConfig.llm, apiKey: "another-llm-secret" },
      postgres: { ...baseConfig.postgres, password: "another-db-password" },
      server: { ...baseConfig.server, secret: "another-server-token" },
    });

    expect(first).toMatch(/^cfg_v1_[a-f0-9]{16}$/);
    expect(differentSecrets).toBe(first);
    expect(first).not.toContain("fake");
  });

  test.each([
    ["embedding model", { embedding: { ...baseConfig.embedding, model: "text-embedding-3-large" } }],
    ["embedding baseURL", { embedding: { ...baseConfig.embedding, baseURL: "https://other.example/v1" } }],
    ["LLM model", { llm: { ...baseConfig.llm, model: "gpt-other" } }],
    ["LLM maxTokens", { llm: { ...baseConfig.llm, maxTokens: 4096 } }],
    ["dbType", { dbType: "lancedb", dbPath: "/tmp/mengshu" }],
    ["features", { features: { ...baseConfig.features, graph: false } }],
    ["assetInjection", { features: { ...baseConfig.features, assetInjection: true } }],
    ["autoCapture", { autoCapture: false }],
    ["autoRecall", { autoRecall: false }],
    ["recallIncludeDocuments", { recallIncludeDocuments: true }],
    ["captureMaxChars", { captureMaxChars: 800 }],
    ["scanner", { scanner: { ...baseConfig.scanner, targetTable: "documents" } }],
    ["batchProcessing", { batchProcessing: { ...baseConfig.batchProcessing, concurrency: 4 } }],
    [
      "knowledgeBases",
      {
        knowledgeBases: {
          ...baseConfig.knowledgeBases,
          customCategories: ["engineering", "research"],
        },
      },
    ],
    [
      "routingRules",
      {
        routingRules: [
          { ...baseConfig.routingRules[0], enabled: false },
          baseConfig.routingRules[1],
        ],
      },
    ],
    [
      "tree summaryFaithfulness",
      {
        tree: {
          summaryFaithfulness: {
            ...baseConfig.tree.summaryFaithfulness,
            mode: "always",
          },
        },
      },
    ],
    ["promotion", { promotion: { ...baseConfig.promotion, minEvidenceCount: 6 } }],
    [
      "tables",
      {
        tables: {
          ...baseConfig.tables,
          knowledge: { ...baseConfig.tables.knowledge, autoIndex: true },
        },
      },
    ],
  ])("%s 运行语义变化会改变指纹", (_name, change) => {
    expect(createConfigFingerprint({ ...baseConfig, ...change })).not.toBe(
      createConfigFingerprint(baseConfig),
    );
  });

  test("忽略运行时强制为 0.0 的遗留 temperature 字段", () => {
    expect(createConfigFingerprint({
      ...baseConfig,
      llm: { ...baseConfig.llm, temperature: 0.9 },
    })).toBe(createConfigFingerprint(baseConfig));
  });

  test("credential 从未配置变为已配置会改变指纹，但不记录 credential 内容", () => {
    const withoutCredential = {
      ...baseConfig,
      embedding: { ...baseConfig.embedding, apiKey: "" },
    };

    expect(createConfigFingerprint(withoutCredential)).not.toBe(createConfigFingerprint(baseConfig));
  });

  test("Supabase serviceKey 轮换不改变指纹，但配置状态变化会改变", () => {
    const supabaseConfig = {
      ...baseConfig,
      dbType: "supabase",
      supabase: { url: "https://db.example", serviceKey: "fake-service-key" },
    };

    expect(
      createConfigFingerprint({
        ...supabaseConfig,
        supabase: { ...supabaseConfig.supabase, serviceKey: "rotated-service-key" },
      }),
    ).toBe(createConfigFingerprint(supabaseConfig));
    expect(
      createConfigFingerprint({
        ...supabaseConfig,
        supabase: { ...supabaseConfig.supabase, serviceKey: "" },
      }),
    ).not.toBe(createConfigFingerprint(supabaseConfig));
  });

  test("对象键顺序不影响指纹，routingRules 数组顺序会影响指纹", () => {
    const reorderedObjectKeys = {
      ...baseConfig,
      scanner: {
        autoEnrichMetadata: baseConfig.scanner.autoEnrichMetadata,
        targetTable: baseConfig.scanner.targetTable,
        customIgnoreRules: baseConfig.scanner.customIgnoreRules,
        defaultIgnorePaths: baseConfig.scanner.defaultIgnorePaths,
      },
      routingRules: baseConfig.routingRules.map((rule) => ({
        enabled: rule.enabled,
        targetTable: rule.targetTable,
        patterns: rule.patterns,
        name: rule.name,
      })),
    };
    const reversedRules = {
      ...baseConfig,
      routingRules: [...baseConfig.routingRules].reverse(),
    };

    expect(createConfigFingerprint(reorderedObjectKeys)).toBe(createConfigFingerprint(baseConfig));
    expect(createConfigFingerprint(reversedRules)).not.toBe(createConfigFingerprint(baseConfig));
  });
});
