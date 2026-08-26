import { createHash } from "node:crypto";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function credentialConfigured(value: unknown): boolean {
  return optionalString(value) !== undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

/** 对象键排序、数组顺序保留，避免对象构造顺序造成无意义漂移。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        result[key] = canonicalize(record[key]);
      }
    }
    return result;
  }
  return value;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * 生成只反映运行语义的配置指纹。
 *
 * 指纹输入显式挑选非敏感字段；apiKey/password/serviceKey/server.secret
 * 只记录是否已配置，值本身绝不进入 hash 输入。因此指纹可安全用于诊断输出，
 * 也不会因 credential 轮换而产生无意义漂移。
 */
export function createConfigFingerprint(config: unknown): string {
  const root = asRecord(config);
  const embedding = asRecord(root.embedding);
  const llm = asRecord(root.llm);
  const server = asRecord(root.server);
  const postgres = asRecord(root.postgres);
  const supabase = asRecord(root.supabase);
  const features = asRecord(root.features);
  const scanner = asRecord(root.scanner);
  const batchProcessing = asRecord(root.batchProcessing);
  const knowledgeBases = asRecord(root.knowledgeBases);
  const tree = asRecord(root.tree);
  const summaryFaithfulness = asRecord(tree.summaryFaithfulness);
  const promotion = asRecord(root.promotion);
  const tables = asRecord(root.tables);
  const memoriesTable = asRecord(tables.memories);
  const knowledgeTable = asRecord(tables.knowledge);
  const dbType = optionalString(root.dbType) ?? "lancedb";

  const routingRules = Array.isArray(root.routingRules)
    ? root.routingRules.map((value) => {
        const rule = asRecord(value);
        return {
          name: optionalString(rule.name),
          patterns: optionalStringArray(rule.patterns),
          targetTable: optionalString(rule.targetTable),
          enabled: optionalBoolean(rule.enabled),
        };
      })
    : undefined;

  const semanticConfig = {
    mode: optionalString(root.mode),
    embedding: {
      provider: optionalString(embedding.provider),
      baseURL: optionalString(embedding.baseURL),
      model: optionalString(embedding.model),
      credentialConfigured: credentialConfigured(embedding.apiKey),
    },
    llm: Object.keys(llm).length > 0
      ? {
          provider: optionalString(llm.provider),
          baseURL: optionalString(llm.baseURL),
          model: optionalString(llm.model),
          extractionModel: optionalString(llm.extractionModel),
          summarizationModel: optionalString(llm.summarizationModel),
          reasoningModel: optionalString(llm.reasoningModel),
          maxTokens: optionalNumber(llm.maxTokens),
          credentialConfigured: credentialConfigured(llm.apiKey),
        }
      : undefined,
    database: dbType === "postgres"
      ? {
          dbType,
          host: optionalString(postgres.host),
          port: optionalNumber(postgres.port),
          database: optionalString(postgres.database),
          user: optionalString(postgres.user),
          ssl: optionalBoolean(postgres.ssl),
          credentialConfigured: credentialConfigured(postgres.password),
        }
      : dbType === "supabase"
        ? {
            dbType,
            url: optionalString(supabase.url),
            credentialConfigured: credentialConfigured(supabase.serviceKey),
          }
        : {
            dbType,
            dbPath: optionalString(root.dbPath),
          },
    server: {
      enabled: optionalBoolean(server.enabled),
      host: optionalString(server.host),
      port: optionalNumber(server.port),
      requireHttps: optionalBoolean(server.requireHttps),
      credentialConfigured: credentialConfigured(server.secret),
    },
    features: {
      bm25: optionalBoolean(features.bm25),
      graph: optionalBoolean(features.graph),
      summaryTree: optionalBoolean(features.summaryTree),
      webConsole: optionalBoolean(features.webConsole),
      assetInjection: optionalBoolean(features.assetInjection),
    },
    captureRecall: {
      autoCapture: optionalBoolean(root.autoCapture),
      autoRecall: optionalBoolean(root.autoRecall),
      recallIncludeDocuments: optionalBoolean(root.recallIncludeDocuments),
      captureMaxChars: optionalNumber(root.captureMaxChars),
    },
    scanner: Object.keys(scanner).length > 0
      ? {
          defaultIgnorePaths: optionalStringArray(scanner.defaultIgnorePaths),
          customIgnoreRules: optionalStringArray(scanner.customIgnoreRules),
          targetTable: optionalString(scanner.targetTable),
          autoEnrichMetadata: optionalBoolean(scanner.autoEnrichMetadata),
        }
      : undefined,
    batchProcessing: Object.keys(batchProcessing).length > 0
      ? {
          maxBatchSize: optionalNumber(batchProcessing.maxBatchSize),
          concurrency: optionalNumber(batchProcessing.concurrency),
          retryAttempts: optionalNumber(batchProcessing.retryAttempts),
        }
      : undefined,
    knowledgeBases: Object.keys(knowledgeBases).length > 0
      ? {
          enabled: optionalBoolean(knowledgeBases.enabled),
          autoCreateTables: optionalBoolean(knowledgeBases.autoCreateTables),
          vectorDimensions: optionalNumber(knowledgeBases.vectorDimensions),
          builtinCategories: optionalStringArray(knowledgeBases.builtinCategories),
          customCategories: optionalStringArray(knowledgeBases.customCategories),
        }
      : undefined,
    routingRules,
    tree: Object.keys(tree).length > 0
      ? {
          summaryFaithfulness: Object.keys(summaryFaithfulness).length > 0
            ? {
                mode: optionalString(summaryFaithfulness.mode),
                sampleRate: optionalNumber(summaryFaithfulness.sampleRate),
                judgeModel: optionalString(summaryFaithfulness.judgeModel),
                failAction: optionalString(summaryFaithfulness.failAction),
              }
            : undefined,
        }
      : undefined,
    promotion: Object.keys(promotion).length > 0
      ? {
          enabled: optionalBoolean(promotion.enabled),
          minEvidenceCount: optionalNumber(promotion.minEvidenceCount),
          minTimeSpanDays: optionalNumber(promotion.minTimeSpanDays),
          generalizeThreshold: optionalNumber(promotion.generalizeThreshold),
          minSimilarity: optionalNumber(promotion.minSimilarity),
          autoConflictDowngrade: optionalBoolean(promotion.autoConflictDowngrade),
        }
      : undefined,
    tables: Object.keys(tables).length > 0
      ? {
          memories: Object.keys(memoriesTable).length > 0
            ? {
                enabled: optionalBoolean(memoriesTable.enabled),
                autoIndex: optionalBoolean(memoriesTable.autoIndex),
              }
            : undefined,
          knowledge: Object.keys(knowledgeTable).length > 0
            ? {
                enabled: optionalBoolean(knowledgeTable.enabled),
                autoIndex: optionalBoolean(knowledgeTable.autoIndex),
              }
            : undefined,
        }
      : undefined,
  };

  const digest = createHash("sha256")
    .update(stableSerialize(semanticConfig))
    .digest("hex")
    .slice(0, 16);
  return `cfg_v1_${digest}`;
}
