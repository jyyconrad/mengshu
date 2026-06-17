import { describe, expect, test } from "vitest";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { enqueueUniqueJob, jobDedupeKey } from "./jobs.js";

describe("ingest jobs", () => {
  test("enqueues jobs with deterministic dedupe key", async () => {
    const store = new InMemoryMemoryStore({ idFactory: () => "job-1" });

    const first = await enqueueUniqueJob(store.jobs, {
      type: "embed_chunk",
      targetId: "chunk-1",
      payload: { chunkId: "chunk-1" },
    });
    const second = await enqueueUniqueJob(store.jobs, {
      type: "embed_chunk",
      targetId: "chunk-1",
      payload: { chunkId: "chunk-1" },
    });

    expect(first.id).toBe("job-1");
    expect(second.id).toBe("job-1");
    expect(first.dedupeKey).toBe("embed_chunk:chunk-1");
  });

  describe("schemaVersion reuse-compatible 策略 (评审问题 #6)", () => {
    test("默认不带 schemaVersion，复用历史结果", () => {
      expect(jobDedupeKey("extract_candidate", "obs-1")).toBe(
        "extract_candidate:obs-1",
      );
    });

    test("prompt 微调（无 forceSchemaVersion）不改变 dedupe key", () => {
      const before = jobDedupeKey("extract_candidate", "obs-1");
      const after = jobDedupeKey("extract_candidate", "obs-1");
      expect(before).toBe(after);
    });

    test("schema 不兼容变更（forceSchemaVersion）使 dedupe key 改变", () => {
      const v1 = jobDedupeKey("extract_candidate", "obs-1", "1");
      const v2 = jobDedupeKey("extract_candidate", "obs-1", "2");
      expect(v1).toBe("extract_candidate:obs-1:v1");
      expect(v2).toBe("extract_candidate:obs-1:v2");
      expect(v1).not.toBe(v2);
    });

    test("forceSchemaVersion 触发重新 enqueue（新 job）", async () => {
      let counter = 0;
      const store = new InMemoryMemoryStore({ idFactory: () => `job-${++counter}` });

      const oldJob = await enqueueUniqueJob(store.jobs, {
        type: "extract_candidate",
        targetId: "obs-1",
        payload: { observationId: "obs-1" },
        forceSchemaVersion: "1",
      });
      const newJob = await enqueueUniqueJob(store.jobs, {
        type: "extract_candidate",
        targetId: "obs-1",
        payload: { observationId: "obs-1" },
        forceSchemaVersion: "2",
      });

      expect(oldJob.id).not.toBe(newJob.id);
      expect(oldJob.dedupeKey).toBe("extract_candidate:obs-1:v1");
      expect(newJob.dedupeKey).toBe("extract_candidate:obs-1:v2");
    });
  });
});
