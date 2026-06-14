/**
 * memory-autodb 全局目录与路径解析（global config home）。
 *
 * 本文件做什么：把 `~/.memory-autodb/` 全局目录的所有派生路径（config.json、.env、
 * registry.json、memory/、projects/<projectId>/...）集中到一组纯函数里，避免
 * config.ts、scripts/memory-autodb-mcp.ts、manifest.ts 等模块各自拼路径、各自做
 * `~` 展开导致漂移。
 *
 * 核心流程：
 * 1. resolveHomeDir：解析全局目录，按 `MEMORY_AUTODB_HOME` > 升级方案默认 `~/.memory-autodb/`
 *    顺序决定；旧 `~/.openclaw/` 在调用方按需做兼容回退。
 * 2. expandHome：把 `~`/`~/...` 展开为绝对路径，统一替换原先 scripts 内联实现。
 * 3. resolveConfigPath/EnvPath/RegistryPath/ProjectsDir/ProjectDir：相对 home 派生。
 *
 * 关键边界（v0.1.2）：
 * - 这里只解析路径字符串，不读文件、不创建目录、不输出日志。
 * - 路径相关的兼容回退（如旧 `~/.openclaw/`）放在调用方（config.ts、scripts/mcp），
 *   因为是否回退取决于"该文件是否存在"这一 I/O 行为，不属于路径计算。
 * - 不依赖 zod/任何第三方解析库，确保启动早期可调用。
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** 默认全局目录名（相对 home，对应升级方案 §2 目标目录结构）。 */
export const DEFAULT_HOME_DIRNAME = ".memory-autodb";

/** 旧路径，仅用于兼容回退场景中识别。 */
export const LEGACY_HOME_DIRNAME = ".openclaw";

/** 全局配置文件、env、registry 在 home 下的固定文件名（v0.1.2 schema）。 */
export const CONFIG_FILENAME = "config.json";
export const ENV_FILENAME = ".env";
export const REGISTRY_FILENAME = "registry.json";
export const PROJECTS_DIRNAME = "projects";
export const MEMORY_DIRNAME = "memory";
export const LANCEDB_DIRNAME = "lancedb";

/** 控制路径解析的入参（便于测试注入与多客户端覆盖）。 */
export interface HomePathOptions {
  /** 显式覆盖 home（最高优先级）。 */
  homeDir?: string;
  /** 测试或多用户场景下注入的 home base（HOME），默认 os.homedir()。 */
  home?: string;
  /** 测试或多用户场景下注入的环境变量映射，默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 把 `~`、`~/foo` 展开成绝对路径；非 `~` 前缀原样返回。
 * 调用方负责对返回值再做 path.resolve（若需相对 baseDir 解析）。
 */
export function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/")) {
    return join(home, input.slice(2));
  }
  return input;
}

/**
 * 解析全局 home 目录绝对路径。
 * 优先级：options.homeDir > env.MEMORY_AUTODB_HOME > `<home>/.memory-autodb`。
 * 不存在性检查由调用方处理；这里只负责把字符串归一化为绝对路径。
 */
export function resolveHomeDir(options: HomePathOptions = {}): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const explicit = options.homeDir ?? env.MEMORY_AUTODB_HOME;
  if (explicit && explicit.trim().length > 0) {
    const expanded = expandHome(explicit.trim(), home);
    return isAbsolute(expanded) ? expanded : resolve(home, expanded);
  }
  return join(home, DEFAULT_HOME_DIRNAME);
}

/** 旧 `~/.openclaw/` 目录绝对路径，供兼容回退使用。 */
export function resolveLegacyHomeDir(options: Pick<HomePathOptions, "home"> = {}): string {
  const home = options.home ?? homedir();
  return join(home, LEGACY_HOME_DIRNAME);
}

/** 全局 config.json 绝对路径。 */
export function resolveConfigPath(options: HomePathOptions = {}): string {
  return join(resolveHomeDir(options), CONFIG_FILENAME);
}

/** 全局 .env 绝对路径。 */
export function resolveEnvPath(options: HomePathOptions = {}): string {
  return join(resolveHomeDir(options), ENV_FILENAME);
}

/** 全局 registry.json 绝对路径。 */
export function resolveRegistryPath(options: HomePathOptions = {}): string {
  return join(resolveHomeDir(options), REGISTRY_FILENAME);
}

/** 全局 projects/ 目录绝对路径。 */
export function resolveProjectsDir(options: HomePathOptions = {}): string {
  return join(resolveHomeDir(options), PROJECTS_DIRNAME);
}

/** 单个 project 在全局目录中的根路径：`~/.memory-autodb/projects/<projectId>/`。 */
export function resolveProjectDir(projectId: string, options: HomePathOptions = {}): string {
  if (!projectId || projectId.trim().length === 0) {
    throw new Error("resolveProjectDir 需要非空 projectId");
  }
  return join(resolveProjectsDir(options), projectId.trim());
}

/** 单个 project 的完整 manifest.json 绝对路径。 */
export function resolveProjectManifestPath(projectId: string, options: HomePathOptions = {}): string {
  return join(resolveProjectDir(projectId, options), "manifest.json");
}

/** 默认 LanceDB 路径：`~/.memory-autodb/memory/lancedb/`。 */
export function resolveDefaultLanceDbPath(options: HomePathOptions = {}): string {
  return join(resolveHomeDir(options), MEMORY_DIRNAME, LANCEDB_DIRNAME);
}

/** 旧 LanceDB 路径：`~/.openclaw/memory/lancedb/`，仅供兼容回退使用。 */
export function resolveLegacyLanceDbPath(options: Pick<HomePathOptions, "home"> = {}): string {
  return join(resolveLegacyHomeDir(options), MEMORY_DIRNAME, LANCEDB_DIRNAME);
}
