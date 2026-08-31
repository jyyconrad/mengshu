/**
 * OpenClaw `ms doctor` / `demo` / `connect` 命令（Milestone B：本机接入体验）。
 *
 * 本文件做什么：让产品开发者在 10 分钟内启动、诊断并接入一个 OpenClaw adapter。
 * - `ms doctor [dir]`：逐项体检（config / DB / embedding / model / 磁盘 / manifest），区分 ok/warning/fatal。
 * - `ms demo [dir]`：写入单 appId 样本工作上下文并演示 context/lookup 闭环。
 * - `ms connect [appId]`：输出可复制的接入信息（server URL / 脱敏 secret / scope 示例 / curl）。
 *
 * 核心流程：
 * 1. 每个检查项做成独立纯函数（checkXxx），返回 { name, status, message }，便于单测。
 * 2. doctor 聚合所有检查项，打印汇总；存在 fatal 时打印显著 FATAL 标记。
 * 3. demo/connect 复用 buildAgentService 与 manifest，embedding 不可用时降级提示不 crash。
 *
 * 关键边界（RISK-4）：embedding 不可达只是 warning（可降级 BM25 + SlotSnapshot 缓存），
 * 不是 fatal；DB 不通、config 不可解析、model 非法才是 fatal。
 */

import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  requireOpenClawCliAuthority,
  resolveOpenClawCliScope,
  type CommanderLike,
  type OpenClawCliAuthorityContext,
} from "./index.js";
import type { MemoryService } from "../../../../core/service-types.js";
import type { MemoryScope } from "../../../../core/types.js";
import { expandHome } from "../../../../core/paths.js";
import { vectorDimsForModel } from "../../../../config.js";
import { buildAgentService } from "./agent-service-helper.js";
import { createConfigFingerprint } from "./config-fingerprint.js";
import type { OpenClawEmbeddingStatus } from "../embedding-status.js";
import {
  MANIFEST_FILENAME,
  manifestToScope,
  readManifest,
} from "../manifest.js";

/** 单项检查结果。status 分四级：ok / info / warning / fatal。 */
export interface CheckResult {
  name: string;
  status: "ok" | "info" | "warning" | "fatal";
  message: string;
}

/** doctor 命令依赖；只读 doctor 可无 authority，demo/connect 仍强制 authenticated authority。 */
export interface DoctorCliDeps extends OpenClawCliAuthorityContext {
  /** 已解析的插件配置（含 embedding/dbType/dbPath/server）。 */
  config?: unknown;
  /** 召回与健康探测服务。 */
  service?: Pick<MemoryService, "health" | "storeMemory" | "recall">;
  /** embedding 探针，仅需 embed 方法。 */
  embeddings?: { embed(text: string): Promise<number[]> };
  /** OpenClaw runtime 的 persisted embedding registry 脱敏状态。 */
  embeddingStatus?: () => OpenClawEmbeddingStatus | Promise<OpenClawEmbeddingStatus>;
  /** 当前工作目录提供者，便于测试注入。 */
  cwd?: () => string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** config 可解析（非空对象）即 ok，否则 fatal。 */
export function checkConfig(config: unknown): CheckResult {
  const name = "config";
  if (!config || typeof config !== "object") {
    return { name, status: "fatal", message: "配置缺失或不可解析" };
  }
  return { name, status: "ok", message: "配置已加载" };
}

export function checkWorkingSetRetention(config: unknown): CheckResult {
  const root = asRecord(config);
  const features = asRecord(root.features);
  if (features.sessionWorkingSet !== true) {
    return { name: "working-set-retention", status: "info", message: "Session Working Set 未启用" };
  }
  const workingSet = asRecord(root.sessionWorkingSet);
  if (!Number.isSafeInteger(workingSet.retentionDays) || Number(workingSet.retentionDays) < 0) {
    return {
      name: "working-set-retention",
      status: "warning",
      message: "Session Working Set 未配置 retentionDays；payload 将保守保留并在清理回执中告警",
    };
  }
  return {
    name: "working-set-retention",
    status: "ok",
    message: `retentionDays=${workingSet.retentionDays}`,
  };
}

/** 调 service.health()：ok -> ok（含记录数），ok:false -> fatal，无 service -> warning。 */
export async function checkDb(
  service: Pick<MemoryService, "health"> | undefined,
): Promise<CheckResult> {
  const name = "database";
  if (!service) {
    return { name, status: "warning", message: "未注入 MemoryService，跳过 DB 检查" };
  }
  try {
    const health = await service.health();
    if (health.ok) {
      return { name, status: "ok", message: `DB 连通，记录数 ${health.records ?? 0}` };
    }
    return { name, status: "fatal", message: `DB 不可用：${health.error ?? "unknown"}` };
  } catch (error) {
    return { name, status: "fatal", message: `DB 健康检查异常：${(error as Error).message}` };
  }
}

/** 调 embed("health check")：成功 -> ok，抛错 -> warning（可降级），无探针 -> warning。 */
export async function checkEmbedding(
  embeddings: { embed(text: string): Promise<number[]> } | undefined,
): Promise<CheckResult> {
  const name = "embedding";
  if (!embeddings) {
    return { name, status: "warning", message: "未注入 embedding，跳过可达性检查（可降级 BM25）" };
  }
  try {
    await embeddings.embed("health check");
    return { name, status: "ok", message: "embedding 服务可达" };
  } catch (error) {
    return {
      name,
      status: "warning",
      message: `embedding 不可达（可降级）：${(error as Error).message}`,
    };
  }
}

/** 这里只验证 registry policy；真实 write path 未执行，因此必须明确标为 not-probed。 */
export function checkEmbeddingRegistry(
  embeddingStatus: OpenClawEmbeddingStatus,
): CheckResult {
  const message =
    `status=${embeddingStatus.status}, registryWriteMode=${embeddingStatus.writeMode}, ` +
    "writePath=not-probed, " +
    `embeddingReadMode=${embeddingStatus.embeddingReadMode}, ` +
    `lifecycleState=${embeddingStatus.lifecycleState}, ` +
    `lifecycleReady=${embeddingStatus.lifecycleReady}`;
  if (
    embeddingStatus.status === "active" &&
    embeddingStatus.writeMode === "write-enabled"
  ) {
    return { name: "embedding-registry", status: "ok", message };
  }
  if (
    embeddingStatus.status === "legacy" &&
    embeddingStatus.writeMode === "legacy-write-through"
  ) {
    return { name: "embedding-registry", status: "info", message };
  }
  return { name: "embedding-registry", status: "warning", message };
}

/** vectorDimsForModel(model)：合法 -> ok，抛错 -> fatal，缺失 -> warning。 */
export function checkModel(model: string | undefined): CheckResult {
  const name = "embedding-model";
  if (!model) {
    return { name, status: "warning", message: "未配置 embedding.model" };
  }
  try {
    const dims = vectorDimsForModel(model);
    return { name, status: "ok", message: `model=${model}（${dims} 维）` };
  } catch (error) {
    return { name, status: "fatal", message: (error as Error).message };
  }
}

/** 检查 dbPath（或其父目录）可写：可写 -> ok，不可达/不可写 -> warning，无路径 -> warning。 */
export function checkDisk(dbPath: string | undefined): CheckResult {
  const name = "disk";
  if (!dbPath || dbPath.trim().length === 0) {
    return { name, status: "warning", message: "未配置 dbPath，跳过磁盘检查" };
  }
  const target = resolve(expandHome(dbPath));
  // dbPath 本身可能尚未创建，回退检查其父目录可写性。
  const candidates = [target, dirname(target)];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.W_OK);
      return { name, status: "ok", message: `磁盘可写：${candidate}` };
    } catch {
      // 尝试下一个候选路径。
    }
  }
  return { name, status: "warning", message: `磁盘不可写或父目录不可达：${target}` };
}

/** 检查项目目录下的 manifest：合法 -> ok，不存在 -> info（提示 init），损坏 -> warning。 */
export function checkManifest(dir: string): CheckResult {
  const name = "manifest";
  const target = resolve(dir);
  try {
    const manifest = readManifest(target);
    if (!manifest) {
      return { name, status: "info", message: `未初始化，可运行 \`ms init\` 创建 ${MANIFEST_FILENAME}` };
    }
    return { name, status: "ok", message: `manifest 合法（project=${manifest.projectId}）` };
  } catch (error) {
    return { name, status: "warning", message: `manifest 损坏：${(error as Error).message}` };
  }
}

function configEmbeddingModel(config: unknown): string | undefined {
  const embedding = asRecord(asRecord(config).embedding);
  return optString(embedding.model);
}

function configDbPath(config: unknown): string | undefined {
  return optString(asRecord(config).dbPath);
}

function configDbType(config: unknown): string {
  const dbType = optString(asRecord(config).dbType);
  return dbType ?? "lancedb";
}

function checkStorage(config: unknown): CheckResult {
  const dbType = configDbType(config);
  if (dbType === "postgres") {
    return { name: "storage", status: "info", message: "PostgreSQL 后端，跳过本地 dbPath 磁盘检查" };
  }
  if (dbType === "supabase") {
    return { name: "storage", status: "info", message: "Supabase 后端，跳过本地 dbPath 磁盘检查" };
  }
  return checkDisk(configDbPath(config));
}

function serverHost(config: unknown): string {
  const server = asRecord(asRecord(config).server);
  return optString(server.host) ?? "127.0.0.1";
}

function serverPort(config: unknown): number {
  const server = asRecord(asRecord(config).server);
  return typeof server.port === "number" ? server.port : 3847;
}

function serverSecret(config: unknown): string | undefined {
  const server = asRecord(asRecord(config).server);
  return optString(server.secret);
}

function resolveDir(positional: unknown, options: { dir?: string }, deps: DoctorCliDeps): string {
  const fromArg = optString(positional);
  const fromOpt = optString(options.dir);
  const base = fromArg ?? fromOpt ?? (deps.cwd ?? process.cwd)();
  return resolve(base);
}

/** 单 appId 样本工作上下文（demo 用），覆盖偏好持续 / 工作背景 / 规则约束三类场景。 */
const DEMO_MEMORIES: Array<{ kind: string; semanticType: string; text: string }> = [
  { kind: "preference", semanticType: "profile", text: "复杂方案先给短结论，再给详细计划。" },
  { kind: "preference", semanticType: "rules", text: "禁止在未确认前删除生产数据。" },
  { kind: "task", semanticType: "task_context", text: "当前项目目标：交付 v0.1 Working Context 闭环。" },
];

async function runDemo(dir: string, deps: DoctorCliDeps): Promise<void> {
  requireOpenClawCliAuthority(deps);
  console.log("Mengshu Demo（单 appId 样本）");
  const manifest = readManifest(dir);
  const scope = resolveDoctorScope(deps, manifest);

  if (!deps.service) {
    console.log("未注入 MemoryService，无法运行 demo。");
    return;
  }

  // 1. 写入样本（embedding 不可用时 store 可能抛错，降级提示不 crash）。
  let stored = 0;
  for (const sample of DEMO_MEMORIES) {
    try {
      await deps.service.storeMemory({
        record: {
          id: `demo-${sample.semanticType}-${stored}`,
          scope,
          kind: sample.kind as never,
          semanticType: sample.semanticType as never,
          text: sample.text,
          contentHash: `demo-${stored}`,
          importance: 0.8,
          category: "general" as never,
          dataType: "memory" as never,
          metadata: { source: "demo" },
          provenance: { source: "system" },
          createdAt: 0,
        },
      });
      stored += 1;
    } catch (error) {
      console.log(`样本写入降级（embedding 不可用？）：${(error as Error).message}`);
      console.log("提示：demo 的 context/lookup 需要可用的 embedding 配置。");
      return;
    }
  }
  console.log(`已写入 ${stored} 条样本工作上下文。`);

  // 2. 演示 context 与 lookup。
  try {
    const agentService = buildAgentService(scope, "项目当前工作上下文", deps.service as MemoryService);
    const response = await agentService.context({ scope, task: "项目当前工作上下文" });
    console.log(`context 命中 ${response.telemetry.nodesUsed} 条（${response.telemetry.latencyMs}ms）`);
    const lookup = await deps.service.recall({ query: "偏好", scope, limit: 3, minScore: 0.1 });
    console.log(`lookup 命中 ${lookup.hits.length} 条。`);
  } catch (error) {
    console.log(`context/lookup 降级：${(error as Error).message}`);
    console.log("提示：需要可用的 embedding 配置。");
  }
}

function runConnect(
  appId: string,
  dir: string,
  deps: DoctorCliDeps,
  options: { showSecret?: boolean } = {},
): void {
  requireOpenClawCliAuthority(deps);
  const config = deps.config;
  const url = `http://${serverHost(config)}:${serverPort(config)}`;
  const secret = serverSecret(config);
  const manifest = readManifest(dir);
  const scope = resolveDoctorScope(deps, manifest, appId);

  console.log(`Connect ${appId}`);
  console.log(`- server URL: ${url}`);
  console.log(`- config fingerprint: ${createConfigFingerprint(config)}`);
  if (secret) {
    console.log(options.showSecret ? `- secret: ${secret}` : "- secret: 已配置（默认隐藏）");
  } else {
    console.log("- secret: 未配置，请用 `--secret` 生成或在 config.server.secret 设置。");
  }
  console.log("- scope 示例:");
  console.log(JSON.stringify(scope, null, 2));
  console.log("- 调用示例:");
  const authHeader = secret
    ? ` -H "authorization: Bearer ${options.showSecret ? secret : "$MENGSHU_SERVER_SECRET"}"`
    : "";
  console.log(
    `curl -X POST ${url}/v1/agent/context -H "content-type: application/json"${authHeader} ` +
      `-d '${JSON.stringify({ scope, task: "示例任务" })}'`,
  );
}

async function runDoctor(dir: string, deps: DoctorCliDeps): Promise<void> {
  const config = deps.config;
  const results: CheckResult[] = [
    checkConfig(config),
    checkWorkingSetRetention(config),
    await checkDb(deps.service),
    await checkEmbedding(deps.embeddings),
    checkModel(configEmbeddingModel(config)),
    checkStorage(config),
    checkManifest(dir),
  ];
  if (deps.embeddingStatus) {
    let status: OpenClawEmbeddingStatus;
    try {
      status = await deps.embeddingStatus();
    } catch {
      status = {
        status: "unavailable",
        writeMode: "read-only",
        embeddingReadMode: "fail-closed",
        lifecycleState: "degraded",
        lifecycleReady: false,
        reasonCode: "registry-unavailable",
      };
    }
    results.push(checkEmbeddingRegistry(status));
  }

  console.log("Mengshu Doctor");
  console.log(`Config fingerprint: ${createConfigFingerprint(config)}`);
  for (const result of results) {
    console.log(`[${result.status}] ${result.name}: ${result.message}`);
  }

  const counts = { ok: 0, info: 0, warning: 0, fatal: 0 };
  for (const result of results) {
    counts[result.status] += 1;
  }
  console.log(
    `汇总：${counts.ok} ok / ${counts.info} info / ${counts.warning} warning / ${counts.fatal} fatal`,
  );
  if (counts.fatal > 0) {
    console.log("FATAL：存在致命问题，接入前必须修复。");
    process.exitCode = 1;
  }
}

/** 注册 doctor / demo / connect 子命令到父 `ms` 命令。 */
export function registerDoctorCliCommands(memory: CommanderLike, deps: DoctorCliDeps): void {
  memory
    .command("doctor [dir]")
    .description("Diagnose config, DB, embedding, disk and manifest health")
    .action(async (...args: unknown[]) => {
      const [positional, opts] = args;
      const dir = resolveDir(positional, { dir: optString(asRecord(opts).dir) }, deps);
      await runDoctor(dir, deps);
    });

  memory
    .command("demo [dir]")
    .description("Seed single-appId sample working context and demo context/lookup")
    .action(async (...args: unknown[]) => {
      requireOpenClawCliAuthority(deps);
      const [positional, opts] = args;
      const dir = resolveDir(positional, { dir: optString(asRecord(opts).dir) }, deps);
      await runDemo(dir, deps);
    });

  memory
    .command("connect [appId]")
    .description("Print copy-paste connection info (URL / redacted secret / scope / curl)")
    .option("--dir <dir>", "Project directory for scope example")
    .option("--show-secret", "Explicitly include the configured server secret")
    .action((...args: unknown[]) => {
      requireOpenClawCliAuthority(deps);
      const [appId, opts] = args;
      const parsedOptions = asRecord(opts);
      const dir = resolveDir(undefined, { dir: optString(parsedOptions.dir) }, deps);
      runConnect(optString(appId) ?? "openclaw", dir, deps, {
        showSecret: parsedOptions.showSecret === true,
      });
    });
}

function resolveDoctorScope(
  deps: DoctorCliDeps,
  manifest?: ReturnType<typeof readManifest>,
  appId?: string,
): MemoryScope {
  const requested = manifest
    ? manifestToScope(manifest, { appId: appId ?? deps.defaultScope!.appId })
    : deps.defaultScope!;
  return resolveOpenClawCliScope(deps, {
    appId: appId ?? requested.appId,
    projectId: requested.projectId,
    agentId: requested.agentId,
    namespace: requested.namespace,
    visibility: requested.visibility ?? "private",
  });
}
