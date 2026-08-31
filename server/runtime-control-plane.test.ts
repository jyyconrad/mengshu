import { describe, expect, test } from "vitest";

import { createRuntimeControlPlane } from "./runtime-control-plane.js";

describe("RuntimeHost control plane", () => {
  test("同一 home 的 fingerprint 稳定，快照跟随 host generation/readiness", () => {
    let generation = 2;
    const control = createRuntimeControlPlane({
      runtimeHome: "/tmp/mengshu-runtime-control-test",
      ownerId: "runtime-owner-1",
      host: {
        snapshot: () => ({
          state: "ready",
          ready: true,
          accepting: true,
          generation,
        }),
      },
    });

    const first = control.snapshot();
    generation = 3;
    const second = control.snapshot();

    expect(first).toMatchObject({
      protocolVersion: 1,
      ownerId: "runtime-owner-1",
      generation: 2,
      workerOwner: true,
    });
    expect(first.homeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.homeFingerprint).toBe(first.homeFingerprint);
    expect(second.generation).toBe(3);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
