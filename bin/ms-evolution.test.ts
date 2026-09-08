import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { fingerprintRuntimeHome } from "../packages/core/src/runtime/host-contract.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dirs: string[] = [], servers: Server[] = [];
const ownerSecret = "independent-cli-owner-fixture-only";
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(withOwner = true) {
  const home = await mkdtemp(join(tmpdir(), "mengshu-native-cli-owner-")); dirs.push(home);
  const homeFingerprint = fingerprintRuntimeHome(home);
  const calls: { path: string; owner?: string; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const owner = request.headers["x-mengshu-owner-token"] as string | undefined;
    calls.push({ path: request.url!, owner, body: raw ? JSON.parse(raw) : undefined });
    response.setHeader("content-type", "application/json");
    response.setHeader("x-mengshu-runtime-owner", "cli-test-owner");
    response.setHeader("x-mengshu-runtime-home", homeFingerprint);
    response.setHeader("x-mengshu-runtime-generation", "1");
    if (request.url === "/v1/runtime") {
      response.end(JSON.stringify({ protocolVersion: 1, ownerId: "cli-test-owner", homeFingerprint, generation: 1,
        state: "ready", ready: true, accepting: true, workerOwner: true }));
      return;
    }
    const ordinary = request.url === "/v1/evolution/run" ||
      request.url === "/v1/evolution/resume" && calls.at(-1)!.body &&
        (calls.at(-1)!.body as { batchId?: string }).batchId === "ordinary-batch";
    response.statusCode = ordinary || owner === ownerSecret ? 200 : 403;
    response.end(JSON.stringify({ ok: response.statusCode === 200 }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener unavailable");
  const configPath = join(home, "operator-config.json");
  await writeFile(configPath, JSON.stringify({ embedding: { apiKey: "offline-fixture", baseURL: "http://127.0.0.1:9/v1" },
    dbType: "postgres", postgres: { host: "127.0.0.1", port: 9, database: "never-open", user: "fixture", password: "fixture" },
    features: { continuousMemoryEvolution: true }, ...(withOwner ? { evolution: { control: { ownerSecret } } } : {}),
    server: { host: "127.0.0.1", port: address.port } }));
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(root, "bin/ms.ts"), "evolve", ...args], {
      cwd: home, env: { ...process.env, MENGSHU_HOME: home, MENGSHU_CONFIG: configPath,
        MENGSHU_RUNTIME_URL: `http://127.0.0.1:${address.port}`, MENGSHU_RUNTIME_SOCKET: "",
        MENGSHU_AUTHORITY_JSON: "", MENGSHU_AUTHORITY_FILE: "", MENGSHU_RUN_LIVE_TESTS: "0",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
  return { home, calls, run };
}

const signedRequest = { statement: { issuer: "fixture", scopeFingerprint: "a".repeat(64), evidenceId: "evidence", sourceId: "notes",
  revision: "r1", snapshotHash: "b".repeat(64), rootEvidenceId: "root", origin: "external", trust: "verified_document",
  authorizedTargetRefs: [], issuedAt: 1, expiresAt: 2 }, signature: "a".repeat(86), expectedRevision: 0, idempotencyKey: "attest" };
const revokeRequest = { sourceId: "notes", sourceRevision: "r1", expectedRevision: 0, idempotencyKey: "revoke",
  operationIdempotencyKey: "revoke-operation", expiresAt: 2 };
const grantsRequest = { grants: [], expectedRevision: 0, idempotencyKey: "grants" };
const controlRequest = { input: { mode: "control", work: { kind: "source_reconcile", sourceId: "notes" } }, action: "execute_control",
  idempotencyKey: "control", limits: { maxRecords: 12, maxFiles: 2, maxBytes: 1000, maxDurationMs: 1000 } };
const undoRequest = { operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64), expectedRevision: 0,
  idempotencyKey: "approve-undo", operationIdempotencyKey: "undo", expiresAt: 1000 };

describe("real ms evolution startup credentials", () => {
  test.each([
    { command: "source-attest", args: ["--request", JSON.stringify(signedRequest)], path: "source/attest", body: signedRequest },
    { command: "source-revoke-attestation", args: ["--request", JSON.stringify(revokeRequest)], path: "source/revoke-attestation", body: revokeRequest },
    { command: "reuse-status", args: [], path: "reuse/status", body: {} },
    { command: "reuse-grants", args: ["--request", JSON.stringify(grantsRequest)], path: "reuse/grants", body: grantsRequest },
    { command: "reuse-evaluate", args: ["plan-one"], path: "reuse/evaluate", body: { planId: "plan-one" } },
    { command: "control", args: ["--request", JSON.stringify(controlRequest)], path: "control/run", body: controlRequest },
    { command: "undo-preview", args: [undoRequest.operationReceiptId], path: "control/undo-preview", body: { operationReceiptId: undoRequest.operationReceiptId } },
    { command: "undo-approve", args: ["--request", JSON.stringify(undoRequest)], path: "control/undo-approve", body: undoRequest },
    { command: "resume", args: ["control-batch"], path: "resume", body: { batchId: "control-batch" } },
  ])("$command forwards the independently configured owner header through the actual entry point", async row => {
    const f = await fixture();
    const result = await f.run([row.command, ...row.args]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(f.calls).toEqual([{ path: "/v1/runtime", owner: ownerSecret, body: undefined },
      { path: `/v1/evolution/${row.path}`, owner: ownerSecret, body: row.body }]);
    expect(result.stdout).not.toContain(ownerSecret); expect(result.stderr).not.toContain(ownerSecret);
    expect(existsSync(join(f.home, "evolution"))).toBe(false); expect(existsSync(join(f.home, "run"))).toBe(false);
  }, 15_000);

  test("control input cannot inject authority and absent owner credentials do not get invented", async () => {
    const f = await fixture();
    const invalid = await f.run(["control", "--request", JSON.stringify({ ...controlRequest, authority: "injected" })]);
    expect(invalid.code).not.toBe(0); expect(f.calls).toEqual([]);
    expect(invalid.stdout).not.toContain(ownerSecret); expect(invalid.stderr).not.toContain(ownerSecret);
    const unauthenticated = await fixture(false);
    const result = await unauthenticated.run(["undo-preview", undoRequest.operationReceiptId]);
    expect(result.code).not.toBe(0);
    expect(unauthenticated.calls.every(call => call.owner === undefined)).toBe(true);
    expect(unauthenticated.calls.at(-1)?.path).toBe("/v1/evolution/control/undo-preview");
    expect(result.stdout).not.toContain(ownerSecret); expect(result.stderr).not.toContain(ownerSecret);
  }, 30_000);

  test("ordinary inventory never receives owner credentials merely because the config contains them", async () => {
    const f = await fixture();
    const result = await f.run(["inventory", "--idempotency-key", "ordinary"]);
    expect(result.code, result.stderr).toBe(0);
    expect(f.calls.every(call => call.owner === undefined)).toBe(true);
    expect(f.calls[1]).toMatchObject({ path: "/v1/evolution/run", body: { action: "preview" } });
    expect(existsSync(join(f.home, "evolution"))).toBe(false);
  }, 15_000);

  test("resume without a configured owner remains usable only for ordinary batches", async () => {
    const f = await fixture(false);
    expect((await f.run(["resume", "ordinary-batch"])).code).toBe(0);
    expect((await f.run(["resume", "control-batch"])).code).not.toBe(0);
    expect(f.calls.every(call => call.owner === undefined)).toBe(true);
    expect(f.calls.filter(call => call.path === "/v1/evolution/resume").map(call => call.body))
      .toEqual([{ batchId: "ordinary-batch" }, { batchId: "control-batch" }]);
  }, 30_000);
});
