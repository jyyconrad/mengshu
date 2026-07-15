/**
 * Transport-agnostic MCP memory server facade.
 *
 * 这个 facade 只负责工具发现和调用，不启动 stdio/http transport；这样 M3 可以先
 * 固化工具契约，避免过早引入 MCP SDK 依赖。
 */

import type { MemoryService } from "../../../core/service-types.js";
import fs from "node:fs";
import path from "node:path";
import type { AuthorityScopedForgetCapability } from "../../core/src/service/authority-forget-capability.js";
import type { AgentFastPathService } from "../../api/src/agent-fast-path/index.js";
import type { IngestionPipeline } from "../../core/src/ingest/pipeline.js";
import type { LlmClient } from "../../core/src/runtime/llm/llm-client.js";
import {
  resolveAuthorityScope,
  type AuthorityScope,
} from "../../core/src/domain/authority-scope.js";
import type { MemoryScope } from "../../core/src/domain/types.js";
import {
  createMcpMemoryTools,
  freezeMcpToolRegistry,
  type McpMemoryTool,
} from "./tools.js";
import { formatMcpToolError } from "./tool-error.js";

export interface McpMemoryServer {
  name: string;
  listTools(): readonly McpMemoryTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface McpMemoryServerOptions {
  service: MemoryService;
  forgetCapability?: AuthorityScopedForgetCapability;
  authority: AuthorityScope;
  /** 启动期必须与 authority 精确匹配；本层不生成身份或 scope 默认值。 */
  defaultScope: MemoryScope;
  namespaces?: string[];
  agentFastPath?: AgentFastPathService;
  pipeline?: IngestionPipeline;
  llmClient?: LlmClient;
}

export interface McpServerAuthorityConfig {
  authority: AuthorityScope;
  defaultScope: MemoryScope;
}

const MAX_AUTHORITY_BYTES = 64 * 1024;
const TOP_LEVEL_KEYS = ["authority", "defaultScope"] as const;
const AUTHORITY_KEYS = ["tenantId", "userId", "allow"] as const;
const ALLOW_KEYS = [
  "appIds",
  "projectIds",
  "agentIds",
  "namespaces",
  "visibilities",
] as const;
const SCOPE_REQUIRED_KEYS = [
  "tenantId",
  "appId",
  "userId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
] as const;
const SCOPE_OPTIONAL_KEYS = ["sessionId", "workspaceId"] as const;

function authorityConfigError(message: string): Error {
  return new Error(`MCP authority configuration ${message}`);
}

function readExactDataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityConfigError("is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw authorityConfigError("is invalid");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw authorityConfigError("is invalid");
  }
  const keys = ownKeys as string[];
  if (
    !keys.every((key) => allowed.includes(key)) ||
    !required.every((key) => keys.includes(key))
  ) {
    throw authorityConfigError("is invalid");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw authorityConfigError("is invalid");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function copyExactArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw authorityConfigError("is invalid");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw authorityConfigError("is invalid");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw authorityConfigError("is invalid");
  }
  const length = lengthDescriptor.value as number;
  const expectedKeys = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => !expectedKeys.has(key as string))
  ) {
    throw authorityConfigError("is invalid");
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw authorityConfigError("is invalid");
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function deepFreezeAuthorityConfig(config: McpServerAuthorityConfig): McpServerAuthorityConfig {
  Object.freeze(config.authority.allow.appIds);
  Object.freeze(config.authority.allow.projectIds);
  Object.freeze(config.authority.allow.agentIds);
  Object.freeze(config.authority.allow.namespaces);
  Object.freeze(config.authority.allow.visibilities);
  Object.freeze(config.authority.allow);
  Object.freeze(config.authority);
  Object.freeze(config.defaultScope);
  return Object.freeze(config);
}

/** Strict host-owned contract parser. It never invents tenant/user/defaults. */
export function parseMcpServerAuthorityConfig(
  raw: unknown,
): McpServerAuthorityConfig {
  try {
    const root = readExactDataRecord(raw, TOP_LEVEL_KEYS, TOP_LEVEL_KEYS);
    const authorityRecord = readExactDataRecord(
      root.authority,
      AUTHORITY_KEYS,
      AUTHORITY_KEYS,
    );
    const allowRecord = readExactDataRecord(authorityRecord.allow, ALLOW_KEYS, ALLOW_KEYS);
    const defaultScopeRecord = readExactDataRecord(
      root.defaultScope,
      [...SCOPE_REQUIRED_KEYS, ...SCOPE_OPTIONAL_KEYS],
      SCOPE_REQUIRED_KEYS,
    );
    const authority: AuthorityScope = {
      tenantId: authorityRecord.tenantId as string,
      userId: authorityRecord.userId as string,
      allow: {
        appIds: copyExactArray(allowRecord.appIds) as string[],
        projectIds: copyExactArray(allowRecord.projectIds) as string[],
        agentIds: copyExactArray(allowRecord.agentIds) as string[],
        namespaces: copyExactArray(allowRecord.namespaces) as string[],
        visibilities: copyExactArray(allowRecord.visibilities) as AuthorityScope["allow"]["visibilities"],
      },
    };
    const defaultScope = { ...defaultScopeRecord } as unknown as MemoryScope;
    for (const field of SCOPE_OPTIONAL_KEYS) {
      const value = defaultScopeRecord[field];
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          value.length === 0 ||
          value !== value.trim() ||
          value.normalize("NFKC") !== value ||
          /[\u0000-\u001f\u007f]/.test(value))
      ) {
        throw authorityConfigError("is invalid");
      }
    }
    const resolved = resolveAuthorityScope(
      authority,
      {
        appId: defaultScope.appId,
        projectId: defaultScope.projectId,
        agentId: defaultScope.agentId,
        namespace: defaultScope.namespace,
        visibility: defaultScope.visibility,
      },
    );
    for (const field of SCOPE_REQUIRED_KEYS) {
      if (resolved[field] !== defaultScope[field]) {
        throw authorityConfigError("does not match defaultScope");
      }
    }
    return deepFreezeAuthorityConfig({ authority, defaultScope });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MCP authority configuration")) {
      throw error;
    }
    throw authorityConfigError("is invalid");
  }
}

/**
 * Host boundary: exactly one explicit source is required. Inline JSON is useful
 * for process supervisors; the recommended file form must be absolute, regular,
 * and permission mode 0600 before its content is read.
 */
export function loadMcpServerAuthorityFromEnv(
  env: Record<string, string | undefined> = process.env,
): McpServerAuthorityConfig {
  const inlineRaw = env.MENGSHU_AUTHORITY_JSON;
  const inline = inlineRaw?.trim() || undefined;
  const filename = env.MENGSHU_AUTHORITY_FILE?.trim() || undefined;
  if ((inline ? 1 : 0) + (filename ? 1 : 0) !== 1) {
    throw authorityConfigError("requires exactly one of MENGSHU_AUTHORITY_JSON or MENGSHU_AUTHORITY_FILE");
  }
  if (inlineRaw && Buffer.byteLength(inlineRaw, "utf8") > MAX_AUTHORITY_BYTES) {
    throw authorityConfigError("JSON size is invalid");
  }

  let text: string;
  if (filename) {
    if (!path.isAbsolute(filename)) {
      throw authorityConfigError("file path must be absolute");
    }
    let descriptor: number | undefined;
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") {
      throw authorityConfigError("secure file open is unavailable");
    }
    try {
      descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | noFollow,
      );
    } catch {
      throw authorityConfigError("file is unavailable");
    }
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile()) throw authorityConfigError("file must be regular");
      const effectiveUid = process.geteuid?.();
      if (effectiveUid !== undefined && before.uid !== BigInt(effectiveUid)) {
        throw authorityConfigError("file owner is invalid");
      }
      if ((before.mode & 0o777n) !== 0o600n) {
        throw authorityConfigError("file permissions must be 0600");
      }
      if (before.size <= 0n || before.size > BigInt(MAX_AUTHORITY_BYTES)) {
        throw authorityConfigError("file size is invalid");
      }
      const buffer = Buffer.allocUnsafe(MAX_AUTHORITY_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead <= MAX_AUTHORITY_BYTES) {
        const count = fs.readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead <= 0 || bytesRead > MAX_AUTHORITY_BYTES) {
        throw authorityConfigError("file size is invalid");
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== BigInt(bytesRead) ||
        after.uid !== before.uid ||
        (after.mode & 0o777n) !== 0o600n ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        throw authorityConfigError("file changed while reading");
      }
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("MCP authority configuration")) {
        throw error;
      }
      throw authorityConfigError("file is unavailable");
    } finally {
      try {
        fs.closeSync(descriptor);
      } catch {
        throw authorityConfigError("file is unavailable");
      }
    }
  } else {
    text = inline!;
    if (Buffer.byteLength(text, "utf8") > MAX_AUTHORITY_BYTES) {
      throw authorityConfigError("JSON size is invalid");
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw authorityConfigError("JSON is invalid");
  }
  return parseMcpServerAuthorityConfig(parsed);
}

export function createMcpMemoryServer(options: McpMemoryServerOptions): McpMemoryServer {
  const authorityConfig = parseMcpServerAuthorityConfig({
    authority: options.authority,
    defaultScope: options.defaultScope,
  });
  const tools = freezeMcpToolRegistry(createMcpMemoryTools({
    ...options,
    ...authorityConfig,
  }));
  return {
    name: "mengshu",
    listTools: () => tools,
    callTool: async (name, input) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      try {
        return await tool.execute(input);
      } catch (error) {
        throw new Error(formatMcpToolError(error));
      }
    },
  };
}
