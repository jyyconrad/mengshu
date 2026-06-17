import { describe, expect, test } from "vitest";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { runNextJob, startJobWorkerLoop } from "./workers.js";

describe("server workers", () => {
  test("leases and completes a job when handler succeeds", async () => {
    const store = new InMemoryMemoryStore();
    await store.jobs.enqueue({ type: "embed_chunk", payload: { chunkId: "chunk-1" }, dedupeKey: "embed_chunk:chunk-1" });

    const result = await runNextJob(store.jobs, {
      workerId: "worker-1",
      leaseMs: 1000,
      handlers: {
        embed_chunk: async () => ({ ok: true }),
      },
    });

    expect(result).toMatchObject({ status: "completed", type: "embed_chunk" });
    await expect(store.jobs.list("completed")).resolves.toHaveLength(1);
  });

  test("marks job failed when handler throws", async () => {
    const store = new InMemoryMemoryStore();
    await store.jobs.enqueue({ type: "embed_chunk", payload: { chunkId: "chunk-1" }, dedupeKey: "embed_chunk:chunk-1" });

    const result = await runNextJob(store.jobs, {
      workerId: "worker-1",
      leaseMs: 1000,
      handlers: {
        embed_chunk: async () => {
          throw new Error("boom");
        },
      },
    });

    expect(result).toMatchObject({ status: "failed", error: "boom" });
    await expect(store.jobs.list("failed")).resolves.toHaveLength(1);
  });

  test("returns idle when no job is available", async () => {
    const store = new InMemoryMemoryStore();

    await expect(
      runNextJob(store.jobs, {
        workerId: "worker-1",
        leaseMs: 1000,
        handlers: {},
      }),
    ).resolves.toEqual({ status: "idle" });
  });
});

describe("startJobWorkerLoop", () => {
  test("drains pending jobs on tick and stops cleanly", async () => {
    const store = new InMemoryMemoryStore();
    await store.jobs.enqueue({ type: "t", payload: { n: 1 }, dedupeKey: "t:1" });
    await store.jobs.enqueue({ type: "t", payload: { n: 2 }, dedupeKey: "t:2" });

    const seen: number[] = [];
    const loop = startJobWorkerLoop(store.jobs, {
      workerId: "w",
      leaseMs: 1000,
      intervalMs: 5,
      handlers: { t: async (job) => seen.push(job.payload.n as number) },
    });

    // 等到两条 job 都被处理。
    await loop.tick();
    expect(seen.sort()).toEqual([1, 2]);
    await loop.stop();

    // stop 后不再处理新 job。
    await store.jobs.enqueue({ type: "t", payload: { n: 3 }, dedupeKey: "t:3" });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toContain(3);
  });

  test("loop 内 handler 抛错被隔离，不中断其他 job 且循环存活", async () => {
    const store = new InMemoryMemoryStore();
    // good 先入队：验证一个 job 的 handler 抛错不影响其它 job，且 loop 不崩。
    // 注：in-memory 队列对永久失败 job 立即 FIFO 重试，队首失败 job 会阻塞队尾，
    // 这是 repository 语义（无 backoff/maxAttempts），loop 用 break-on-seen 防止本 tick 空转。
    await store.jobs.enqueue({ type: "good", payload: {}, dedupeKey: "good:1" });
    await store.jobs.enqueue({ type: "bad", payload: {}, dedupeKey: "bad:1" });

    let goodRan = false;
    const loop = startJobWorkerLoop(store.jobs, {
      workerId: "w",
      leaseMs: 1000,
      intervalMs: 5,
      handlers: {
        good: async () => {
          goodRan = true;
        },
        bad: async () => {
          throw new Error("boom");
        },
      },
    });

    await expect(loop.tick()).resolves.not.toThrow();
    await loop.stop();
    expect(goodRan).toBe(true);
    await expect(store.jobs.list("failed")).resolves.toHaveLength(1);
  });
});
