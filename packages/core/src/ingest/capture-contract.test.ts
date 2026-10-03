import { describe, expect, test } from "vitest";

import type { MemoryScope, SourceRevisionRef } from "../domain/types.js";
import {
  captureIdempotencyKey,
  isCaptureStatus,
  type RawArchivePort,
} from "./capture-contract.js";

const scope: MemoryScope = {
  tenantId: "local",
  userId: "u1",
  appId: "codex",
  projectId: "memory-autodb",
  agentId: "root",
  namespace: "memories",
  visibility: "private",
};

const source: SourceRevisionRef = {
  sourceId: "session-1",
  revision: "rev-1",
  payloadHash: "a".repeat(64),
};

describe("capture contract", () => {
  test("幂等键覆盖 scope、revision 与 payload hash，且不创建 wiki 目录", async () => {
    const fingerprint = "b".repeat(64);
    const key = captureIdempotencyKey({ scopeFingerprint: fingerprint, source });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(captureIdempotencyKey({ scopeFingerprint: fingerprint, source })).toBe(key);
    expect(captureIdempotencyKey({
      scopeFingerprint: fingerprint,
      source: { ...source, payloadHash: "c".repeat(64) },
    })).not.toBe(key);
    expect(isCaptureStatus("captured_local_pending")).toBe(true);
    expect(isCaptureStatus("published")).toBe(false);

    const files = new Map<string, Uint8Array>();
    const archive: RawArchivePort = {
      async put(input) {
        expect(input.manifest.relativePath.startsWith("wiki/")).toBe(false);
        files.set(input.manifest.captureId, input.bytes);
      },
      async read(manifest) {
        const bytes = files.get(manifest.captureId);
        if (!bytes) throw new Error("missing");
        return bytes;
      },
    };
    const manifest = {
      captureId: "cap-1",
      scope,
      source,
      byteLength: 4,
      mediaType: "text/plain",
      relativePath: "raw/sources/session-1/rev-1/content.txt",
    };
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await archive.put({ manifest, bytes });
    await expect(archive.read(manifest)).resolves.toEqual(bytes);
    expect(files.size).toBe(1);
  });
});
