/**
 * 记忆中间件的核心领域类型。
 *
 * 这些类型定义跨 OpenClaw、REST、MCP、SDK 和 Web Console 共享的稳定边界。
 * 旧 `MemoryEntry` 仍由 legacy mapping 适配，核心层只依赖 scope、record、
 * provenance 和 context block 等通用概念。
 *
 * v3.0 升级：
 * - MemoryScope 扩展 workspaceId/sessionId/visibility（向后兼容）
 * - MemoryRecord 新增可选 semanticType / lifecycleStatus / container
 * - 新增 MemoryEdge / MemorySemanticType 等结构化字段
 */

import type { MemoryCategory } from "../config.js";
import type { DataType, TableName } from "../db/types.js";

/**
 * MemorySemanticType: 5 问题语义协议
 *
 * 面向 Agent 执行前必须知道的 5 个问题：
 * - profile: Q1 我为谁工作？
 * - task_context: Q2 我在做什么？
 * - rules: Q3 什么不能做？
 * - experience: Q4 之前怎么做过？
 * - resource: Q5 有什么可用资源？
 */
export type MemorySemanticType =
  | "profile"
  | "task_context"
  | "rules"
  | "experience"
  | "resource";

/**
 * ProfileLayer: profile 记忆的 3 层分层（D-13，§3.3）
 *
 * 避免项目偏好污染全局画像，召回优先级 project > app > global：
 * - project: 绑定明确 projectId/repo/任务域，或用户说"这个项目里"
 * - app: 绑定 appId/agent/工具，但不绑定具体项目
 * - global: 跨项目长期偏好，或来自全局规则文件
 */
export type ProfileLayer = "project" | "app" | "global";

/**
 * MemoryContainer: 记忆容器（语义归属）
 *
 * 与 MemoryScope（隔离边界）正交：
 * - personal: 个人偏好、画像
 * - project: 项目目标、约束
 * - session_candidate: 候选区（待审核）
 * - team: 团队规范（v1+）
 * - enterprise: 企业合规（v1+）
 */
export type MemoryContainer =
  | "personal"
  | "project"
  | "session_candidate"
  | "team"
  | "enterprise";

/**
 * MemoryLifecycleStatus: 记忆生命周期状态
 */
export type MemoryLifecycleStatus =
  | "active"
  | "archived"
  | "revoked"
  | "superseded"
  | "promoted";

/**
 * AdmissionRoute: 准入路由结果（D-02 / D-19，§0.3.1 / §6.2）
 *
 * 表示一条新记忆经过 admission 打分后被路由到的去向，是"准入阶段"的瞬时结果，
 * 与候选区状态机 `CandidateStatus`、主库生命周期 `MemoryLifecycleStatus` 分开定义，
 * 严禁共用同一枚举（D-19）。取值严格对应 §0.3.1 表：
 * - drop: 低于阈值带，不入库（不可见）
 * - candidate_low_priority: 0.40–0.55，低优先候选（TTL=30d）
 * - candidate: 0.55–0.88，普通候选
 * - active: >=0.88，直接进入主库 active
 * - lookup_only / evidence_only: economy 模式不丢弃，仅保留可搜索/证据（D-20）
 */
export type AdmissionRoute =
  | "drop"
  | "candidate_low_priority"
  | "candidate"
  | "active"
  | "lookup_only"
  | "evidence_only";

/**
 * UserVisibleStatus: 用户可见聚合视图（§0.3.1，D-19）
 *
 * 仅服务于 CLI/UI 聚合呈现层（`ms list` / `ms why`）：
 * - 不持久化、不落库
 * - 不参与任何算法判定（算法只认 AdmissionRoute / CandidateStatus / MemoryLifecycleStatus 三套内部状态）
 * 由 `mapToUserVisibleStatus` 从内部状态单向聚合得到。
 */
export type UserVisibleStatus =
  | "active"
  | "pending"
  | "low_priority"
  | "archived"
  | "forgotten";

/**
 * MemoryVisibility: 可见性
 */
export type MemoryVisibility = "private" | "workspace" | "team" | "public";

export interface MemoryScope {
  tenantId: string;
  appId: string;
  userId: string;
  projectId: string;
  agentId: string;
  namespace: string;
  /** v3.0 新增（可选）：工作空间 ID */
  workspaceId?: string;
  /** v3.0 新增（可选）：会话 ID */
  sessionId?: string;
  /** v3.0 新增（可选）：可见性，默认 private */
  visibility?: MemoryVisibility;
}

export type MemoryScopeInput = Partial<{
  tenantId: string | null;
  appId: string | null;
  userId: string | null;
  projectId: string | null;
  agentId: string | null;
  namespace: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  visibility: MemoryVisibility | null;
}>;

export type MemoryKind =
  | "preference"
  | "decision"
  | "entity"
  | "fact"
  | "task"
  | "plan"
  | "goal"
  | "document"
  | "knowledge"
  | "observation"
  | "other";

export interface RecordProvenance {
  source?: "user" | "agent" | "system" | "scan" | string;
  sourceId?: string;
  sessionId?: string;
  conversationId?: string;
  messageId?: string;
  filePath?: string;
  createdAt?: number;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  /** v3.0 新增（可选）：5 问题语义视图 */
  semanticType?: MemorySemanticType;
  /** v3.0 新增（可选）：记忆容器，默认 project */
  container?: MemoryContainer;
  /** v3.0 新增（可选）：生命周期状态，默认 active */
  lifecycleStatus?: MemoryLifecycleStatus;
  /** v3.0 新增（可选）：置信度 0-1，默认 1（用户显式保存） */
  confidence?: number;
  /** v3.0 新增（可选）：热度（被召回次数） */
  hotness?: number;
  text: string;
  contentHash: string;
  importance: number;
  category: MemoryCategory;
  dataType: DataType;
  tableName?: TableName;
  metadata: Record<string, unknown>;
  provenance: RecordProvenance;
  /** v3.0 新增（可选）：原始证据来源节点 */
  sourceNodeIds?: string[];
  /** v3.0 新增（可选）：被替代的旧版本节点 */
  supersededBy?: string;
  /** v3.0 新增（可选）：升格为 SKILL 的 ID */
  promotedToSkillId?: string;
  /** v3.0 新增（可选）：版本号 */
  version?: number;
  /** D-13 新增（可选）：profile 分层标识，仅 semanticType=profile 时有效 */
  profileLayer?: ProfileLayer;
  /** §3.3 新增（可选）：profile 维度，仅 semanticType=profile 时有效 */
  profileDimension?: string;
  createdAt: number;
  updatedAt?: number;
  vector?: number[];
}

/**
 * MemoryEdge: 工作记忆图谱关系（v0.4+）
 */
export interface MemoryEdge {
  id: string;
  scope: MemoryScope;
  sourceId: string;
  targetId: string;
  predicate:
    | "derives_from"
    | "constrains"
    | "supports"
    | "contradicts"
    | "supersedes"
    | "references"
    | "uses"
    | "belongs_to"
    | "promoted_to"
    | "grounded_by"
    | "mentions";
  edgeType?: "entity_relation" | "memory_relation";
  confidence: number;
  evidenceChunkIds: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

/**
 * GraphNode: 统一图谱节点（v0.4+）
 */
export interface GraphNode {
  id: string;
  scope: MemoryScope;
  nodeType: "entity" | "memory" | "summary" | "skill_candidate";
  label: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

export interface ObservationRecord extends MemoryRecord {
  kind: "observation";
}

export interface DocumentRecord {
  id: string;
  scope: MemoryScope;
  title?: string;
  uri?: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

export interface ChunkRecord {
  id: string;
  scope: MemoryScope;
  documentId?: string;
  text: string;
  contentHash: string;
  ordinal: number;
  tokenCount?: number;
  metadata: Record<string, unknown>;
  provenance: RecordProvenance;
  createdAt: number;
  vector?: number[];
}

export interface EntityRecord {
  id: string;
  scope: MemoryScope;
  name: string;
  normalizedName: string;
  type: string;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

export interface RelationRecord {
  id: string;
  scope: MemoryScope;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  confidence: number;
  evidenceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

export interface SummaryNode {
  id: string;
  scope: MemoryScope;
  treeType: "source" | "topic" | "global";
  parentId?: string;
  level: number;
  title?: string;
  summary: string;
  childIds: string[];
  evidenceIds: string[];
  tokenCount?: number;
  createdAt: number;
  updatedAt?: number;
}

export interface RecallHit {
  record: MemoryRecord | ChunkRecord | SummaryNode;
  score: number;
  source: "vector" | "text" | "recent" | "graph" | "tree";
  scoreBreakdown?: Record<string, number>;
  provenance?: RecordProvenance;
}

export interface RecallResult {
  scope: MemoryScope;
  query: string;
  hits: RecallHit[];
}

export interface ContextBlock {
  scope: MemoryScope;
  content: string;
  hits: RecallHit[];
  tokenEstimate?: number;
}
