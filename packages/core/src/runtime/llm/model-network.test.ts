import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getGlobalDispatcher } from "undici";
import { Embeddings } from "./embeddings.js";
import { OpenAiLlmClient } from "./llm-client.js";
import { getModelNetworkOptions } from "./model-network.js";

const proxyKeys = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
] as const;
const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function modelServer() {
  const requests: string[] = [];
  const port = await listen(http.createServer((request, response) => {
    requests.push(request.url!);
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/v1/embeddings"
      ? { data: [{ embedding: [0.1, 0.2] }] }
      : { choices: [{ message: { content: "本地模型响应" } }] }));
  }));
  return { port, requests, baseURL: `http://127.0.0.1:${port}/v1` };
}

/** 所有 CONNECT 只转发到本测试的 loopback 模型服务，不访问外网。 */
async function proxyServer(targetPort: number) {
  const connects: string[] = [];
  const server = http.createServer();
  server.on("connect", (request, socket, head) => {
    connects.push(request.url!);
    const upstream = net.connect(targetPort, "127.0.0.1");
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, connects };
}

async function refusingProxy() {
  const connects: string[] = [];
  const server = http.createServer();
  server.on("connect", (request, socket) => {
    connects.push(request.url!);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, connects };
}

function embeddings(baseURL = "http://model.invalid/v1") {
  return new Embeddings({ apiKey: "test-key", baseURL, model: "test-embedding", provider: "openai" },
    undefined, { maxRetries: 0 });
}

beforeEach(() => {
  for (const key of proxyKeys) vi.stubEnv(key, "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("模型客户端环境代理", () => {
  test("embedding 自动使用 HTTP_PROXY，无需 NODE_USE_ENV_PROXY", async () => {
    const model = await modelServer();
    const proxy = await proxyServer(model.port);
    vi.stubEnv("HTTP_PROXY", proxy.url);

    await expect(embeddings().embed("health check")).resolves.toEqual([0.1, 0.2]);
    expect(proxy.connects).toEqual(["model.invalid:80"]);
    expect(model.requests).toEqual(["/v1/embeddings"]);
  });

  test("LLM 使用同一环境代理规则", async () => {
    const model = await modelServer();
    const proxy = await proxyServer(model.port);
    vi.stubEnv("HTTP_PROXY", proxy.url);
    const llm = new OpenAiLlmClient({
      apiKey: "test-key", baseURL: "http://model.invalid/v1", model: "test-llm", provider: "openai",
    }, { maxRetries: 0 });

    await expect(llm.complete([{ role: "user", content: "health check" }]))
      .resolves.toBe("本地模型响应");
    expect(proxy.connects).toEqual(["model.invalid:80"]);
    expect(model.requests).toEqual(["/v1/chat/completions"]);
  });

  test.each(["127.0.0.1", "*"])("NO_PROXY=%s 让本地模型直连", async (noProxy) => {
    const model = await modelServer();
    const proxy = await proxyServer(model.port);
    vi.stubEnv("HTTP_PROXY", proxy.url);
    vi.stubEnv("NO_PROXY", noProxy);

    await expect(embeddings(model.baseURL).embed("health check")).resolves.toEqual([0.1, 0.2]);
    expect(proxy.connects).toEqual([]);
    expect(model.requests).toEqual(["/v1/embeddings"]);
  });

  test("小写代理变量优先于大写变量", async () => {
    const model = await modelServer();
    const preferred = await proxyServer(model.port);
    const ignored = await proxyServer(model.port);
    vi.stubEnv("http_proxy", preferred.url);
    vi.stubEnv("HTTP_PROXY", ignored.url);

    await expect(embeddings().embed("health check")).resolves.toEqual([0.1, 0.2]);
    expect(preferred.connects).toEqual(["model.invalid:80"]);
    expect(ignored.connects).toEqual([]);
  });

  test("ALL_PROXY 可作为 HTTP 代理后备", async () => {
    const model = await modelServer();
    const proxy = await proxyServer(model.port);
    vi.stubEnv("ALL_PROXY", proxy.url);

    await expect(embeddings().embed("health check")).resolves.toEqual([0.1, 0.2]);
    expect(proxy.connects).toEqual(["model.invalid:80"]);
  });

  test.each(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy"])(
    "HTTPS 请求使用 %s 指定的代理", async (key) => {
      const proxy = await refusingProxy();
      vi.stubEnv(key, proxy.url);
      const network = getModelNetworkOptions();

      // 在 CONNECT 阶段拒绝，验证 HTTPS 路由且不连接任何外部 TLS 服务。
      await expect(network.fetch!("https://model.invalid/v1", {
        ...network.fetchOptions, signal: AbortSignal.timeout(1000),
      })).rejects.toThrow();
      expect(proxy.connects).toEqual(["model.invalid:443"]);
    },
  );

  test("HTTPS_PROXY 优先于 HTTP_PROXY 和 ALL_PROXY", async () => {
    const preferred = await refusingProxy();
    const ignored = await refusingProxy();
    vi.stubEnv("HTTPS_PROXY", preferred.url);
    vi.stubEnv("HTTP_PROXY", ignored.url);
    vi.stubEnv("ALL_PROXY", ignored.url);
    const network = getModelNetworkOptions();

    await expect(network.fetch!("https://model.invalid/v1", {
      ...network.fetchOptions, signal: AbortSignal.timeout(1000),
    })).rejects.toThrow();
    expect(preferred.connects).toEqual(["model.invalid:443"]);
    expect(ignored.connects).toEqual([]);
  });

  test("小写 no_proxy 支持指定端口并优先于 NO_PROXY", async () => {
    const model = await modelServer();
    const proxy = await proxyServer(model.port);
    vi.stubEnv("HTTP_PROXY", proxy.url);
    vi.stubEnv("no_proxy", `127.0.0.1:${model.port}`);
    vi.stubEnv("NO_PROXY", "other.invalid");

    await expect(embeddings(model.baseURL).embed("health check")).resolves.toEqual([0.1, 0.2]);
    expect(proxy.connects).toEqual([]);
  });

  test("未配置代理时模型仍可直连", async () => {
    const model = await modelServer();
    await expect(embeddings(model.baseURL).embed("health check")).resolves.toEqual([0.1, 0.2]);
    expect(model.requests).toEqual(["/v1/embeddings"]);
  });

  test("注入的客户端不受环境代理配置影响", async () => {
    vi.stubEnv("HTTPS_PROXY", "not-a-proxy-url");
    const embedding = new Embeddings({
      apiKey: "test-key", baseURL: "https://model.invalid/v1", provider: "openai",
    }, undefined, { client: { embeddings: { create: async () => ({ data: [{ embedding: [1] }] }) } } });
    const llm = new OpenAiLlmClient({
      apiKey: "test-key", baseURL: "https://model.invalid/v1", model: "test-llm", provider: "openai",
    }, { client: { chat: { completions: {
      create: async () => ({ choices: [{ message: { content: "fake" } }] }),
    } } } });

    await expect(embedding.embed("health check")).resolves.toEqual([1]);
    await expect(llm.complete([{ role: "user", content: "health check" }])).resolves.toBe("fake");
  });

  test("无代理时保留默认 fetch 和宿主 dispatcher", () => {
    const original = getGlobalDispatcher();
    expect(getModelNetworkOptions()).toEqual({});
    expect(getGlobalDispatcher()).toBe(original);
  });

  test("同一代理配置复用连接池，不改动宿主的全局 dispatcher", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7897");
    const original = getGlobalDispatcher();
    const first = getModelNetworkOptions();
    const second = getModelNetworkOptions();
    expect(first.fetchOptions?.dispatcher).toBeDefined();
    expect(first.fetchOptions?.dispatcher).toBe(second.fetchOptions?.dispatcher);
    expect(getGlobalDispatcher()).toBe(original);
  });

  test("无效代理报错不泄露代理凭据", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy-user:proxy-secret@127.0.0.1:invalid");
    expect(() => getModelNetworkOptions()).toThrow(/代理配置无效/);
    expect(() => getModelNetworkOptions()).not.toThrow(/proxy-user|proxy-secret/);
  });
});
