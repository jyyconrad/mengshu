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

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { resolveRegistryPath, type HomePathOptions } from "./paths.js";

/** registry 当前 schema 版本。 */
export const REGISTRY_VERSION = 2;

export type RegistryAliasSource = "slug" | "display-name" | "explicit";

/** 可解释 alias：保留展示值、规范化键及来源。 */
export interface RegistryProjectAlias {
  value: string;
  normalized: string;
  source: RegistryAliasSource;
}

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
  /** 经 realpath 解析的唯一项目根目录绑定。 */
  canonicalRoot?: string;
  /** slug、展示名或显式中文别名。 */
  aliases?: RegistryProjectAlias[];
  /** 最近一次打开/操作时间戳（ms）。 */
  lastOpenedAt?: number;
}

/** workspace 视图（projectId 倒排，便于按 workspace 列出项目）。 */
export interface RegistryWorkspaceEntry {
  projectIds: string[];
}

export type RegistryUpgradeDiagnosticCode =
  | "canonical-path-conflict"
  | "display-alias-conflict"
  | "last-seen-root-missing"
  | "last-seen-root-not-absolute"
  | "last-seen-root-not-found"
  | "project-id-normalization-conflict";

export interface RegistryUpgradeDiagnostic {
  projectId: string;
  code: RegistryUpgradeDiagnosticCode;
}

/** 持久化升级审计；doctor 可据此解释哪些 v1 identity 未自动绑定。 */
export interface RegistryUpgradeAudit {
  fromVersion: 1;
  toVersion: typeof REGISTRY_VERSION;
  diagnostics: RegistryUpgradeDiagnostic[];
}

/** registry.json 完整 schema。 */
export interface MemoryAutodbRegistry {
  version: number;
  projects: Record<string, RegistryProjectEntry>;
  workspaces: Record<string, RegistryWorkspaceEntry>;
  upgradeAudit?: RegistryUpgradeAudit;
}

export interface CanonicalProjectRegistrationOptions {
  slug?: string;
  aliases?: readonly string[];
  /** 测试或平台适配层可注入；默认只解析传入路径，不扫描目录。 */
  realpath?: (path: string) => string;
}

export interface RegistryProjectLookup {
  projectId: string;
  entry: RegistryProjectEntry;
  matchedBy: "project-id" | "alias" | "canonical-path";
  aliasSource: "project-id" | RegistryAliasSource | "canonical-path";
  normalizedReference: string;
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
    const registry: MemoryAutodbRegistry = {
      version: typeof parsed.version === "number" ? parsed.version : REGISTRY_VERSION,
      projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
      workspaces:
        parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {},
      upgradeAudit:
        parsed.upgradeAudit && typeof parsed.upgradeAudit === "object"
          ? parsed.upgradeAudit
          : undefined,
    };
    return registry.version === 1 ? upgradeRegistryV1(registry) : registry;
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
  writeFileSync(tmp, serializeRegistry(registry), "utf8");
  renameSync(tmp, filePath);
}

const REGISTRY_FILENAME_TMP_PREFIX = "registry";

interface V1ProjectUpgradeCandidate {
  projectId: string;
  entry: RegistryProjectEntry;
  displayAlias?: RegistryProjectAlias;
  canonicalRoot?: string;
}

function addBinding(
  bindings: Map<string, Set<string>>,
  normalized: string,
  projectId: string,
): void {
  const owners = bindings.get(normalized) ?? new Set<string>();
  owners.add(projectId);
  bindings.set(normalized, owners);
}

function upgradeRegistryV1(registry: MemoryAutodbRegistry): MemoryAutodbRegistry {
  const diagnostics: RegistryUpgradeDiagnostic[] = [];
  const candidates: V1ProjectUpgradeCandidate[] = [];
  const aliasBindings = new Map<string, Set<string>>();
  const pathBindings = new Map<string, Set<string>>();

  for (const projectId of Object.keys(registry.projects).sort()) {
    addBinding(aliasBindings, normalizeProjectAlias(projectId), projectId);
  }
  for (const owners of aliasBindings.values()) {
    if (owners.size > 1) {
      for (const projectId of owners) {
        diagnostics.push({ projectId, code: "project-id-normalization-conflict" });
      }
    }
  }

  for (const projectId of Object.keys(registry.projects).sort()) {
    const entry = registry.projects[projectId]!;
    const candidate: V1ProjectUpgradeCandidate = { projectId, entry: { ...entry } };
    const normalizedProjectId = normalizeProjectAlias(projectId);
    if (typeof entry.displayName === "string" && entry.displayName.trim().length > 0) {
      const value = entry.displayName.normalize("NFKC").trim();
      const normalized = normalizeProjectAlias(value);
      if (normalized && normalized !== normalizedProjectId) {
        candidate.displayAlias = { value, normalized, source: "display-name" };
        addBinding(aliasBindings, normalized, projectId);
      }
    }

    if (typeof entry.lastSeenRoot !== "string" || entry.lastSeenRoot.length === 0) {
      diagnostics.push({ projectId, code: "last-seen-root-missing" });
    } else if (!isAbsolute(entry.lastSeenRoot)) {
      diagnostics.push({ projectId, code: "last-seen-root-not-absolute" });
    } else if (!existsSync(entry.lastSeenRoot)) {
      diagnostics.push({ projectId, code: "last-seen-root-not-found" });
    } else {
      try {
        candidate.canonicalRoot = normalizeAbsolutePath(
          realpathSync.native(entry.lastSeenRoot),
          "project real path",
        );
        addBinding(pathBindings, candidate.canonicalRoot, projectId);
      } catch {
        diagnostics.push({ projectId, code: "last-seen-root-not-found" });
      }
    }
    candidates.push(candidate);
  }

  const projects: Record<string, RegistryProjectEntry> = {};
  for (const candidate of candidates) {
    const { projectId } = candidate;
    const upgraded = { ...candidate.entry };
    if (candidate.displayAlias) {
      const owners = aliasBindings.get(candidate.displayAlias.normalized);
      if (owners?.size === 1) {
        upgraded.aliases = [candidate.displayAlias];
      } else {
        diagnostics.push({ projectId, code: "display-alias-conflict" });
        delete upgraded.aliases;
      }
    }
    if (candidate.canonicalRoot) {
      const owners = pathBindings.get(candidate.canonicalRoot);
      if (owners?.size === 1) {
        upgraded.canonicalRoot = candidate.canonicalRoot;
      } else {
        diagnostics.push({ projectId, code: "canonical-path-conflict" });
        delete upgraded.canonicalRoot;
      }
    }
    projects[projectId] = upgraded;
  }

  diagnostics.sort((left, right) =>
    left.projectId < right.projectId
      ? -1
      : left.projectId > right.projectId
        ? 1
        : left.code < right.code
          ? -1
          : left.code > right.code
            ? 1
            : 0);
  return {
    version: REGISTRY_VERSION,
    projects,
    workspaces: registry.workspaces,
    upgradeAudit: {
      fromVersion: 1,
      toVersion: REGISTRY_VERSION,
      diagnostics,
    },
  };
}

function compareAliases(left: RegistryProjectAlias, right: RegistryProjectAlias): number {
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return compare(left.normalized, right.normalized) ||
    compare(left.source, right.source) ||
    compare(left.value, right.value);
}

/** 确定性 JSON：project/workspace key、projectIds 和 aliases 均排序。 */
export function serializeRegistry(registry: MemoryAutodbRegistry): string {
  const projects: Record<string, RegistryProjectEntry> = {};
  for (const projectId of Object.keys(registry.projects).sort()) {
    const entry = registry.projects[projectId]!;
    projects[projectId] = {
      workspaceId: entry.workspaceId,
      displayName: entry.displayName,
      manifestPath: entry.manifestPath,
      lastSeenRoot: entry.lastSeenRoot,
      canonicalRoot: entry.canonicalRoot,
      aliases: entry.aliases ? [...entry.aliases].sort(compareAliases) : undefined,
      lastOpenedAt: entry.lastOpenedAt,
    };
  }

  const workspaces: Record<string, RegistryWorkspaceEntry> = {};
  for (const workspaceId of Object.keys(registry.workspaces).sort()) {
    workspaces[workspaceId] = {
      projectIds: [...registry.workspaces[workspaceId]!.projectIds].sort(),
    };
  }
  const upgradeAudit = registry.upgradeAudit
    ? {
        fromVersion: registry.upgradeAudit.fromVersion,
        toVersion: registry.upgradeAudit.toVersion,
        diagnostics: [...registry.upgradeAudit.diagnostics].sort((left, right) =>
          left.projectId < right.projectId
            ? -1
            : left.projectId > right.projectId
              ? 1
              : left.code < right.code
                ? -1
                : left.code > right.code
                  ? 1
                  : 0),
      }
    : undefined;
  return `${JSON.stringify({ version: registry.version, projects, workspaces, upgradeAudit }, null, 2)}\n`;
}

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
    canonicalRoot: entry.canonicalRoot ?? prev?.canonicalRoot,
    aliases: entry.aliases ?? prev?.aliases,
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

  return {
    version: registry.version,
    projects,
    workspaces,
    upgradeAudit: registry.upgradeAudit,
  };
}

/** NFKC + trim + case fold；中文保持原文字形，ASCII slug 大小写归一。 */
export function normalizeProjectAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** canonical projectId 只允许稳定的 ASCII id；中文名称应作为 alias 注册。 */
export function canonicalizeProjectId(projectId: string): string {
  const canonical = normalizeProjectAlias(projectId);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(canonical)) {
    throw new Error(`projectId 无法规范化为 canonical id：${projectId}`);
  }
  return canonical;
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (path.includes("\0") || !isAbsolute(path)) {
    throw new Error(`${label} 必须是绝对路径`);
  }
  return normalize(path);
}

/** 对单个项目根路径做 realpath 绑定；不枚举、不扫描父目录。 */
export function canonicalizeProjectRoot(
  path: string,
  resolveRealpath: (path: string) => string = realpathSync.native,
): string {
  const absolute = normalizeAbsolutePath(path, "project root");
  try {
    return normalizeAbsolutePath(resolveRealpath(absolute), "project real path");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法解析 project real path（${absolute}）：${reason}`);
  }
}

const ALIAS_SOURCE_PRIORITY: Record<RegistryAliasSource, number> = {
  slug: 0,
  "display-name": 1,
  explicit: 2,
};

function collectAliases(
  previous: readonly RegistryProjectAlias[],
  entry: RegistryProjectEntry,
  options: CanonicalProjectRegistrationOptions,
  canonicalProjectId: string,
): RegistryProjectAlias[] {
  const candidates: RegistryProjectAlias[] = [...previous];
  const add = (value: string | undefined, source: RegistryAliasSource): void => {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const normalized = normalizeProjectAlias(value);
    if (!normalized || normalized === canonicalProjectId) return;
    candidates.push({ value: value.normalize("NFKC").trim(), normalized, source });
  };
  add(options.slug, "slug");
  add(entry.displayName, "display-name");
  for (const alias of options.aliases ?? []) add(alias, "explicit");

  const byNormalized = new Map<string, RegistryProjectAlias>();
  for (const candidate of candidates.sort((left, right) =>
    ALIAS_SOURCE_PRIORITY[left.source] - ALIAS_SOURCE_PRIORITY[right.source] || compareAliases(left, right))) {
    if (!byNormalized.has(candidate.normalized)) byNormalized.set(candidate.normalized, candidate);
  }
  return [...byNormalized.values()].sort(compareAliases);
}

function lookupAliasBindings(
  registry: MemoryAutodbRegistry,
  normalized: string,
): RegistryProjectLookup[] {
  const matches: RegistryProjectLookup[] = [];
  for (const [projectId, entry] of Object.entries(registry.projects)) {
    if (normalizeProjectAlias(projectId) === normalized) {
      matches.push({
        projectId,
        entry,
        matchedBy: "project-id",
        aliasSource: "project-id",
        normalizedReference: normalized,
      });
    }
    for (const alias of entry.aliases ?? []) {
      if (alias.normalized === normalized) {
        matches.push({
          projectId,
          entry,
          matchedBy: "alias",
          aliasSource: alias.source,
          normalizedReference: normalized,
        });
      }
    }
  }
  return matches;
}

/** alias/projectId 查询；若损坏 registry 中存在多重绑定则 fail-closed。 */
export function resolveProjectAlias(
  registry: MemoryAutodbRegistry,
  reference: string,
): RegistryProjectLookup | null {
  const normalized = normalizeProjectAlias(reference);
  if (!normalized) return null;
  const matches = lookupAliasBindings(registry, normalized);
  const projectIds = new Set(matches.map((match) => match.projectId));
  if (projectIds.size > 1) {
    throw new Error(`alias 存在冲突绑定：${reference}`);
  }
  return matches[0] ?? null;
}

/** canonical real path 精确查询，不使用 startsWith 等前缀判断。 */
export function resolveProjectPath(
  registry: MemoryAutodbRegistry,
  path: string,
  resolveRealpath: (path: string) => string = realpathSync.native,
): RegistryProjectLookup | null {
  const canonicalRoot = canonicalizeProjectRoot(path, resolveRealpath);
  const matches = Object.entries(registry.projects).filter(
    ([, entry]) => entry.canonicalRoot === canonicalRoot,
  );
  if (matches.length > 1) {
    throw new Error(`canonical path 存在冲突绑定：${canonicalRoot}`);
  }
  const match = matches[0];
  return match
    ? {
        projectId: match[0],
        entry: match[1],
        matchedBy: "canonical-path",
        aliasSource: "canonical-path",
        normalizedReference: canonicalRoot,
      }
    : null;
}

/**
 * 严格 canonical 注册入口。旧 upsertProject 保持兼容；scope 回填与新接入应使用本函数。
 */
export function registerCanonicalProject(
  registry: MemoryAutodbRegistry,
  projectId: string,
  entry: RegistryProjectEntry,
  options: CanonicalProjectRegistrationOptions = {},
): MemoryAutodbRegistry {
  const canonicalProjectId = canonicalizeProjectId(projectId);
  if (!entry.lastSeenRoot) {
    throw new Error("canonical project 注册需要 lastSeenRoot");
  }
  const resolveRealpath = options.realpath ?? realpathSync.native;
  const canonicalRoot = canonicalizeProjectRoot(entry.lastSeenRoot, resolveRealpath);
  const manifestPath = normalizeAbsolutePath(entry.manifestPath, "manifestPath");
  const previous = registry.projects[canonicalProjectId];

  if (previous?.canonicalRoot && previous.canonicalRoot !== canonicalRoot) {
    throw new Error(`projectId ${canonicalProjectId} 已绑定其它 canonical path`);
  }
  for (const [existingProjectId, existing] of Object.entries(registry.projects)) {
    if (existingProjectId !== canonicalProjectId && existing.canonicalRoot === canonicalRoot) {
      throw new Error(`canonical path 已绑定到 project ${existingProjectId}`);
    }
  }

  const aliases = collectAliases(previous?.aliases ?? [], entry, options, canonicalProjectId);
  for (const normalized of [canonicalProjectId, ...aliases.map((alias) => alias.normalized)]) {
    const conflicts = lookupAliasBindings(registry, normalized).filter(
      (match) => match.projectId !== canonicalProjectId,
    );
    if (conflicts.length > 0) {
      throw new Error(`alias ${normalized} 已绑定到 project ${conflicts[0]!.projectId}`);
    }
  }

  const updated = upsertProject(registry, canonicalProjectId, {
    ...entry,
    manifestPath,
    lastSeenRoot: canonicalRoot,
    canonicalRoot,
    aliases,
  });
  return { ...updated, version: REGISTRY_VERSION };
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
