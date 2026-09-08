import type { ClientOptions } from "openai";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";

// 同一进程的模型客户端共享连接池；代理只绑定到模型请求，不修改宿主全局网络行为。
const proxyDispatchers = new Map<string, EnvHttpProxyAgent>();

function proxyEnv(name: string): string {
  return process.env[name.toLowerCase()] || process.env[name] || "";
}

/** 默认继承运行环境代理；无代理时保留 SDK/宿主原有 fetch。 */
export function getModelNetworkOptions(): Pick<ClientOptions, "fetch" | "fetchOptions"> {
  const allProxy = proxyEnv("ALL_PROXY");
  const httpProxy = proxyEnv("HTTP_PROXY") || allProxy;
  const httpsProxy = proxyEnv("HTTPS_PROXY") || allProxy || httpProxy;
  const noProxy = proxyEnv("NO_PROXY");
  if (!httpProxy && !httpsProxy) return {};

  const key = JSON.stringify([httpProxy, httpsProxy, noProxy]);
  let dispatcher = proxyDispatchers.get(key);
  if (!dispatcher) {
    try {
      dispatcher = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
    } catch {
      // URL 解析异常可能包含代理账号密码，不能把原始错误传给 CLI 或日志。
      throw new Error("系统代理配置无效：请检查 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY（仅支持 HTTP/HTTPS 代理）。");
    }
    proxyDispatchers.set(key, dispatcher);
  }

  return {
    // SDK 使用标准 fetch 合同；dispatcher 与 fetch 必须来自同一 undici 实现。
    fetch: proxyFetch as unknown as ClientOptions["fetch"],
    fetchOptions: { dispatcher },
  };
}
