import type { MemoryConfig } from "../../../../../config.js";
import type { DatabaseProvider, MemoryEntry, TableName } from "../../db/types.js";
import { Embeddings } from "../../runtime/llm/embeddings.js";
import { computeContentHash } from "../../scoring/hash-utils.js";
import { FileScanner, type FileScannerOptions } from "./file-scanner.js";
import { MarkdownProcessor, type MarkdownProcessorOptions } from "./markdown-processor.js";

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

  constructor(
    config: MemoryConfig,
    db: DatabaseProvider,
    options: ScannerCoordinatorOptions = {},
  ) {
    this.db = db;
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
  }

  /**
   * 扫描目录并处理所有 Markdown 文件
   * @param directory 要扫描的目录路径
   * @returns 扫描结果统计
   */
  async scanDirectory(directory: string): Promise<ScanResult> {
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
    // 计算所有分片的哈希
    const hashes = chunks.map(chunk => computeContentHash(chunk));

    // 检查哪些已经存在
    const existingHashes = await this.db.existsByContentHash(hashes);
    const existingSet = new Set(existingHashes);

    // 过滤出不存在的分片
    const newChunks = chunks.filter((_, index) => !existingSet.has(hashes[index]));
    const newHashes = hashes.filter(hash => !existingSet.has(hash));

    // 统计重复数量
    const duplicateCount = chunks.length - newChunks.length;

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
        id: "", // 数据库自动生成
        text: chunk,
        contentHash: newHashes[index],
        vector: vectors[index],
        importance: 0.5, // 文档内容默认重要性
        category: "other" as const,
        dataType: "document" as const,
        tableName: this.targetTable,
        metadata: entryMetadata,
        createdAt: Date.now(),
      };
    }) as MemoryEntry[];

    // 存储到数据库
    await this.db.store(entries);

    return { stored: newChunks.length, duplicates: duplicateCount };
  }
}
