/**
 * OpenClaw `ltm init` 与 `ltm project` 子命令（A2-lite）。
 *
 * 本文件做什么：在 cli.ts 的 server 命令之外，注册 project scope identity 入口：
 * - `ltm init [dir]`：创建 .memory-autodb.json（默认幂等不覆盖，--force 覆盖）。
 * - `ltm project status/context/lookup`：基于 manifest 派生 scope 的最小可用视图。
 *
 * 核心流程：
 * 1. 解析目标目录（位置参数 > --dir > cwd）。
 * 2. 读/写 manifest，派生稳定 MemoryScope。
 * 3. context/lookup 复用 MemoryService.recall；recall 需 embedding，不可用时降级提示不 crash。
 *
 * 关键边界（v0.1）：
 * - 不强制目录索引；status 的记录数走 getRecordCount（库级总数），scope 级精确计数待 v0.2 provider filter。
 * - 与 cli.ts 共用 CommanderLike 鸭子类型，避免引入 commander 硬依赖。
 * - 所有命令对缺失 manifest / 缺失 service 做友好提示，不抛未捕获异常。
 */

import { basename, resolve } from "node:path";
import type { CommanderLike } from "./cli.js";
import type { MemoryService } from "../../core/service-types.js";
import type { MemoryVisibility } from "../../core/types.js";
import { scopeToKey } from "../../core/scope.js";
import { scopeToWorkspaceKey } from "../../core/scope-policy.js";
import { buildAgentService } from "./agent-service-helper.js";
import {
  MANIFEST_FILENAME,
  createManifest,
  manifestPath,
  manifestToScope,
  readProjectManifest,
  writeProjectIdentity,
  type MemoryAutodbManifest,
} from "./manifest.js";
import { readRegistry, writeRegistry, upsertProject, touchProjectOpenedAt } from "../../core/registry.js";
import { resolveProjectManifestPath, type HomePathOptions } from "../../core/paths.js";

/** project 命令依赖注入。service/getRecordCount 缺省时相关命令降级。 */
export interface ProjectCliDeps {
  /** 用于 context/lookup 的召回服务（需 embedding）。 */
  service?: MemoryService;
  /** 返回库内记录总数（status 展示用，scope 级精确计数待 v0.2）。 */
  getRecordCount?: () => Promise<number>;
  /** 当前工作目录提供者，便于测试注入。 */
  cwd?: () => string;
  /** 全局 home 路径选项，便于测试注入。 */
  homePathOptions?: HomePathOptions;
}

interface InitOptions {
  workspaceId?: string;
  projectId?: string;
  userId?: string;
  visibility?: MemoryVisibility;
  force?: boolean;
  dir?: string;
}

interface DirOptions {
  dir?: string;
}

function resolveDir(positional: unknown, options: { dir?: string } = {}, deps: ProjectCliDeps): string {
  const fromArg = typeof positional === "string" && positional.trim().length > 0 ? positional : undefined;
  const fromOpt = typeof options.dir === "string" && options.dir.trim().length > 0 ? options.dir : undefined;
  const base = fromArg ?? fromOpt ?? (deps.cwd ?? process.cwd)();
  return resolve(base);
}

/** 打印 workspace/project identity 与 scope key。 */
function printIdentity(manifest: MemoryAutodbManifest): void {
  const scope = manifestToScope(manifest);
  console.log(`- workspaceId: ${manifest.workspaceId}`);
  console.log(`- projectId:   ${manifest.projectId}`);
  if (manifest.userId) {
    console.log(`- userId:      ${manifest.userId}`);
  }
  console.log(`- visibility:  ${manifest.defaultVisibility}`);
  console.log(`- workspace key: ${scopeToWorkspaceKey(scope)}`);
  console.log(`- project key:   ${scopeToKey(scope)}`);
}

function printReusePolicy(manifest: MemoryAutodbManifest): void {
  const policy = manifest.slotReusePolicy ?? {};
  console.log("- slotReusePolicy:");
  for (const [slot, level] of Object.entries(policy)) {
    console.log(`  - ${slot}: ${level}`);
  }
}

function handleInit(positional: unknown, options: InitOptions, deps: ProjectCliDeps): void {
  const dir = resolveDir(positional, options, deps);
  const existing = readProjectManifest(dir, deps.homePathOptions);
  if (existing && !options.force) {
    console.log(`manifest 已存在（${manifestPath(dir)}），保留原 identity。使用 --force 覆盖。`);
    printIdentity(existing);
    // 更新 registry 的 lastOpenedAt
    try {
      const registry = readRegistry(deps.homePathOptions);
      const updated = touchProjectOpenedAt(registry, existing.projectId);
      writeRegistry(updated, deps.homePathOptions);
    } catch (error) {
      // registry 更新失败不影响主流程，静默忽略
    }
    return;
  }

  const manifest = createManifest({
    dir,
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    userId: options.userId,
    defaultVisibility: options.visibility,
  });
  writeProjectIdentity(dir, manifest, deps.homePathOptions);
  console.log(`已创建 ${MANIFEST_FILENAME}（${manifestPath(dir)}）`);
  printIdentity(manifest);

  // 注册到全局 registry
  try {
    const registry = readRegistry(deps.homePathOptions);
    const updated = upsertProject(registry, manifest.projectId, {
      workspaceId: manifest.workspaceId,
      manifestPath: resolveProjectManifestPath(manifest.projectId, deps.homePathOptions),
      lastSeenRoot: dir,
      lastOpenedAt: Date.now(),
      displayName: basename(dir),
    });
    writeRegistry(updated, deps.homePathOptions);
    console.log(`已注册到全局 registry（projects/${manifest.projectId}）`);
  } catch (error) {
    console.log(`警告：registry 注册失败（${(error as Error).message}），不影响 manifest 创建。`);
  }
}

async function handleStatus(positional: unknown, options: DirOptions, deps: ProjectCliDeps): Promise<void> {
  const dir = resolveDir(positional, options, deps);
  const manifest = readProjectManifest(dir, deps.homePathOptions);
  if (!manifest) {
    console.log(`未找到 ${MANIFEST_FILENAME}，请先运行 \`ltm init\`。`);
    return;
  }

  console.log("Project Workspace Status:");
  printIdentity(manifest);
  printReusePolicy(manifest);
  console.log(`- sourceRoots: ${manifest.sourceRoots.length} 个（v0.1 默认不索引目录）`);

  if (deps.getRecordCount) {
    try {
      const count = await deps.getRecordCount();
      console.log(`- 库内记录总数: ${count}（scope 级精确计数待 provider filter）`);
    } catch (error) {
      console.log(`- 库内记录总数: 不可用（${(error as Error).message}）`);
    }
  }
}

async function handleContext(
  positional: unknown,
  options: DirOptions & { task?: string },
  deps: ProjectCliDeps,
): Promise<void> {
  const dir = resolveDir(positional, options, deps);
  const manifest = readProjectManifest(dir, deps.homePathOptions);
  if (!manifest) {
    console.log(`未找到 ${MANIFEST_FILENAME}，请先运行 \`ltm init\`。`);
    return;
  }

  const scope = manifestToScope(manifest);
  console.log("Project 5-Slot Context:");
  console.log(`- workspaceId: ${manifest.workspaceId}`);
  console.log(`- projectId:   ${manifest.projectId}`);

  if (!deps.service) {
    console.log("未注入 MemoryService，无法构建上下文（仅展示 scope）。");
    return;
  }

  const task = options.task ?? "项目当前工作上下文";
  try {
    const agentService = buildAgentService(scope, task, deps.service);
    const response = await agentService.context({ scope, task });
    console.log(`命中 ${response.telemetry.nodesUsed} 条记忆（${response.telemetry.latencyMs}ms）`);
    for (const slot of ["profile", "task_context", "rules", "experience", "resource"] as const) {
      const block = response.slots[slot];
      if (block) {
        console.log(`\n#### ${block.question}`);
        console.log(block.content);
      }
    }
  } catch (error) {
    console.log(`无法构建上下文（已降级）：${(error as Error).message}`);
    console.log("提示：context/lookup 需要可用的 embedding 配置。");
  }
}

async function handleLookup(query: unknown, options: DirOptions, deps: ProjectCliDeps): Promise<void> {
  const dir = resolveDir(undefined, options, deps);
  const manifest = readProjectManifest(dir, deps.homePathOptions);
  if (!manifest) {
    console.log(`未找到 ${MANIFEST_FILENAME}，请先运行 \`ltm init\`。`);
    return;
  }
  if (!deps.service) {
    console.log("未注入 MemoryService，无法执行 lookup。");
    return;
  }

  const scope = manifestToScope(manifest);
  const text = typeof query === "string" ? query : "";
  try {
    const result = await deps.service.recall({ query: text, scope, limit: 5, minScore: 0.1 });
    if (result.hits.length === 0) {
      console.log(`未命中（query=${text}）。`);
      return;
    }
    console.log(`命中 ${result.hits.length} 条：`);
    for (const hit of result.hits) {
      const record = hit.record as { text?: string };
      const preview = record.text ?? "(无文本)";
      console.log(`- [${hit.score.toFixed(2)}] ${preview}`);
    }
  } catch (error) {
    console.log(`lookup 失败（已降级）：${(error as Error).message}`);
    console.log("提示：lookup 需要可用的 embedding 配置。");
  }
}

/** 注册 init 与 project 子命令到父 `ltm` 命令。 */
export function registerProjectCliCommands(memory: CommanderLike, deps: ProjectCliDeps): void {
  memory
    .command("init [dir]")
    .description("Initialize project memory workspace (.memory-autodb.json)")
    .option("--workspace-id <id>", "Explicit workspace id")
    .option("--project-id <id>", "Explicit project id")
    .option("--user-id <id>", "User id for scope")
    .option("--visibility <level>", "Default visibility: private | workspace | team | public")
    .option("--force", "Overwrite existing manifest", false)
    .action((...args: unknown[]) => {
      const [dir, opts] = args;
      handleInit(dir, normalizeInitOptions(asRecord(opts)), deps);
    });

  const project = memory.command("project").description("Project memory workspace commands");

  project
    .command("status [dir]")
    .description("Show project workspace identity, scope and reuse policy")
    .action(async (...args: unknown[]) => {
      const [dir, opts] = args;
      await handleStatus(dir, { dir: optString(asRecord(opts).dir) }, deps);
    });

  project
    .command("context [dir]")
    .description("Show current 5-slot context for the project scope")
    .option("--task <task>", "Task description used for retrieval")
    .action(async (...args: unknown[]) => {
      const [dir, opts] = args;
      const record = asRecord(opts);
      await handleContext(dir, { dir: optString(record.dir), task: optString(record.task) }, deps);
    });

  project
    .command("lookup <query>")
    .description("Look up memories within the project scope")
    .option("--dir <dir>", "Project directory")
    .action(async (...args: unknown[]) => {
      const [query, opts] = args;
      await handleLookup(query, { dir: optString(asRecord(opts).dir) }, deps);
    });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeInitOptions(opts: Record<string, unknown>): InitOptions {
  const visibilityRaw = optString(opts.visibility);
  const visibility =
    visibilityRaw === "private" || visibilityRaw === "workspace" || visibilityRaw === "team" || visibilityRaw === "public"
      ? visibilityRaw
      : undefined;
  return {
    workspaceId: optString(opts.workspaceId),
    projectId: optString(opts.projectId),
    userId: optString(opts.userId),
    visibility,
    force: opts.force === true,
    dir: optString(opts.dir),
  };
}
