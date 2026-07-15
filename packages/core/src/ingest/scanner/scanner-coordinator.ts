import { randomUUID } from "node:crypto";
import type { MemoryConfig } from "../../../../../config.js";
import type { DatabaseProvider, MemoryEntry, TableName } from "../../db/types.js";
import { Embeddings } from "../../runtime/llm/embeddings.js";
import { computeContentHash } from "../../scoring/hash-utils.js";
import { FileScanner, type FileScannerOptions } from "./file-scanner.js";
import { MarkdownProcessor, type MarkdownProcessorOptions } from "./markdown-processor.js";
import type { MemoryScope } from "../../domain/types.js";
import { memoryScopeToCanonicalEntryFields } from "../../domain/legacy-mapping.js";

export interface ScannerEmbeddingWriteGate {
  assertWriteAllowed(): void;
}

export interface ScanResult {
  /** 扫描的目录路径 */
  directory: string;
  /** 发现的文件总数 */
  totalFiles: number;
  /** 成功处理的文件数 */
  processedFiles: number;
  /** 生成的分片总数 */
  totalChunks: number;
  /** 存储的分片数（去重后） */
  storedChunks: number;
  /** 跳过的重复分片数 */
  duplicateChunks: number;
  /** 处理失败的文件数 */
  failedFiles: number;
}

export interface ScannerCoordinatorOptions {
  /** 必填：生产 composition root 必须传入 runtime 的同一 write gate。 */
  embeddingWriteGuard: ScannerEmbeddingWriteGate;
  /** 文件扫描选项 */
  scannerOptions?: FileScannerOptions;
  /** Markdown 处理选项 */
  processorOptions?: MarkdownProcessorOptions;
  /** 批量处理大小 */
  batchSize?: number;
  /** 目标表名（默认：knowledge） */
  targetTable?: TableName;
  /** 是否自动丰富元数据 */
  autoEnrichMetadata?: boolean;
  /** 新写必需的 canonical authority scope；缺失时 scanner fail-closed。 */
  scope?: MemoryScope;
  /** 测试/可重复运行注入；生产默认 randomUUID。 */
  idFactory?: () => string;
}

/**
 * 扫描协调器
 * 协调目录扫描、文件处理、向量化和存储的完整流程
 */
export class ScannerCoordinator {
  private fileScanner: FileScanner;
  private markdownProcessor: MarkdownProcessor;
  private embeddings: Embeddings;
  private db: DatabaseProvider;
  private batchSize: number;
  private targetTable: TableName;
  private autoEnrichMetadata: boolean;
  private canonicalScope?: MemoryScope;
  private embeddingWriteGuard: ScannerEmbeddingWriteGate;
  private idFactory: () => string;

  constructor(
    config: MemoryConfig,
    db: DatabaseProvider,
    options: ScannerCoordinatorOptions,
  ) {
    if (!options?.embeddingWriteGuard || typeof options.embeddingWriteGuard.assertWriteAllowed !== "function") {
      throw new Error("ScannerCoordinator requires an explicit embedding write guard");
    }
    this.db = db;
    this.embeddingWriteGuard = options.embeddingWriteGuard;
    this.embeddings = new Embeddings(config.embedding, config.batchProcessing);
    this.fileScanner = new FileScanner({
      ...options.scannerOptions,
      ignorePaths: [
        ...(options.scannerOptions?.ignorePaths ?? []),
        ...(config.scanner?.defaultIgnorePaths ?? []),
      ],
      ignoreRules: [
        ...(options.scannerOptions?.ignoreRules ?? []),
        ...(config.scanner?.customIgnoreRules ?? []),
      ],
    });
    this.markdownProcessor = new MarkdownProcessor(options.processorOptions);
    this.batchSize = options.batchSize ?? config.batchProcessing?.maxBatchSize ?? 20;
    this.targetTable = options.targetTable ?? "knowledge";
    this.autoEnrichMetadata = options.autoEnrichMetadata ?? true;
    this.canonicalScope = options.scope;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * 扫描目录并处理所有 Markdown 文件
   * @param directory 要扫描的目录路径
   * @returns 扫描结果统计
   */
  async scanDirectory(directory: string): Promise<ScanResult> {
    // Enforced runtime 在读取文件前即可 fail-fast；legacy gate 会显式放行。
    this.embeddingWriteGuard.assertWriteAllowed();

    const result: ScanResult = {
      directory,
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      storedChunks: 0,
      duplicateChunks: 0,
      failedFiles: 0,
    };

    // 第一步：扫描所有文件
    const files = await this.fileScanner.scan(directory);
    result.totalFiles = files.length;

    // 第二步：逐个处理文件
    for (const file of files) {
      try {
        const processed = await this.markdownProcessor.processFile(file);
        result.processedFiles++;
        result.totalChunks += processed.chunks.length;

        // 批量处理分片并累加统计
        for (let i = 0; i < processed.chunks.length; i += this.batchSize) {
          const batch = processed.chunks.slice(i, i + this.batchSize);
          const batchResult = await this.processChunkBatch(batch, processed.metadata, file);
          result.storedChunks += batchResult.stored;
          result.duplicateChunks += batchResult.duplicates;
        }
      } catch (err) {
        console.error(`Failed to process file ${file}:`, err);
        result.failedFiles++;
      }
    }

    return result;
  }

  /**
   * 处理一批文本分片
   * @returns 返回 {stored: 存储数量，duplicates: 重复数量}
   */
  private async processChunkBatch(chunks: string[], metadata: Record<string, unknown>, filePath: string): Promise<{ stored: number; duplicates: number }> {
    // Registry 可能在长扫描期间变化，因此每个 batch 在任何 DB/embedding 工作前复检。
    this.embeddingWriteGuard.assertWriteAllowed();

    if (!this.canonicalScope) {
      throw new Error("ScannerCoordinator requires canonical authority scope before storage");
    }
    const canonicalScopeFields = memoryScopeToCanonicalEntryFields(this.canonicalScope);

    // 全局 existsByContentHash 是跨 authority existence oracle，不能参与持久去重。
    // 这里只消除当前 request batch 内的重复；数据库复合唯一键负责持久幂等。
    const seenHashes = new Set<string>();
    const newChunks: string[] = [];
    const newHashes: string[] = [];
    let duplicateCount = 0;
    for (const chunk of chunks) {
      const hash = computeContentHash(chunk);
      if (seenHashes.has(hash)) {
        duplicateCount += 1;
        continue;
      }
      seenHashes.add(hash);
      newChunks.push(chunk);
      newHashes.push(hash);
    }

    if (newChunks.length === 0) {
      return { stored: 0, duplicates: duplicateCount };
    }

    // 批量向量化
    const vectors = await this.embeddings.embedBatch(newChunks);

    // 构造记忆条目，存储到 knowledge 表
    const entries = newChunks.map((chunk, index) => {
      const entryMetadata: Record<string, unknown> = {
        ...metadata,
        source: "scan" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 自动丰富元数据
      if (this.autoEnrichMetadata) {
        entryMetadata.filePath = filePath;
        entryMetadata.embeddingModel = "openai"; // 默认嵌入模型
      }

      return {
        id: this.idFactory(),
        text: chunk,
        contentHash: newHashes[index],
        vector: vectors[index],
        importance: 0.5, // 文档内容默认重要性
        category: "other" as const,
        dataType: "document" as const,
        tableName: this.targetTable,
        metadata: entryMetadata,
        createdAt: Date.now(),
        ...canonicalScopeFields,
      };
    }) as MemoryEntry[];

    // 存储到数据库
    const outcome = await this.db.store(entries);
    if (!outcome) {
      throw new Error("Scanner storage provider did not return a durable store outcome");
    }
    if (outcome.inserted + outcome.duplicates !== entries.length ||
        outcome.records.length !== entries.length ||
        outcome.records.filter((record) => record.stored).length !== outcome.inserted) {
      throw new Error("Scanner storage provider returned an inconsistent store outcome");
    }
    const expectedIds = new Set(entries.map((entry) => entry.id));
    const seenRequestedIds = new Set<string>();
    for (const record of outcome.records) {
      if (!expectedIds.has(record.requestedId) || seenRequestedIds.has(record.requestedId) ||
          typeof record.persistedId !== "string" || record.persistedId.length === 0) {
        throw new Error("Scanner storage provider returned an invalid record identity outcome");
      }
      seenRequestedIds.add(record.requestedId);
    }

    return {
      stored: outcome.inserted,
      duplicates: duplicateCount + outcome.duplicates,
    };
  }
}
