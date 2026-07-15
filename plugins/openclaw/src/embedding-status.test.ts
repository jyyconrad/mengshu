import { describe, expect, test } from "vitest";

import { createEmbeddingSpace } from "../../../packages/core/src/domain/embedding-space.js";
import {
  EmbeddingReadGuard,
  EmbeddingWriteGuard,
} from "../../../packages/core/src/storage/embedding-space-policy.js";
import { describeOpenClawEmbeddingStatus } from "./embedding-status.js";

const runtimeSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
  normalization: "none",
});

const otherSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "text-embedding-3-large",
  dim: 3072,
  normalization: "none",
});

describe("OpenClaw embedding registry status", () => {
  test("Postgres exposes active only for a write-compatible persisted space", () => {
    const guard = new EmbeddingWriteGuard(runtimeSpace, "enforced");
    const readGuard = new EmbeddingReadGuard(runtimeSpace);
    guard.update({ status: "ready", activeSpace: runtimeSpace });
    readGuard.update({ status: "ready", activeSpace: runtimeSpace });

    expect(describeOpenClawEmbeddingStatus(
      "postgres",
      guard.snapshot(),
      readGuard.snapshot(),
      { state: "ready", ready: true },
    )).toEqual({
      status: "active",
      writeMode: "write-enabled",
      embeddingReadMode: "same-space-ann",
      lifecycleState: "ready",
      lifecycleReady: true,
      reasonCode: "active-space-match",
    });
  });

  test.each([
    ["missing", { status: "missing" } as const],
    ["unavailable", { status: "unavailable" } as const],
    ["mismatch", { status: "ready", activeSpace: otherSpace } as const],
  ])("Postgres %s remains read-only", (_label, registry) => {
    const guard = new EmbeddingWriteGuard(runtimeSpace, "enforced");
    const readGuard = new EmbeddingReadGuard(runtimeSpace);
    guard.update(registry);
    readGuard.update(registry);

    expect(describeOpenClawEmbeddingStatus(
      "postgres",
      guard.snapshot(),
      readGuard.snapshot(),
      { state: "degraded", ready: false },
    )).toMatchObject({
      status: _label,
      writeMode: "read-only",
      embeddingReadMode: "fail-closed",
      lifecycleState: "degraded",
      lifecycleReady: false,
    });
  });

  test("non-Postgres reports legacy write-through rather than pretending active", () => {
    const guard = new EmbeddingWriteGuard(runtimeSpace, "legacy-write-through");
    const readGuard = new EmbeddingReadGuard(runtimeSpace);

    expect(describeOpenClawEmbeddingStatus(
      "lancedb",
      guard.snapshot(),
      readGuard.snapshot(),
      { state: "ready", ready: true },
    )).toEqual({
      status: "legacy",
      writeMode: "legacy-write-through",
      embeddingReadMode: "fail-closed",
      lifecycleState: "ready",
      lifecycleReady: true,
      reasonCode: "registry-unavailable",
    });
  });

  test("Postgres with a non-enforcing guard is explicitly unsupported and read-only", () => {
    const guard = new EmbeddingWriteGuard(runtimeSpace, "legacy-write-through");
    const readGuard = new EmbeddingReadGuard(runtimeSpace);

    expect(describeOpenClawEmbeddingStatus(
      "postgres",
      guard.snapshot(),
      readGuard.snapshot(),
      { state: "created", ready: false },
    )).toEqual({
      status: "unsupported",
      writeMode: "read-only",
      embeddingReadMode: "fail-closed",
      lifecycleState: "created",
      lifecycleReady: false,
      reasonCode: "registry-unavailable",
    });
  });

  test("status does not contain descriptor URLs or secret-bearing fields", () => {
    const guard = new EmbeddingWriteGuard(runtimeSpace, "enforced");
    const readGuard = new EmbeddingReadGuard(runtimeSpace);
    guard.update({ status: "ready", activeSpace: runtimeSpace });
    readGuard.update({ status: "ready", activeSpace: runtimeSpace });
    const output = JSON.stringify(describeOpenClawEmbeddingStatus(
      "postgres",
      guard.snapshot(),
      readGuard.snapshot(),
      { state: "ready", ready: true },
    ));

    expect(output).not.toContain("api.openai.com");
    expect(output).not.toContain("apiKey");
  });
});
