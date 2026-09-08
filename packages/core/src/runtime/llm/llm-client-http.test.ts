import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenAiLlmClient, type ChatCompletionClient } from "./llm-client.js";
import type { RuntimeCostEvent } from "../../cost/runtime-cost.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const messages = [{ role: "user" as const, content: "local fixture" }];
const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
const invoke = (llm: OpenAiLlmClient, structured: boolean, options = {}) => structured
  ? llm.extractStructured(messages, schema, options) : llm.complete(messages, options);

async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  // These are loopback tests only; never inherit a workstation's external model proxy.
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  return { provider: "openai" as const, apiKey: "local-fixture", model: "configured-model-verbatim", baseURL: `http://127.0.0.1:${address.port}/v1` };
}

describe("real SDK request cancellation and exact attempt accounting", () => {
  for (const structured of [false, true]) {
    const label = structured ? "structured" : "complete";
    test(`${label}: puts signal/timeout/retry only in request options, not the JSON body`, async () => {
      const create = vi.fn<ChatCompletionClient["chat"]["completions"]["create"]>(async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
      const llm = new OpenAiLlmClient({ provider: "openai", apiKey: "fixture", model: "unchanged" }, { client: { chat: { completions: { create } } }, maxRetries: 0 });
      await invoke(llm, structured, { timeout: 1234 });
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty("signal");
      expect(create.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal), timeout: 1234, maxRetries: 0 });
    });

    test(`${label}: local HTTP 429 performs only the configured p-retry attempts`, async () => {
      let requests = 0;
      const config = await endpoint((request, response) => {
        requests++;
        request.resume();
        response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
        response.end(JSON.stringify({ error: { message: "fixture limited", type: "rate_limit", code: "rate_limit" } }));
      });
      for (const maxRetries of [0, 2]) {
        requests = 0;
        const events: RuntimeCostEvent[] = [];
        const llm = new OpenAiLlmClient(config, { maxRetries, minTimeout: 1, maxTimeout: 1, costLedger: { append: async event => { events.push(event); } } });
        await expect(invoke(llm, structured)).rejects.toThrow();
        expect(requests).toBe(maxRetries + 1);
        expect(events.map(event => [event.attempt, event.status, event.estimatedMinorUnits])).toEqual(
          Array.from({ length: maxRetries + 1 }, (_, index) => [index + 1, "failed", null]),
        );
      }
    });

    test(`${label}: abort closes a stalled real HTTP request without SDK retry`, async () => {
      let requests = 0;
      let closedBeforeResponse = false;
      const bodies: string[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      const config = await endpoint((request, response) => {
        requests++;
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(Buffer.from(chunk)));
        request.on("end", () => bodies.push(Buffer.concat(chunks).toString("utf8")));
        response.on("close", () => { if (!response.writableEnded) closedBeforeResponse = true; });
        // A bounded watchdog makes the old, un-aborted implementation fail without hanging the suite.
        timers.push(setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })); }, 500));
      });
      cleanup.push(async () => { for (const timer of timers) clearTimeout(timer); });
      const events: RuntimeCostEvent[] = [];
      const llm = new OpenAiLlmClient(config, { maxRetries: 2, minTimeout: 1, maxTimeout: 1, costLedger: { append: async event => { events.push(event); } } });
      await expect(invoke(llm, structured, { timeout: 100 })).rejects.toThrow();
      await vi.waitFor(() => expect(closedBeforeResponse).toBe(true));
      expect(requests).toBe(1);
      expect(events).toMatchObject([{ attempt: 1, status: "failed" }]);
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!)).not.toHaveProperty("signal");
    });

    test(`${label}: caller cancellation stops a real request and p-retry backoff`, async () => {
      for (const rateLimited of [false, true]) {
        const controller = new AbortController();
        let requests = 0;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const config = await endpoint((request, response) => {
          requests++;
          request.resume();
          timers.push(setTimeout(() => controller.abort(new Error("fixture owner cancelled")), 20));
          if (rateLimited) {
            response.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
            response.end('{"error":{"message":"fixture limited"}}');
          } else timers.push(setTimeout(() => response.end('{"choices":[{"message":{"content":"late"}}]}'), 500));
        });
        cleanup.push(async () => { for (const timer of timers) clearTimeout(timer); });
        const events: RuntimeCostEvent[] = [];
        const llm = new OpenAiLlmClient(config, { maxRetries: 2, minTimeout: 5000, maxTimeout: 5000,
          costLedger: { append: async event => { events.push(event); } } });
        await expect(invoke(llm, structured, { signal: controller.signal })).rejects.toThrow("fixture owner cancelled");
        expect(requests).toBe(1);
        expect(events).toMatchObject([{ attempt: 1, status: "failed" }]);
      }
    });
  }

  test("queued cancellation never creates a provider attempt and successful calls release deadline timers", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const create = vi.fn<ChatCompletionClient["chat"]["completions"]["create"]>(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { choices: [{ message: { content: "ok" } }] };
    });
    const events: RuntimeCostEvent[] = [];
    const llm = new OpenAiLlmClient({ provider: "openai", apiKey: "fixture", model: "fixture" }, {
      client: { chat: { completions: { create } } }, concurrency: 1, maxRetries: 0,
      costLedger: { append: async event => { events.push(event); } },
    });
    const first = llm.complete(messages);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const second = llm.complete(messages, { signal: controller.signal }).catch(error => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await expect(first).resolves.toBe("ok");
    expect(await second).toBeInstanceOf(Error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
