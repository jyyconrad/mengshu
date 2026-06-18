import { readFile, stat } from "node:fs/promises";
import frontMatter from "front-matter";
import type { MemoryMetadata } from "../../db/types.js";
import { TextSplitter, type TextSplitOptions } from "../../scoring/text-splitter.js";

export interface ProcessedDocument {
  /** 文件路径 */
  filePath: string;
  /** 文件元数据 */
  metadata: MemoryMetadata;
  /** 文本分片 */
  chunks: string[];
}

export interface MarkdownProcessorOptions {
  /** 文本切片配置 */
  splitOptions?: TextSplitOptions;
}

/**
 * Markdown文件处理器
 * 读取Markdown文件，提取元数据，切片处理
 */
export class MarkdownProcessor {
  private textSplitter: TextSplitter;

  constructor(options: MarkdownProcessorOptions = {}) {
    this.textSplitter = new TextSplitter(options.splitOptions);
  }

  /**
   * 处理单个Markdown文件
   * @param filePath 文件路径
   * @returns 处理后的文档数据
   */
  async processFile(filePath: string): Promise<ProcessedDocument> {
    // 读取文件内容
    const content = await readFile(filePath, "utf-8");
    const fileStat = await stat(filePath);

    // 解析front matter
    const { attributes, body } = frontMatter<Record<string, unknown>>(content);

    // 提取元数据
    const metadata: MemoryMetadata = {
      filePath,
      createdAt: fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
      ...attributes,
    };

    // 文本切片
    const chunks = await this.textSplitter.splitText(body);

    return {
      filePath,
      metadata,
      chunks,
    };
  }

  /**
   * 批量处理Markdown文件
   * @param filePaths 文件路径数组
   * @returns 处理后的文档数组
   */
  async processFiles(filePaths: string[]): Promise<ProcessedDocument[]> {
    return Promise.all(filePaths.map(filePath => this.processFile(filePath)));
  }
}
