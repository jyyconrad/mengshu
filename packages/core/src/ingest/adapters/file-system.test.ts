import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { InMemoryMemoryStore } from "../../storage/repositories/in-memory.js";
import { IngestionPipeline } from "../pipeline.js";
import { ingestMarkdownDirectory, ingestMarkdownFile } from "./file-system.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

describe("file-system ingestion adapter", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-ingest-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("reads markdown file and routes it through ingestion pipeline", async () => {
    const filePath = path.join(tmpDir, "guide.md");
    await fs.writeFile(filePath, "---\ntitle: Guide\n---\n\n# Guide\n\nalpha beta", "utf8");

    const store = new InMemoryMemoryStore();
    const pipeline = new IngestionPipeline({
      documents: store.documents,
      chunks: store.chunks,
      jobs: store.jobs,
      audit: store.audit,
    });

    const result = await ingestMarkdownFile({
      filePath,
      scope,
      pipeline,
      chunkSize: 12,
    });

    expect(result.processedFiles).toBe(1);
    expect(result.failedFiles).toBe(0);
    expect(result.jobsQueued).toBeGreaterThan(0);
    await expect(store.documents.get(result.documentId!)).resolves.toMatchObject({
      uri: filePath,
      title: "Guide",
    });
  });

  test("scans markdown directory through ingestion pipeline and honors ignores", async () => {
    await fs.mkdir(path.join(tmpDir, "nested"));
    await fs.writeFile(path.join(tmpDir, "guide.md"), "# Guide\n\nalpha beta gamma", "utf8");
    await fs.writeFile(path.join(tmpDir, "nested", "note.mdx"), "# Note\n\nrepeat\n\nrepeat", "utf8");
    await fs.writeFile(path.join(tmpDir, "ignored.md"), "# Ignore\n\nshould not ingest", "utf8");
    await fs.writeFile(path.join(tmpDir, "plain.txt"), "not markdown", "utf8");

    const store = new InMemoryMemoryStore();
    const pipeline = new IngestionPipeline({
      documents: store.documents,
      chunks: store.chunks,
      jobs: store.jobs,
      audit: store.audit,
    });

    const result = await ingestMarkdownDirectory({
      directory: tmpDir,
      scope,
      pipeline,
      scannerOptions: {
        ignorePaths: ["ignored.md"],
      },
      chunkSize: 12,
    });

    expect(result).toMatchObject({
      totalFiles: 2,
      processedFiles: 2,
      failedFiles: 0,
      chunksDropped: 1,
      duplicateChunks: 1,
      storedChunks: result.chunksAdmitted,
      jobsQueued: result.chunksAdmitted,
      errors: [],
    });
    await expect(store.documents.list({ scope })).resolves.toHaveLength(2);
    await expect(store.jobs.list("queued")).resolves.toHaveLength(result.jobsQueued);
  });

  test("does not count deduped jobs as newly queued on repeated directory scans", async () => {
    await fs.writeFile(path.join(tmpDir, "guide.md"), "# Guide\n\nalpha beta gamma", "utf8");

    const store = new InMemoryMemoryStore();
    const pipeline = new IngestionPipeline({
      documents: store.documents,
      chunks: store.chunks,
      jobs: store.jobs,
      audit: store.audit,
    });

    const first = await ingestMarkdownDirectory({
      directory: tmpDir,
      scope,
      pipeline,
      chunkSize: 12,
    });
    const second = await ingestMarkdownDirectory({
      directory: tmpDir,
      scope,
      pipeline,
      chunkSize: 12,
    });

    expect(first.jobsQueued).toBeGreaterThan(0);
    expect(second.chunksAdmitted).toBe(0);
    expect(second.chunksDropped).toBe(first.chunksAdmitted);
    expect(second.jobsQueued).toBe(0);
    await expect(store.jobs.list("queued")).resolves.toHaveLength(first.jobsQueued);
  });
});
