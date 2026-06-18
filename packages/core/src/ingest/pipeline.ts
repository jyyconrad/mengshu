/**
 * Deterministic ingestion pipeline.
 *
 * Pipeline 写入 document/chunks/audit 并为每个新 chunk enqueue embedding job；
 * 热路径不依赖 embeddings 或 LLM。
 */

import type { ChunkRecord, DocumentRecord } from "../domain/types.js";
import { scopeToKey } from "../domain/scope.js";
import { computeContentHash } from "../scoring/hash-utils.js";
import type {
  AuditRepository,
  ChunkRepository,
  DocumentRepository,
  JobRepository,
} from "../storage/repositories/types.js";
import { canonicalize } from "./canonicalize.js";
import { chunkMarkdown } from "./chunker.js";
import { enqueueUniqueJob } from "./jobs.js";
import type { IngestInput, IngestResult } from "./types.js";
import { enqueueExtractGraphJob } from "../graph/extract-graph-handler.js";

export interface IngestionPipelineOptions {
  documents: DocumentRepository;
  chunks: ChunkRepository;
  jobs: JobRepository;
  audit: AuditRepository;
  now?: () => number;
  graphJobs?: JobRepository;
}

export class IngestionPipeline {
  private readonly now: () => number;

  constructor(private readonly options: IngestionPipelineOptions) {
    this.now = options.now ?? Date.now;
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    const createdAt = this.now();
    const canonical = canonicalize(input);
    const scopeKey = scopeToKey(input.scope);
    const documentId = `doc:${computeContentHash(`${scopeKey}:${canonical.sourceId}:${canonical.markdown}`)}`;
    const document: DocumentRecord = {
      id: documentId,
      scope: input.scope,
      title: typeof canonical.metadata.title === "string" ? canonical.metadata.title : undefined,
      uri: canonical.sourceId,
      contentHash: computeContentHash(canonical.markdown),
      metadata: canonical.metadata,
      createdAt,
      updatedAt: createdAt,
    };
    await this.options.documents.upsert(document);

    const rawChunks = chunkMarkdown(canonical.markdown, {
      scopeKey,
      scope: input.scope,
      documentId,
      chunkSize: input.chunkSize,
      createdAt,
    });
    const existingHashes = new Set(
      (await this.options.chunks.list({ scope: input.scope })).map((chunk) => chunk.contentHash),
    );
    const seenHashes = new Set<string>();
    const chunks: ChunkRecord[] = [];
    let chunksDropped = 0;
    for (const chunk of rawChunks) {
      if (seenHashes.has(chunk.contentHash) || existingHashes.has(chunk.contentHash)) {
        chunksDropped += 1;
        continue;
      }
      seenHashes.add(chunk.contentHash);
      chunks.push({
        ...chunk,
        scope: input.scope,
        provenance: {
          ...chunk.provenance,
          source: "scan",
          sourceId: canonical.sourceId,
        },
      });
    }

    await this.options.chunks.upsertMany(chunks);
    const knownJobIds = new Set((await this.options.jobs.list()).map((job) => job.id));
    let jobsQueued = 0;
    for (const chunk of chunks) {
      const job = await enqueueUniqueJob(this.options.jobs, {
        type: "embed_chunk",
        targetId: chunk.contentHash,
        payload: { chunkId: chunk.id, documentId },
      });
      if (!knownJobIds.has(job.id)) {
        knownJobIds.add(job.id);
        jobsQueued += 1;
      }
    }
    if (this.options.graphJobs) {
      for (const chunk of chunks) {
        await enqueueExtractGraphJob(this.options.graphJobs, {
          chunkId: chunk.id,
          text: chunk.text,
          scope: chunk.scope,
          sourceId: canonical.sourceId,
        }).catch(() => { /* 图谱入队失败不阻塞 ingest */ });
      }
    }
    await this.options.audit.append({
      scope: input.scope,
      action: "ingest.document",
      targetId: documentId,
      metadata: {
        sourceId: canonical.sourceId,
        chunksAdmitted: chunks.length,
        chunksDropped,
        jobsQueued,
      },
    });

    return {
      documentId,
      chunksAdmitted: chunks.length,
      chunksDropped,
      jobsQueued,
    };
  }
}
