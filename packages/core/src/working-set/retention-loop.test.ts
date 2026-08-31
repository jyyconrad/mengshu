import { describe, expect, test, vi } from "vitest";

import { WorkingSetRetentionLoop } from "./retention-loop.js";

describe("WorkingSetRetentionLoop", () => {
  test("runs immediately, prevents overlap, reports failures, and stops cleanly", async () => {
    let resolveFirst: ((value: { sessions: number; receipts: []; failedSessions: number }) => void)
      | undefined;
    const runRetentionCleanup = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ sessions: 1, receipts: [], failedSessions: 1 });
    const callbacks: Array<() => void> = [];
    const clearInterval = vi.fn();
    const onError = vi.fn();
    const loop = new WorkingSetRetentionLoop({ runRetentionCleanup }, {
      intervalMs: 1_000,
      batchSize: 10,
      scheduler: {
        setInterval: (callback) => { callbacks.push(callback); return "handle"; },
        clearInterval,
      },
      onError,
    });

    loop.start();
    expect(runRetentionCleanup).toHaveBeenCalledTimes(1);
    callbacks[0]?.();
    expect(runRetentionCleanup).toHaveBeenCalledTimes(1);
    resolveFirst?.({ sessions: 1, receipts: [], failedSessions: 0 });
    await loop.tick();
    await loop.tick();
    expect(runRetentionCleanup).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);

    await loop.stop();
    expect(clearInterval).toHaveBeenCalledWith("handle");
  });
});
