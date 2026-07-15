import type {
  ExecutePostgresScopeBackfillResult,
  ScopeBackfillTable,
} from "../../../../packages/core/src/db/migrations/scope-backfill-executor.js";
import { CURRENT_SCHEMA_VERSION } from
  "../../../../packages/core/src/db/migrations/schema-migrations.js";
import type { MemoryAutodbRegistry } from
  "../../../../packages/core/src/runtime/registry.js";

export const POSTGRES_SCHEMA_CUTOVER_TARGET = CURRENT_SCHEMA_VERSION;
export const POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN =
  `APPLY-MENGSHU-POSTGRES-V${POSTGRES_SCHEMA_CUTOVER_TARGET}`;

const SCOPE_TABLES = ["memories", "knowledge"] as const;
const CLI_SCOPE_BACKFILL_BATCH_SIZE = 1_000;

export interface PostgresSchemaContractStatus {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly scopeContentHashDedupe: "pending" | "ready";
}

export interface ScopeBackfillInspection {
  readonly table: ScopeBackfillTable;
  readonly total: number;
  readonly canonical: number;
  readonly quarantined: number;
  readonly pending: number;
  readonly plan: ExecutePostgresScopeBackfillResult;
}

/**
 * CLI 只依赖固定 migration facade。实现方不得把 Pool、raw query 或任意 SQL
 * capability 暴露到命令层。
 */
export interface PostgresSchemaCutoverPort {
  getSchemaContractStatus(): Promise<PostgresSchemaContractStatus>;
  inspectScopeBackfill(
    table: ScopeBackfillTable,
    registry: MemoryAutodbRegistry,
  ): Promise<ScopeBackfillInspection>;
  applyScopeBackfill(
    table: ScopeBackfillTable,
    registry: MemoryAutodbRegistry,
    allowedQuarantine: number,
  ): Promise<ExecutePostgresScopeBackfillResult>;
  applyScopeContentHashDedupeContract(options: {
    maintenance: true;
    quiescenceConfirmed: true;
  }): Promise<PostgresSchemaContractStatus & { scopeContentHashDedupe: "ready" }>;
}

export interface PostgresSchemaCutoverProviderFacade {
  getSchemaContractStatus(): Promise<PostgresSchemaContractStatus>;
  inspectScopeBackfill(options: {
    readonly table: ScopeBackfillTable;
    readonly registry: MemoryAutodbRegistry;
    readonly batchSize?: number;
  }): Promise<ScopeBackfillInspection>;
  applyScopeBackfill(options: {
    readonly table: ScopeBackfillTable;
    readonly registry: MemoryAutodbRegistry;
    readonly maintenance: true;
    readonly quiescenceConfirmed: true;
    readonly allowedQuarantine: number;
    readonly batchSize?: number;
  }): Promise<ExecutePostgresScopeBackfillResult>;
  applyScopeContentHashDedupeContract(options: {
    maintenance: true;
    quiescenceConfirmed: true;
  }): Promise<PostgresSchemaContractStatus & { scopeContentHashDedupe: "ready" }>;
}

/** 只适配固定 provider facade；一次 run 使用调用方传入的同一 registry snapshot。 */
export function createPostgresSchemaCutoverPort(
  provider: PostgresSchemaCutoverProviderFacade,
): PostgresSchemaCutoverPort {
  return Object.freeze({
    getSchemaContractStatus: () => provider.getSchemaContractStatus(),
    inspectScopeBackfill: (table: ScopeBackfillTable, registry: MemoryAutodbRegistry) =>
      provider.inspectScopeBackfill({
        table,
        registry,
        batchSize: CLI_SCOPE_BACKFILL_BATCH_SIZE,
      }),
    applyScopeBackfill: (
      table: ScopeBackfillTable,
      registry: MemoryAutodbRegistry,
      allowedQuarantine: number,
    ) =>
      provider.applyScopeBackfill({
        table,
        registry,
        maintenance: true,
        quiescenceConfirmed: true,
        allowedQuarantine,
        batchSize: CLI_SCOPE_BACKFILL_BATCH_SIZE,
      }),
    applyScopeContentHashDedupeContract: (options: {
      maintenance: true;
      quiescenceConfirmed: true;
    }) => provider.applyScopeContentHashDedupeContract(options),
  });
}

export interface RunPostgresSchemaCutoverOptions {
  /** 缺省 false；只有显式 true 才允许进入写路径。 */
  readonly apply?: boolean;
  readonly maintenance?: boolean;
  readonly quiescenceConfirmed?: boolean;
  readonly confirmationToken?: string;
  /** apply 必须显式给出；表示操作员接受的 existing + planned quarantine 精确总数。 */
  readonly allowQuarantine?: number;
  readonly targetSchema?: string;
}

export interface PostgresSchemaCutoverReport {
  readonly mode: "dry-run" | "apply";
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly pendingVersions: readonly number[];
  readonly tables: readonly ScopeBackfillInspection[];
  readonly total: number;
  readonly canonical: number;
  readonly existingQuarantined: number;
  readonly plannedQuarantined: number;
  readonly quarantined: number;
  readonly pending: number;
  readonly resolvable: number;
  readonly conflicts: number;
  readonly unresolved: number;
  readonly allowedQuarantine: number;
  readonly requiredConfirmationToken: string;
  readonly contractApplied: boolean;
  readonly alreadyReady: boolean;
}

export type PostgresSchemaCutoverCliErrorCode =
  | "SCHEMA_CUTOVER_CONFIRMATION_REQUIRED"
  | "SCHEMA_CUTOVER_INVALID_TARGET"
  | "SCHEMA_CUTOVER_INVALID_STATUS"
  | "SCHEMA_CUTOVER_INVALID_INSPECTION"
  | "SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE"
  | "SCHEMA_CUTOVER_QUARANTINE_MISMATCH"
  | "SCHEMA_CUTOVER_UNRESOLVED_SCOPE"
  | "SCHEMA_CUTOVER_BACKFILL_INCOMPLETE"
  | "SCHEMA_CUTOVER_CONTRACT_INCOMPLETE";

const ERROR_MESSAGES: Record<PostgresSchemaCutoverCliErrorCode, string> = {
  SCHEMA_CUTOVER_CONFIRMATION_REQUIRED:
    "Postgres schema apply requires maintenance, writer quiescence, and the exact confirmation token",
  SCHEMA_CUTOVER_INVALID_TARGET: "Postgres schema target is not supported by this runtime",
  SCHEMA_CUTOVER_INVALID_STATUS: "Postgres schema status is invalid",
  SCHEMA_CUTOVER_INVALID_INSPECTION: "Postgres scope backfill inspection is invalid",
  SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE:
    "Postgres schema apply requires an explicit non-negative safe integer quarantine allowance",
  SCHEMA_CUTOVER_QUARANTINE_MISMATCH:
    "Postgres schema quarantine count does not exactly match the explicit allowance",
  SCHEMA_CUTOVER_UNRESOLVED_SCOPE:
    "Postgres schema contract is blocked by unresolved canonical scope records",
  SCHEMA_CUTOVER_BACKFILL_INCOMPLETE:
    "Postgres canonical scope backfill did not reach a contract-ready state",
  SCHEMA_CUTOVER_CONTRACT_INCOMPLETE: "Postgres schema contract did not reach the target version",
};

export class PostgresSchemaCutoverCliError extends Error {
  constructor(
    readonly code: PostgresSchemaCutoverCliErrorCode,
    readonly report?: PostgresSchemaCutoverReport,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "PostgresSchemaCutoverCliError";
  }
}

function fail(
  code: PostgresSchemaCutoverCliErrorCode,
  report?: PostgresSchemaCutoverReport,
): never {
  throw new PostgresSchemaCutoverCliError(code, report);
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertStatus(status: PostgresSchemaContractStatus): void {
  if (!isSafeCount(status.currentVersion) || !isSafeCount(status.targetVersion) ||
      status.currentVersion > status.targetVersion ||
      status.targetVersion !== POSTGRES_SCHEMA_CUTOVER_TARGET ||
      (status.scopeContentHashDedupe !== "pending" &&
        status.scopeContentHashDedupe !== "ready")) {
    fail("SCHEMA_CUTOVER_INVALID_STATUS");
  }
}

function assertInspection(
  expectedTable: ScopeBackfillTable,
  inspection: ScopeBackfillInspection,
): void {
  const counts = [
    inspection.total,
    inspection.canonical,
    inspection.quarantined,
    inspection.pending,
    inspection.plan.scanned,
    inspection.plan.resolved,
    inspection.plan.quarantined,
    inspection.plan.conflict,
    inspection.plan.skipped,
    inspection.plan.batches,
  ];
  if (inspection.table !== expectedTable || inspection.plan.table !== expectedTable ||
      inspection.plan.mode !== "dry-run" || counts.some((count) => !isSafeCount(count)) ||
      inspection.total !== inspection.canonical + inspection.quarantined + inspection.pending ||
      inspection.pending !== inspection.plan.scanned ||
      inspection.plan.scanned !== inspection.plan.resolved + inspection.plan.quarantined +
        inspection.plan.conflict + inspection.plan.skipped) {
    fail("SCHEMA_CUTOVER_INVALID_INSPECTION");
  }
}

async function inspectAll(
  port: PostgresSchemaCutoverPort,
  registry: MemoryAutodbRegistry,
): Promise<readonly ScopeBackfillInspection[]> {
  const tables = await Promise.all(SCOPE_TABLES.map(async (table) => {
    const result = await port.inspectScopeBackfill(table, registry);
    assertInspection(table, result);
    return result;
  }));
  return Object.freeze(tables);
}

function pendingVersions(currentVersion: number, targetVersion: number): readonly number[] {
  return Object.freeze(Array.from(
    { length: targetVersion - currentVersion },
    (_, index) => currentVersion + index + 1,
  ));
}

function buildReport(
  mode: "dry-run" | "apply",
  status: PostgresSchemaContractStatus,
  tables: readonly ScopeBackfillInspection[],
  allowedQuarantine: number,
  appliedConflicts = 0,
  overrides: Partial<Pick<PostgresSchemaCutoverReport,
    "contractApplied" | "alreadyReady">> = {},
): PostgresSchemaCutoverReport {
  const sum = (select: (table: ScopeBackfillInspection) => number): number => {
    let total = 0;
    for (const table of tables) {
      total += select(table);
      if (!isSafeCount(total)) fail("SCHEMA_CUTOVER_INVALID_INSPECTION");
    }
    return total;
  };
  const existingQuarantined = sum((table) => table.quarantined);
  const plannedQuarantined = sum((table) => table.plan.quarantined);
  const quarantined = existingQuarantined + plannedQuarantined;
  const conflicts = sum((table) => table.plan.conflict) + appliedConflicts;
  const unresolved = conflicts + sum((table) => table.plan.skipped);
  if (![quarantined, conflicts, unresolved].every(isSafeCount)) {
    fail("SCHEMA_CUTOVER_INVALID_INSPECTION");
  }
  return Object.freeze({
    mode,
    currentVersion: status.currentVersion,
    targetVersion: status.targetVersion,
    pendingVersions: pendingVersions(status.currentVersion, status.targetVersion),
    tables,
    total: sum((table) => table.total),
    canonical: sum((table) => table.canonical),
    existingQuarantined,
    plannedQuarantined,
    quarantined,
    pending: sum((table) => table.pending),
    resolvable: sum((table) => table.plan.resolved),
    conflicts,
    unresolved,
    allowedQuarantine,
    requiredConfirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
    contractApplied: overrides.contractApplied ?? false,
    alreadyReady: overrides.alreadyReady ?? false,
  });
}

function assertApplyGate(options: RunPostgresSchemaCutoverOptions): void {
  if (options.maintenance !== true || options.quiescenceConfirmed !== true ||
      options.confirmationToken !== POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN) {
    fail("SCHEMA_CUTOVER_CONFIRMATION_REQUIRED");
  }
  if (!isSafeCount(options.allowQuarantine)) {
    fail("SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE");
  }
}

/**
 * 安全的 v10 cutover 编排：
 * 1. 默认仅 inspection；2. apply 三重确认；3. unresolved 时任何回填/DDL 都不执行；
 * 4. 可解析 scope 全部回填并复核后，才允许 provider 连续应用 v6-v10。
 */
export async function runPostgresSchemaCutover(
  port: PostgresSchemaCutoverPort,
  registry: MemoryAutodbRegistry,
  options: RunPostgresSchemaCutoverOptions = {},
): Promise<PostgresSchemaCutoverReport> {
  const targetSchema = options.targetSchema ?? `v${POSTGRES_SCHEMA_CUTOVER_TARGET}`;
  if (targetSchema !== `v${POSTGRES_SCHEMA_CUTOVER_TARGET}`) {
    fail("SCHEMA_CUTOVER_INVALID_TARGET");
  }
  if (options.apply === true) assertApplyGate(options);
  const allowedQuarantine = options.allowQuarantine ?? 0;

  const initialStatus = await port.getSchemaContractStatus();
  assertStatus(initialStatus);
  const initialTables = await inspectAll(port, registry);
  const initialReport = buildReport(
    options.apply === true ? "apply" : "dry-run",
    initialStatus,
    initialTables,
    allowedQuarantine,
    0,
    {
      alreadyReady: initialStatus.scopeContentHashDedupe === "ready" &&
        initialStatus.currentVersion === initialStatus.targetVersion,
    },
  );
  if (options.apply !== true) {
    return initialReport;
  }
  if (initialReport.unresolved > 0) {
    fail("SCHEMA_CUTOVER_UNRESOLVED_SCOPE", initialReport);
  }
  if (initialReport.quarantined !== allowedQuarantine) {
    fail("SCHEMA_CUTOVER_QUARANTINE_MISMATCH", initialReport);
  }
  if (initialReport.alreadyReady) return initialReport;

  let appliedConflicts = 0;
  for (const table of SCOPE_TABLES) {
    const inspection = initialTables.find((item) => item.table === table);
    if (!inspection) fail("SCHEMA_CUTOVER_INVALID_INSPECTION", initialReport);
    const tableAllowance = inspection.quarantined + inspection.plan.quarantined;
    if (!isSafeCount(tableAllowance)) {
      fail("SCHEMA_CUTOVER_INVALID_INSPECTION", initialReport);
    }
    const result = await port.applyScopeBackfill(table, registry, tableAllowance);
    const counts = [
      result.scanned,
      result.resolved,
      result.quarantined,
      result.conflict,
      result.skipped,
      result.batches,
    ];
    if (result.mode !== "apply" || result.table !== table ||
        counts.some((count) => !isSafeCount(count)) ||
        result.scanned !== result.resolved + result.quarantined +
          result.conflict + result.skipped) {
      fail("SCHEMA_CUTOVER_BACKFILL_INCOMPLETE", initialReport);
    }
    appliedConflicts += result.conflict;
    if (!isSafeCount(appliedConflicts)) {
      fail("SCHEMA_CUTOVER_BACKFILL_INCOMPLETE", initialReport);
    }
  }
  const postBackfillTables = await inspectAll(port, registry);
  const postBackfillReport = buildReport(
    "apply",
    initialStatus,
    postBackfillTables,
    allowedQuarantine,
    appliedConflicts,
  );
  if (postBackfillReport.pending !== 0 || postBackfillReport.unresolved !== 0) {
    fail("SCHEMA_CUTOVER_BACKFILL_INCOMPLETE", postBackfillReport);
  }
  if (postBackfillReport.quarantined !== allowedQuarantine) {
    fail("SCHEMA_CUTOVER_QUARANTINE_MISMATCH", postBackfillReport);
  }

  const finalStatus = await port.applyScopeContentHashDedupeContract({
    maintenance: true,
    quiescenceConfirmed: true,
  });
  assertStatus(finalStatus);
  if (finalStatus.currentVersion !== finalStatus.targetVersion ||
      finalStatus.scopeContentHashDedupe !== "ready") {
    fail("SCHEMA_CUTOVER_CONTRACT_INCOMPLETE", postBackfillReport);
  }
  return buildReport(
    "apply",
    finalStatus,
    postBackfillTables,
    allowedQuarantine,
    0,
    { contractApplied: true },
  );
}
