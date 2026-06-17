/**
 * Agent 历史导入 canonical schema（方案 §4.2 / §5）。
 *
 * 本文件做什么：定义所有 source adapter 必须统一输出的 `AgentHistoryEvent`、
 * 幂等导入状态 `AgentHistoryImportState`、adapter 上下文以及 dry-run 报告类型。
 * 这是 Codex / Claude Code / 未来其它来源与下游 pipeline 之间的唯一稳定协议。
 *
 * 核心边界：
 * - adapter 只负责把各家私有日志格式解析成 `AgentHistoryEvent`，不做归属、写库、embedding。
 * - 私有日志路径和格式不稳定，因此 provider 字段开放为 `string`，并保留 parserVersion。
 * - 所有进入 event.text 的内容必须已经过 secret redaction（见 redaction.ts）。
 */

import type { MemoryScope } from "../../core/types.js";

/** 已知来源标识；保留 string 兼容未来来源。 */
export type AgentHistoryProvider = "codex" | "claude-code" | "openclaw" | (string & {});

/** 事件来源种类，决定下游分层与摘要策略。 */
export type AgentHistorySourceKind =
  | "session"
  | "memory"
  | "rule"
  | "work_log"
  | "project_file";

/** 消息角色（部分来源缺失时为 undefined）。 */
export type AgentHistoryRole = "user" | "assistant" | "system" | "tool";

/**
 * 所有 adapter 输出的统一事件（方案 §4.2）。
 * text 必须是 redaction 后的安全文本；原始密钥不得进入。
 */
export interface AgentHistoryEvent {
  /** 事件稳定 id（建议由 sourceHash + 序号或 contentHash 派生，保证幂等）。 */
  id: string;
  provider: AgentHistoryProvider;
  sourceKind: AgentHistorySourceKind;
  /** 来源文件绝对路径（探测/审计/归属用）。 */
  sourcePath?: string;
  /** 来源去重 hash（通常为文件内容 hash 或事件文本 hash）。 */
  sourceHash: string;
  sessionId?: string;
  threadId?: string;
  /** 事件携带的工作目录（最高优先级归属信号）。 */
  cwd?: string;
  /** 来自来源的项目根目录提示（次优先级归属信号）。 */
  projectRootHint?: string;
  /** 事件发生时间（ms 时间戳）。 */
  timestamp?: number;
  role?: AgentHistoryRole;
  /** redaction 后的正文文本。 */
  text: string;
  /** 该事件被 redaction 命中的次数（0 表示无敏感命中）。 */
  redactedCount?: number;
  metadata: Record<string, unknown>;
}

/** 幂等导入状态（方案 §4.2），按 sourceHash 去重。 */
export interface AgentHistoryImportState {
  sourceHash: string;
  provider: string;
  sourcePath?: string;
  projectId?: string;
  status: "seen" | "imported" | "skipped" | "failed";
  eventCount: number;
  importedRecordIds: string[];
  updatedAt: number;
  error?: string;
}

/** 导入状态文件结构：sourceHash -> 状态。 */
export interface AgentHistoryImportStateFile {
  version: number;
  entries: Record<string, AgentHistoryImportState>;
}

/** adapter 解析上下文（注入根路径覆盖、时间窗口、日志器）。 */
export interface SourceAdapterContext {
  /** 显式覆盖来源根目录（方案 §4 必须支持 --source-root）。 */
  sourceRoot?: string;
  /** 只导入该时间点（ms）之后的事件；undefined 表示不限。 */
  sinceMs?: number;
  /** 限制扫描文件数量上限（dry-run 性能保护），undefined 表示不限。 */
  maxFiles?: number;
  /** 进度/告警日志器，缺省静默。 */
  logger?: AdapterLogger;
}

export interface AdapterLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

/** 单个来源文件的解析结果。 */
export interface SourceFileParseResult {
  sourcePath: string;
  sourceHash: string;
  events: AgentHistoryEvent[];
  /** 跳过的坏行数（解析失败但不中断整批）。 */
  badLines: number;
  /** 文件级解析错误；存在时 events 通常为空，但不应中断整批导入。 */
  error?: string;
}

/** source adapter 统一接口。 */
export interface SourceAdapter {
  readonly provider: AgentHistoryProvider;
  readonly parserVersion: string;
  /** 探测来源是否存在并返回候选文件列表（不读全文）。 */
  discover(ctx: SourceAdapterContext): Promise<DiscoverResult>;
  /** 解析单个来源文件为 canonical events。 */
  parseFile(filePath: string, ctx: SourceAdapterContext): Promise<SourceFileParseResult>;
}

export interface DiscoverResult {
  provider: AgentHistoryProvider;
  /** 实际使用的根目录（含 --source-root 覆盖后的结果）。 */
  resolvedRoot?: string;
  /** 根目录是否存在。 */
  rootExists: boolean;
  /** 候选文件绝对路径列表。 */
  files: string[];
  /** 探测提示信息（如"未确认路径"）。 */
  note?: string;
}

/** project 归属判定原因（方案 §5）。 */
export type ProjectMatchReason =
  | "explicit"
  | "cwd_prefix"
  | "registry_root"
  | "source_root"
  | "content_hint"
  | "unmatched";

/** project 归属动作（方案 §5）。 */
export type ProjectMatchAction = "import" | "skip" | "needs-confirmation";

/** 单事件/单来源的归属判定结果。 */
export interface ProjectMatch {
  projectId?: string;
  scope?: MemoryScope;
  reason: ProjectMatchReason;
  confidence: number;
  action: ProjectMatchAction;
}

/** dry-run 报告中按来源聚合的一行（方案 §5 报告表）。 */
export interface SourceMappingRow {
  source: string;
  provider: AgentHistoryProvider;
  sessions: number;
  matchedProjectId?: string;
  matchReason: ProjectMatchReason;
  confidence: number;
  action: ProjectMatchAction;
}

/** dry-run 完整报告（方案 §10.2）。 */
export interface DryRunReport {
  /** dry-run 锚定的当前 projectId（如有显式归属）。 */
  projectId?: string;
  /** 实际启用的来源 provider 列表。 */
  providers: AgentHistoryProvider[];
  sourceFiles: number;
  sessionsMatched: number;
  sessionsSkipped: number;
  estimatedChunks: number;
  requiresConfirmation: number;
  /** 按候选类型预估数量（方案 §6.2 五类）。 */
  candidateEstimates: Record<CandidateSemanticType, number>;
  /** 来源级映射明细。 */
  sources: SourceMappingRow[];
  /** redaction 命中总数（安全可见性）。 */
  redactedHits: number;
  /** 远端 provider 提示（embedding/LLM 为远端时填充，方案 §11.5）。 */
  remoteProviderWarning?: string;
  /** 文件级解析错误（不中断整批，仅汇报）。 */
  parseErrors: Array<{ sourcePath: string; error: string }>;
}

/** 候选语义类型（对齐 5 slot，方案 §6.2）。 */
export type CandidateSemanticType =
  | "profile"
  | "task_context"
  | "rules"
  | "experience"
  | "resource";

/** 空候选预估初值。 */
export function emptyCandidateEstimates(): Record<CandidateSemanticType, number> {
  return { profile: 0, task_context: 0, rules: 0, experience: 0, resource: 0 };
}
