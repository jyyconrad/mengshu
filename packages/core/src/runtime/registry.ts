/**
 * 本机项目快速索引（registry.json）读写。
 *
 * 本文件做什么：维护 `~/.mengshu/registry.json`，记录本机所有项目的轻量元
 * 信息（最近根目录、最近打开时间、显示名等），不替代每个项目目录下的
 * `~/.mengshu/projects/<projectId>/manifest.json`（后者是长期 identity 真源）。
 *
 * 核心流程：
 * 1. readRegistry：文件不存在返回空骨架，损坏抛带路径的错误便于排查。
 * 2. upsertProject：纯函数语义，返回新对象（不修改入参）；同 projectId 合并旧字段。
 * 3. writeRegistry：原子写（先写 tmp 再 rename）防止崩溃产生残半文件。
 * 4. listProjects / touchProjectOpenedAt：薄壳便于 CLI/Console 复用。
 *
 * 关键边界（v0.1.2）：
 * - registry 是 hint，不是事实真源；查询时缺失字段必须有兜底，不能 crash。
 * - 单进程使用，不引入文件锁；atomic rename 已经能避免半写问题。
 * - 不主动校验 manifestPath 是否存在；调用方按需 doctor 检查孤儿条目。
 * - Date.now()/JSON.stringify 之外不引入第三方依赖。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveRegistryPath, type HomePathOptions } from "./paths.js";

/** registry 当前 schema 版本。 */
export const REGISTRY_VERSION = 1;

/** 单个项目在 registry 中的元信息。 */
export interface RegistryProjectEntry {
  /** 跨 project 复用边界 id（对齐 manifest.workspaceId）。 */
  workspaceId: string;
  /** 用户可读的项目展示名。 */
  displayName?: string;
  /** 全局 manifest.json 绝对路径或 `~/...`。 */
  manifestPath: string;
  /** 最近一次绑定的项目根目录绝对路径（目录移动时会更新）。 */
  lastSeenRoot?: string;
  /** 最近一次打开/操作时间戳（ms）。 */
  lastOpenedAt?: number;
}

/** workspace 视图（projectId 倒排，便于按 workspace 列出项目）。 */
export interface RegistryWorkspaceEntry {
  projectIds: string[];
}

/** registry.json 完整 schema。 */
export interface MemoryAutodbRegistry {
  version: number;
  projects: Record<string, RegistryProjectEntry>;
  workspaces: Record<string, RegistryWorkspaceEntry>;
}

/** 空骨架，registry 文件不存在或第一次 upsert 时使用。 */
export function emptyRegistry(): MemoryAutodbRegistry {
  return { version: REGISTRY_VERSION, projects: {}, workspaces: {} };
}

/**
 * 读取 registry。
 * 文件不存在返回空骨架；JSON 解析失败抛带路径的错误。
 */
export function readRegistry(options: HomePathOptions = {}): MemoryAutodbRegistry {
  const filePath = resolveRegistryPath(options);
  if (!existsSync(filePath)) {
    return emptyRegistry();
  }
  const raw = readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryAutodbRegistry>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : REGISTRY_VERSION,
      projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
      workspaces:
        parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {},
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`解析 registry 失败（${filePath}）：${reason}`);
  }
}

/**
 * 原子写入 registry：保证 home 目录存在 → 写 tmp 文件 → rename 覆盖。
 * 中途 crash 不会留下半写的 registry.json。
 */
export function writeRegistry(
  registry: MemoryAutodbRegistry,
  options: HomePathOptions = {},
): void {
  const filePath = resolveRegistryPath(options);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${REGISTRY_FILENAME_TMP_PREFIX}-${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

const REGISTRY_FILENAME_TMP_PREFIX = "registry";

/**
 * 单个 project 的 upsert。
 * 同 projectId 时与旧 entry 合并（新字段优先，未传字段保留旧值）。
 * workspaces 倒排表自动维护：projectId 加入对应 workspace 的 projectIds（去重）。
 * 返回新的 registry 对象，不修改入参。
 */
export function upsertProject(
  registry: MemoryAutodbRegistry,
  projectId: string,
  entry: RegistryProjectEntry,
): MemoryAutodbRegistry {
  if (!projectId || projectId.trim().length === 0) {
    throw new Error("upsertProject 需要非空 projectId");
  }
  if (!entry.workspaceId || entry.workspaceId.trim().length === 0) {
    throw new Error("upsertProject 需要非空 workspaceId");
  }

  const prev = registry.projects[projectId];
  const merged: RegistryProjectEntry = {
    workspaceId: entry.workspaceId,
    displayName: entry.displayName ?? prev?.displayName,
    manifestPath: entry.manifestPath,
    lastSeenRoot: entry.lastSeenRoot ?? prev?.lastSeenRoot,
    lastOpenedAt: entry.lastOpenedAt ?? prev?.lastOpenedAt,
  };

  const projects = { ...registry.projects, [projectId]: merged };

  // workspaces 倒排表：把 projectId 加入对应 workspace；如果换了 workspace，
  // 还要从旧 workspace 里移除（避免出现幽灵索引）。
  const workspaces: Record<string, RegistryWorkspaceEntry> = {};
  for (const [wsId, wsEntry] of Object.entries(registry.workspaces)) {
    workspaces[wsId] = { projectIds: wsEntry.projectIds.filter((id) => id !== projectId) };
  }
  const target = workspaces[entry.workspaceId] ?? { projectIds: [] };
  workspaces[entry.workspaceId] = {
    projectIds: target.projectIds.includes(projectId)
      ? target.projectIds
      : [...target.projectIds, projectId],
  };

  // 清理空 workspace（如果 project 换 workspace 后旧 ws 没有项目了，删掉它）。
  for (const wsId of Object.keys(workspaces)) {
    if (workspaces[wsId].projectIds.length === 0) {
      delete workspaces[wsId];
    }
  }

  return { version: registry.version, projects, workspaces };
}

/** 列出所有项目（保持插入顺序）。 */
export function listProjects(registry: MemoryAutodbRegistry): Array<{
  projectId: string;
  entry: RegistryProjectEntry;
}> {
  return Object.entries(registry.projects).map(([projectId, entry]) => ({ projectId, entry }));
}

/**
 * 更新 lastOpenedAt 时间戳（不修改其它字段）。
 * 项目不存在时返回原 registry，不抛错（CLI 调用方可选择是否提示）。
 */
export function touchProjectOpenedAt(
  registry: MemoryAutodbRegistry,
  projectId: string,
  now: number = Date.now(),
): MemoryAutodbRegistry {
  const entry = registry.projects[projectId];
  if (!entry) {
    return registry;
  }
  return {
    ...registry,
    projects: {
      ...registry.projects,
      [projectId]: { ...entry, lastOpenedAt: now },
    },
  };
}
