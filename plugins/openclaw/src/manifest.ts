/**
 * Project Memory Workspace manifest（.mengshu.json）的 schema 与读写。
 *
 * 本文件做什么：把"当前目录"解析成稳定的 workspaceId/projectId，并以轻量 JSON 指针
 * 文件落地，支撑 `ms init` / `ms project` 子命令的 project scope identity。
 *
 * 核心流程：
 * 1. createManifest：缺省 id 时由目录路径派生稳定 hash（同目录幂等）。
 * 2. read/writeManifest：以 2 空格缩进 JSON 落地，缺失返回 null，损坏抛带路径错误。
 * 3. manifestToScope：把 manifest 映射为 MemoryScope（appId/tenantId 固定，其余来自 manifest）。
 *
 * 关键边界（A2-lite）：
 * - identity 稳定性靠两层保证：同目录 createManifest 幂等（路径 hash）；
 *   目录移动时靠 .mengshu.json 指针保留原 id（read 不重算）。因此 init 默认幂等不覆盖。
 * - v0.1 不强制目录索引，sourceRoots 默认空数组。
 * - 所有函数不修改入参，返回新对象。
 *
 * v0.1.2 升级：
 * - 拆分项目指针（version: "0.2"，仅 workspaceId/projectId/manifestPath/createdAt）
 *   与全局完整 manifest（version: "0.1"，包含 slotReusePolicy/sourceRoots 等长期状态）。
 * - 项目目录 `.mengshu.json` 写轻量指针；全局 `~/.mengshu/projects/<projectId>/manifest.json` 写完整 manifest。
 * - readProjectManifest 透明兼容旧 0.1 完整 manifest（legacy）与新 0.2 指针（pointer → 读全局）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeScope } from "../../core/scope.js";
import { DEFAULT_SLOT_REUSE_POLICY, type ReuseLevel } from "../../core/scope-policy.js";
import type { MemoryScope, MemoryScopeInput, MemorySemanticType, MemoryVisibility } from "../../core/types.js";
import { resolveProjectManifestPath, type HomePathOptions } from "../../core/paths.js";

/** manifest 指针文件名，放在 project 目录根部。 */
export const MANIFEST_FILENAME = ".mengshu.json";

/** 完整 manifest schema 版本（全局目录）。 */
export const MANIFEST_VERSION = "0.1";

/** 项目指针 schema 版本。 */
export const MANIFEST_POINTER_VERSION = "0.2";

/**
 * .mengshu.json 的最小 schema（A2-lite）。
 * sourceRoots 字段保留但 v0.1 通常为空（不强制目录索引）。
 */
export interface MemoryAutodbManifest {
  /** manifest schema 版本，如 "0.1" */
  version: string;
  /** 跨 project 复用边界 id */
  workspaceId: string;
  /** task_context/resource 默认隔离边界 id */
  projectId: string;
  /** 可选用户 id（缺省走 scope 默认值） */
  userId?: string;
  /** 新记忆默认可见性，默认 workspace */
  defaultVisibility: MemoryVisibility;
  /** 复用策略覆盖；缺省用 DEFAULT_SLOT_REUSE_POLICY */
  slotReusePolicy?: Partial<Record<MemorySemanticType, ReuseLevel>>;
  /** 本地来源目录；v0.1 可为空数组 */
  sourceRoots: string[];
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 最近更新时间戳（ms），可选 */
  updatedAt?: number;
}

/**
 * 项目指针 schema（v0.2），只保存轻量身份信息，指向全局完整 manifest。
 */
export interface MemoryAutodbPointer {
  /** 指针 schema 版本，固定 "0.2" */
  version: "0.2";
  /** 跨 project 复用边界 id */
  workspaceId: string;
  /** task_context/resource 默认隔离边界 id */
  projectId: string;
  /** 全局完整 manifest 绝对路径或 `~/...` */
  manifestPath: string;
  /** 创建时间戳（ms） */
  createdAt: number;
}

/** createManifest 入参。 */
export interface CreateManifestOptions {
  dir: string;
  workspaceId?: string;
  projectId?: string;
  userId?: string;
  defaultVisibility?: MemoryVisibility;
}

function shortHash(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function trimmed(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

/**
 * 由目录路径派生稳定 projectId：基于绝对路径 hash，保证同目录多次调用一致。
 * 前缀 proj- 便于人读，hash 取 12 位避免碰撞。
 */
function deriveProjectId(dir: string): string {
  const absolute = resolve(dir);
  return `proj-${shortHash(absolute, 12)}`;
}

/**
 * 由目录的父目录路径派生稳定 workspaceId：同一父目录下的多个 project 默认共享 workspace。
 * 前缀 ws- 便于人读，hash 取 8 位（workspace 粒度更粗）。
 */
function deriveWorkspaceId(dir: string): string {
  const absolute = resolve(dir);
  const parent = dirname(absolute);
  return `ws-${shortHash(parent, 8)}`;
}

/**
 * 创建 manifest 对象（纯函数，不落盘）。
 * 缺省 id 由路径派生，保证同目录幂等；显式传入则优先采用。
 */
export function createManifest(options: CreateManifestOptions): MemoryAutodbManifest {
  const dir = resolve(options.dir);
  return {
    version: MANIFEST_VERSION,
    workspaceId: trimmed(options.workspaceId) ?? deriveWorkspaceId(dir),
    projectId: trimmed(options.projectId) ?? deriveProjectId(dir),
    userId: trimmed(options.userId),
    defaultVisibility: options.defaultVisibility ?? "workspace",
    slotReusePolicy: { ...DEFAULT_SLOT_REUSE_POLICY },
    sourceRoots: [],
    createdAt: Date.now(),
  };
}

/**
 * 由完整 manifest 创建轻量指针。
 * manifestPath 通过 resolveProjectManifestPath 计算得到。
 */
export function createPointer(
  manifest: MemoryAutodbManifest,
  options?: HomePathOptions,
): MemoryAutodbPointer {
  return {
    version: MANIFEST_POINTER_VERSION,
    workspaceId: manifest.workspaceId,
    projectId: manifest.projectId,
    manifestPath: resolveProjectManifestPath(manifest.projectId, options),
    createdAt: manifest.createdAt,
  };
}

/**
 * 读取 dir 下的 .mengshu.json，区分指针与旧完整 manifest。
 * - 返回 { kind: "pointer", pointer } 如果 version === "0.2" 或包含 manifestPath。
 * - 返回 { kind: "legacy", manifest } 如果是旧格式（version === "0.1" 或无 manifestPath）。
 * - 返回 null 如果文件不存在。
 * - JSON 解析失败抛带路径的错误。
 */
export function readPointerOrLegacyManifest(
  dir: string,
): { kind: "pointer"; pointer: MemoryAutodbPointer } | { kind: "legacy"; manifest: MemoryAutodbManifest } | null {
  const filePath = manifestPath(dir);
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 判断是否为指针：version === "0.2" 或包含 manifestPath 字段
    if (parsed.version === MANIFEST_POINTER_VERSION || typeof parsed.manifestPath === "string") {
      return { kind: "pointer", pointer: parsed as unknown as MemoryAutodbPointer };
    }
    // 否则视为旧格式完整 manifest
    return { kind: "legacy", manifest: parsed as unknown as MemoryAutodbManifest };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`解析 manifest 失败（${filePath}）：${reason}`);
  }
}

/**
 * 同时写项目指针和全局完整 manifest。
 * - 项目目录：dir/.mengshu.json（轻量指针）
 * - 全局目录：~/.mengshu/projects/<projectId>/manifest.json（完整 manifest）
 * 全局目录不存在时自动创建。
 */
export function writeProjectIdentity(
  dir: string,
  manifest: MemoryAutodbManifest,
  options?: HomePathOptions,
): void {
  // 写项目指针
  const pointer = createPointer(manifest, options);
  writeFileSync(manifestPath(dir), `${JSON.stringify(pointer, null, 2)}\n`, "utf8");

  // 写全局完整 manifest
  const globalManifestPath = resolveProjectManifestPath(manifest.projectId, options);
  const globalDir = dirname(globalManifestPath);
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(globalManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * 高层入口：读取项目 manifest（透明支持 pointer/legacy 两种格式）。
 * - 如果是 pointer，读取全局 manifest；全局文件不存在时抛错。
 * - 如果是 legacy，直接返回该 manifest（调用方决定是否升级）。
 * - 文件不存在返回 null。
 */
export function readProjectManifest(dir: string, options?: HomePathOptions): MemoryAutodbManifest | null {
  const result = readPointerOrLegacyManifest(dir);
  if (!result) {
    return null;
  }
  if (result.kind === "legacy") {
    return result.manifest;
  }
  // pointer 场景：读取全局 manifest
  const { pointer } = result;
  const globalManifestPath = resolveProjectManifestPath(pointer.projectId, options);
  if (!existsSync(globalManifestPath)) {
    throw new Error(
      `项目指针指向的全局 manifest 不存在（${globalManifestPath}），数据可能已被破坏。请检查或重新运行 ms init。`,
    );
  }
  const raw = readFileSync(globalManifestPath, "utf8");
  try {
    return JSON.parse(raw) as MemoryAutodbManifest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`解析全局 manifest 失败（${globalManifestPath}）：${reason}`);
  }
}

/** manifest 指针文件完整路径。 */
export function manifestPath(dir: string): string {
  return join(resolve(dir), MANIFEST_FILENAME);
}

/**
 * 读取 dir 下的 .mengshu.json。
 * 不存在返回 null；JSON 解析失败抛带文件路径的错误（便于排查）。
 * @deprecated 优先使用 readProjectManifest，它透明支持 pointer/legacy 两种格式。
 */
export function readManifest(dir: string): MemoryAutodbManifest | null {
  const filePath = manifestPath(dir);
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw) as MemoryAutodbManifest;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`解析 manifest 失败（${filePath}）：${reason}`);
  }
}

/**
 * 写入 manifest（2 空格缩进，末尾换行）。
 * @deprecated 优先使用 writeProjectIdentity，它同时写指针和全局 manifest。
 */
export function writeManifest(dir: string, manifest: MemoryAutodbManifest): void {
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * manifest 映射为 MemoryScope。
 * appId 固定 openclaw、tenantId 固定 local、namespace 默认 memories；
 * workspaceId/projectId/userId/visibility 来自 manifest；overrides 优先覆盖。
 */
export function manifestToScope(
  manifest: MemoryAutodbManifest,
  overrides: MemoryScopeInput = {},
): MemoryScope {
  return normalizeScope({
    tenantId: "local",
    appId: "openclaw",
    userId: manifest.userId,
    projectId: manifest.projectId,
    workspaceId: manifest.workspaceId,
    namespace: "memories",
    visibility: manifest.defaultVisibility,
    ...overrides,
  });
}
