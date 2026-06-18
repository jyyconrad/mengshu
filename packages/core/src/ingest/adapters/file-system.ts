/**
 * File-system ingestion adapter.
 *
 * 复用旧 `FileScanner` 的目录发现和忽略规则，但把处理热路径切到
 * `IngestionPipeline`：读取、canonicalize、chunk、persist、enqueue job，不同步调用
 * embedding 服务。
 */

import { readFile, stat } from "node:fs/promises";
import type { MemoryScope } from "../../domain/types.js";
import type { TableName } from "../../db/types.js";
import { FileScanner, type FileScannerOptions } from "../scanner/file-scanner.js";
import type { IngestionPipeline } from "../pipeline.js";

export interface IngestMarkdownFileInput {
  filePath: string;
  scope: MemoryScope;
  pipeline: IngestionPipeline;
  chunkSize?: number;
}

export interface IngestMarkdownDirectoryInput {
  directory: string;
  scope: MemoryScope;
  pipeline: IngestionPipeline;
  scannerOptions?: FileScannerOptions;
  chunkSize?: number;
  targetTable?: TableName;
  autoEnrichMetadata?: boolean;
}

export interface FileSystemIngestResult {
  processedFiles: number;
  failedFiles: number;
  documentId?: string;
  chunksAdmitted: number;
  chunksDropped: number;
  jobsQueued: number;
  error?: string;
}

export interface DirectoryIngestResult {
  directory: string;
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  storedChunks: number;
  duplicateChunks: number;
  failedFiles: number;
  jobsQueued: number;
  chunksAdmitted: number;
  chunksDropped: number;
  errors: Array<{ filePath: string; error: string }>;
}

export async function ingestMarkdownFile(input: IngestMarkdownFileInput): Promise<FileSystemIngestResult> {
  try {
    const [content, fileStat] = await Promise.all([
      readFile(input.filePath, "utf8"),
      stat(input.filePath),
    ]);
    const result = await input.pipeline.ingest({
      scope: input.scope,
      sourceId: input.filePath,
      content,
      metadata: {
        filePath: input.filePath,
        fileModifiedAt: fileStat.mtimeMs,
        createdAt: fileStat.birthtimeMs,
      },
      chunkSize: input.chunkSize,
    });
    return {
      processedFiles: 1,
      failedFiles: 0,
      documentId: result.documentId,
      chunksAdmitted: result.chunksAdmitted,
      chunksDropped: result.chunksDropped,
      jobsQueued: result.jobsQueued,
    };
  } catch (error) {
    return {
      processedFiles: 0,
      failedFiles: 1,
      chunksAdmitted: 0,
      chunksDropped: 0,
      jobsQueued: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ingestMarkdownDirectory(input: IngestMarkdownDirectoryInput): Promise<DirectoryIngestResult> {
  const scanner = new FileScanner(input.scannerOptions);
  const files = await scanner.scan(input.directory);
  const result: DirectoryIngestResult = {
    directory: input.directory,
    totalFiles: files.length,
    processedFiles: 0,
    totalChunks: 0,
    storedChunks: 0,
    duplicateChunks: 0,
    failedFiles: 0,
    jobsQueued: 0,
    chunksAdmitted: 0,
    chunksDropped: 0,
    errors: [],
  };

  for (const filePath of files) {
    const fileResult = await ingestMarkdownFile({
      filePath,
      scope: input.scope,
      pipeline: input.pipeline,
      chunkSize: input.chunkSize,
    });
    if (fileResult.failedFiles > 0) {
      result.failedFiles += fileResult.failedFiles;
      result.errors.push({
        filePath,
        error: fileResult.error ?? "Unknown ingestion failure",
      });
      continue;
    }

    result.processedFiles += fileResult.processedFiles;
    result.chunksAdmitted += fileResult.chunksAdmitted;
    result.chunksDropped += fileResult.chunksDropped;
    result.jobsQueued += fileResult.jobsQueued;
  }

  result.totalChunks = result.chunksAdmitted + result.chunksDropped;
  result.storedChunks = result.chunksAdmitted;
  result.duplicateChunks = result.chunksDropped;

  return result;
}
