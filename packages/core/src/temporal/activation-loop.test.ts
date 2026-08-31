import { describe, expect, test, vi } from "vitest";
import { TemporalActivationLoop } from "./activation-loop.js";

describe("TemporalActivationLoop", () => {
  test("runs immediately, prevents overlap, reports failures and stops the interval", async () => {
    let callback: (() => void) | undefined;
    let release: (() => void) | undefined;
    const activateDue = vi.fn(() => new Promise<number>((resolve) => { release = () => resolve(1); }));
    const materializeExpired = vi.fn(async () => 1);
    const retryPendingPurges = vi.fn(async () => ({ attempted: 0, completed: 0, failed: 0 }));
    const clearInterval = vi.fn();
    const onError = vi.fn();
    const loop = new TemporalActivationLoop({ activateDue, materializeExpired, retryPendingPurges }, {
      intervalMs: 100,
      batchSize: 7,
      onError,
      scheduler: {
        setInterval: (next) => { callback = next; return "timer"; },
        clearInterval,
      },
    });
    loop.start();
    callback?.();
    expect(activateDue).toHaveBeenCalledTimes(1);
    expect(activateDue).toHaveBeenCalledWith({ limit: 7 });
    expect(materializeExpired).toHaveBeenCalledWith({ limit: 7 });
    expect(retryPendingPurges).toHaveBeenCalledWith({ limit: 7 });
    release?.();
    await loop.tick();
    await loop.stop();
    expect(clearInterval).toHaveBeenCalledWith("timer");
    expect(onError).not.toHaveBeenCalled();
  });

  test("isolates a reconciliation failure", async () => {
    const onError = vi.fn();
    const loop = new TemporalActivationLoop({
      activateDue: async () => { throw new Error("database detail"); },
      materializeExpired: async () => 0,
      retryPendingPurges: async () => ({ attempted: 0, completed: 0, failed: 0 }),
    }, {
      intervalMs: 100,
      onError,
      scheduler: { setInterval: () => "timer", clearInterval: vi.fn() },
    });
    loop.start();
    await loop.tick();
    expect(onError).toHaveBeenCalledOnce();
    await loop.stop();
  });
});
