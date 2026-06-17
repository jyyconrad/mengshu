/**
 * Minimal durable job worker runner.
 *
 * Worker 只从 `JobRepository` lease 一个 job，调用对应 handler，并根据结果
 * complete/fail；重试、过期 lease 恢复由 repository 语义保证。
 *
 * `startJobWorkerLoop` 在此之上提供后台轮询：按 intervalMs 周期性 drain 队列，
 * 返回 { tick, stop } 句柄，由 daemon 在 listen/stop 生命周期内启停。
 */

import type { JobRecord, JobRepository } from "../storage/repositories/types.js";

export type JobHandler = (job: JobRecord) => Promise<unknown>;

export interface RunNextJobOptions {
  workerId: string;
  leaseMs: number;
  handlers: Record<string, JobHandler | undefined>;
}

export type RunNextJobResult =
  | { status: "idle" }
  | { status: "completed"; id: string; type: string; result: unknown }
  | { status: "failed"; id: string; type: string; error: string };

export async function runNextJob(
  repository: JobRepository,
  options: RunNextJobOptions,
): Promise<RunNextJobResult> {
  const job = await repository.lease({
    workerId: options.workerId,
    leaseMs: options.leaseMs,
  });
  if (!job) {
    return { status: "idle" };
  }

  const handler = options.handlers[job.type];
  if (!handler) {
    const error = `No handler registered for job type: ${job.type}`;
    await repository.fail(job.id, error);
    return { status: "failed", id: job.id, type: job.type, error };
  }

  try {
    const result = await handler(job);
    await repository.complete(job.id);
    return { status: "completed", id: job.id, type: job.type, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await repository.fail(job.id, error);
    return { status: "failed", id: job.id, type: job.type, error };
  }
}

export interface JobWorkerLoopOptions {
  workerId: string;
  leaseMs: number;
  /** 轮询周期（毫秒）。 */
  intervalMs: number;
  handlers: Record<string, JobHandler | undefined>;
  /** 单次 tick 最多处理多少 job，防止饥饿/死循环（默认 50）。 */
  maxPerTick?: number;
}

export interface JobWorkerLoopHandle {
  /** 手动 drain 一次（测试用，确定性）。 */
  tick(): Promise<void>;
  /** 停止轮询并清理定时器。 */
  stop(): Promise<void>;
}

/**
 * 后台 worker 轮询循环。
 *
 * 每个 interval drain 队列：连续调用 runNextJob 直到 idle 或达到 maxPerTick。
 * handler 抛错由 runNextJob 内部 fail 掉，不会中断后续 job。
 */
export function startJobWorkerLoop(
  repository: JobRepository,
  options: JobWorkerLoopOptions,
): JobWorkerLoopHandle {
  const maxPerTick = options.maxPerTick ?? 50;
  let stopped = false;
  let draining = false;

  async function tick(): Promise<void> {
    if (stopped || draining) {
      return;
    }
    draining = true;
    try {
      // 记录本 tick 已处理的 job id：repository 会重新 lease failed job，
      // 若某 job 永久失败会无限重试并饿死后续 job，因此每个 distinct job
      // 本 tick 只处理一次，重试留到下个 tick。
      const seen = new Set<string>();
      for (let i = 0; i < maxPerTick; i += 1) {
        const result = await runNextJob(repository, {
          workerId: options.workerId,
          leaseMs: options.leaseMs,
          handlers: options.handlers,
        });
        if (result.status === "idle") {
          break;
        }
        if (seen.has(result.id)) {
          // 已回到一个本 tick 处理过的 job（多为重试中的失败 job），停止 drain。
          break;
        }
        seen.add(result.id);
      }
    } finally {
      draining = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);
  // 不阻塞进程退出（Node 环境）。
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    tick,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      // 等待进行中的 drain 结束。
      while (draining) {
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}
