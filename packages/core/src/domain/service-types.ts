/**
 * MemoryService 的输入输出契约。
 *
 * 这些 DTO 是 REST/MCP/SDK/OpenClaw adapter 共用的服务边界，避免上层直接依赖
 * 旧 `DatabaseProvider` 或具体向量库实现。
 */

import type {
  DatabaseStoreCleanupMetadata,
  DataType,
  TableName,
} from "../db/types.js";
import { DATABASE_STORE_CLEANUP_WARNING } from "../db/types.js";
import type { AuthorityScope } from "./authority-scope.js";
import type {
  NormalizedProviderFilter,
  ProviderFilterTable,
  ProviderFilterValues,
} from "./provider-filter.js";
import type { ContextBlock, MemoryRecord, MemoryScope, MemoryScopeInput, RecallResult } from "./types.js";

export type { RecallResult } from "./types.js";

export interface StoreMemoryInput {
  record: MemoryRecord;
}

export interface StoreMemoryResult {
  id: string;
  stored: boolean;
  warnings?: Array<typeof DATABASE_STORE_CLEANUP_WARNING>;
}

export interface MemoryRepositoryStoreRecordResult {
  requestedId: string;
  persistedId: string;
  stored: boolean;
}

export interface MemoryRepositoryStoreResult {
  inserted: number;
  duplicates: number;
  records: MemoryRepositoryStoreRecordResult[];
  cleanup?: DatabaseStoreCleanupMetadata;
}

export interface RecallInput {
  query: string;
  scope?: MemoryScopeInput;
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  tableName?: TableName;
  dataTypes?: DataType[];
  searchAll?: boolean;

  // D-25：项目/产品维度过滤（默认软过滤，按需硬过滤）
  /** 按项目精确筛选（硬过滤，对应 project_name 列）。不传则跨项目软召回。 */
  filterProject?: string;
  /** 按产品精确筛选（硬过滤，对应 app_name 列）。 */
  filterProduct?: string;
  /** 筛选模式。"soft"=仅 scopeFit 排序（默认），"hard"=精确过滤。 */
  scopeFilterMode?: "soft" | "hard";
  /** 项目相似检索（LIKE pattern，如 "openclaw%"）。与 filterProject 互斥。 */
  projectPattern?: string;
}

export interface BuildContextInput extends RecallInput {
  title?: string;
}

export interface DeleteMemoryInput {
  ids?: string[];
  filter?: Record<string, unknown>;
}

export interface DeleteMemoryResult {
  deleted: number;
}

/** AuthorityScope 驱动的事务化 forget 动作。旧 forgetCommand 继续兼容其它治理动作。 */
export type AuthorityScopedForgetAction = "revoke" | "archive" | "delete";

/**
 * RB1 adapter 调用合同。serverAuthority 必须由认证后的服务端上下文提供；
 * clientScope 只允许 AuthorityScope allowlist 中的非身份字段。
 */
export interface AuthorityScopedForgetInput {
  serverAuthority: AuthorityScope;
  clientScope: unknown;
  action: AuthorityScopedForgetAction;
  ids?: readonly string[];
  filter?: ProviderFilterValues;
  tableName?: ProviderFilterTable;
  dataTypes?: readonly DataType[];
  idempotencyKey: string;
  actor?: string;
  reason?: string;
  now?: number;
}

export interface AuthorityScopedForgetResult {
  action: AuthorityScopedForgetAction;
  affected: number;
  deleted: number;
  affectedIds: readonly string[];
  transactional: true;
  idempotentReplay: boolean;
}

interface ForgetTargetSelectionBase {
  readonly scope: MemoryScope;
  readonly tableName: ProviderFilterTable;
  readonly dataTypes: readonly DataType[];
}

export type ForgetTargetSelection =
  | (ForgetTargetSelectionBase & {
      readonly kind: "ids";
      /** 每个 id 都已经经过 provider-neutral filter 归一化并注入 authority。 */
      readonly filters: readonly NormalizedProviderFilter[];
    })
  | (ForgetTargetSelectionBase & {
      readonly kind: "filter";
      readonly filter: NormalizedProviderFilter;
    });

export interface ForgetAuditEvent {
  readonly idempotencyKey: string;
  readonly action: AuthorityScopedForgetAction;
  readonly targetId: string;
  readonly scope: MemoryScope;
  readonly actor?: string;
  readonly reason?: string;
  readonly at: number;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
}

export interface ForgetOutboxEvent {
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly topic: "memory.lifecycle.changed" | "memory.deleted";
  readonly action: AuthorityScopedForgetAction;
  readonly targetId: string;
  readonly scope: MemoryScope;
  readonly occurredAt: number;
}

export interface AuthorityScopedForgetReceipt {
  readonly idempotencyKey: string;
  /** receipt identity 的 authority namespace；数据库使用 tenant/user/key 复合主键。 */
  readonly scope: MemoryScope;
  readonly requestFingerprint: string;
  readonly result: AuthorityScopedForgetResult;
}

/** 同一 transaction context 内必须覆盖记录、audit、outbox 和 idempotency receipt。 */
export interface ForgetTransactionContext {
  findTargets(selection: ForgetTargetSelection): Promise<MemoryRecord[]>;
  replace(records: readonly MemoryRecord[]): Promise<void>;
  delete(ids: readonly string[]): Promise<void>;
  appendAudit(events: readonly ForgetAuditEvent[]): Promise<void>;
  appendOutbox(events: readonly ForgetOutboxEvent[]): Promise<void>;
  getReceipt(scope: MemoryScope, idempotencyKey: string): Promise<AuthorityScopedForgetReceipt | undefined>;
  saveReceipt(receipt: AuthorityScopedForgetReceipt): Promise<void>;
}

/** Provider 必须提供真实 callback transaction；不支持时不得注入空壳实现。 */
export interface ForgetTransactionPort {
  transaction<T>(work: (transaction: ForgetTransactionContext) => Promise<T>): Promise<T>;
}

/** 独立于旧 MemoryService，避免未升级 adapter 把 raw client authority 塞入 delete DTO。 */
export interface AuthorityScopedForgetService {
  forget(input: AuthorityScopedForgetInput): Promise<AuthorityScopedForgetResult>;
}

export interface HealthSnapshot {
  ok: boolean;
  records?: number;
  error?: string;
}

export interface MemoryService {
  storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  buildContext(input: BuildContextInput): Promise<ContextBlock>;
  delete(input: DeleteMemoryInput): Promise<DeleteMemoryResult>;
  health(): Promise<HealthSnapshot>;
}

export interface MemoryRepositoryQuery {
  query: string;
  vector?: number[];
  scope: MemoryScope;
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  tableName?: TableName;
  dataTypes?: DataType[];
  searchAll?: boolean;
  // 注意：scope 维度硬过滤通过 filter 的内部 key 传递（_projectName/_appName/_projectPattern），
  // adapter.toLegacyQueryOptions 提取后映射到 MemoryQueryOptions.projectName 等。
}

export interface MemoryRepository {
  store(records: MemoryRecord[]): Promise<MemoryRepositoryStoreResult | void>;
  query(input: MemoryRepositoryQuery): Promise<Array<MemoryRecord & { score: number }>>;
  delete(ids: string[]): Promise<void>;
  deleteByFilter(filter: Record<string, unknown>): Promise<number>;
  count(filter?: Record<string, unknown>): Promise<number>;
}

export interface EmbeddingPort {
  embed(text: string): Promise<number[]>;
}
