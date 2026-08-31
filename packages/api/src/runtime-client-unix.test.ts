import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  RuntimeClient,
  RuntimeClientError,
  createUnixSocketRuntimeClientTransport,
} from "./runtime-client.js";

const homeFingerprint = "a".repeat(64);
let directory: string | undefined;
let server: http.Server | undefined;

async function startSocketServer(): Promise<string> {
  directory = mkdtempSync(join(tmpdir(), "mengshu-runtime-uds-"));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "runtime.sock");
  server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("x-mengshu-runtime-owner", "runtime-owner-1");
    response.setHeader("x-mengshu-runtime-home", homeFingerprint);
    response.setHeader("x-mengshu-runtime-generation", "1");
    response.end(JSON.stringify(request.url === "/v1/runtime" ? {
      protocolVersion: 1,
      ownerId: "runtime-owner-1",
      homeFingerprint,
      generation: 1,
      state: "ready",
      ready: true,
      accepting: true,
      workerOwner: true,
    } : { ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return socketPath;
}

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Unix socket RuntimeClient transport", () => {
  test("invokes a runtime through an owner-only socket", async () => {
    const socketPath = await startSocketServer();
    const client = new RuntimeClient({
      transport: createUnixSocketRuntimeClientTransport({ socketPath }),
      expectedHomeFingerprint: homeFingerprint,
    });
    await expect(client.invoke<{ ok: boolean }>({ method: "GET", path: "/v1/health" }))
      .resolves.toEqual({ ok: true });
  });

  test("rejects a socket directory that is accessible by group or others", async () => {
    const socketPath = await startSocketServer();
    chmodSync(directory!, 0o755);
    const client = new RuntimeClient({
      transport: createUnixSocketRuntimeClientTransport({ socketPath }),
      expectedHomeFingerprint: homeFingerprint,
    });
    await expect(client.connect()).rejects.toEqual(
      new RuntimeClientError("RUNTIME_TRANSPORT_FAILED"),
    );
  });
});
