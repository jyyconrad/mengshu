import { describe, expect, it, vi } from "vitest";
import type { MemoryAutodbRegistry } from "../../../../packages/core/src/runtime/registry.js";
import {
  POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
  POSTGRES_SCHEMA_CUTOVER_TARGET,
  PostgresSchemaCutoverCliError,
  createPostgresSchemaCutoverPort,
  runPostgresSchemaCutover,
  type PostgresSchemaCutoverPort,
  type ScopeBackfillInspection,
} from "./migrate-v10.js";

const registry: MemoryAutodbRegistry = {
  version: 2,
  projects: {},
  workspaces: {},
};

function inspection(
  table: "memories" | "knowledge",
  overrides: Partial<ScopeBackfillInspection> = {},
): ScopeBackfillInspection {
  return {
    table,
    total: 0,
    canonical: 0,
    quarantined: 0,
    pending: 0,
    plan: {
      mode: "dry-run",
      table,
      scanned: 0,
      resolved: 0,
      quarantined: 0,
      conflict: 0,
      skipped: 0,
      batches: 0,
    },
    ...overrides,
  };
}

function fakePort(overrides: Partial<PostgresSchemaCutoverPort> = {}): PostgresSchemaCutoverPort {
  return {
    getSchemaContractStatus: vi.fn(async () => ({
      currentVersion: 5,
      targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
      scopeContentHashDedupe: "pending" as const,
    })),
    inspectScopeBackfill: vi.fn(async (table) => inspection(table)),
    applyScopeBackfill: vi.fn(async (table) => ({
      mode: "apply" as const,
      table,
      scanned: 0,
      resolved: 0,
      quarantined: 0,
      conflict: 0,
      skipped: 0,
      batches: 0,
    })),
    applyScopeContentHashDedupeContract: vi.fn(async () => ({
      currentVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
      targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
      scopeContentHashDedupe: "ready" as const,
    })),
    ...overrides,
  };
}

describe("runPostgresSchemaCutover", () => {
  it("默认只读，明确展示 current/target/pending 与 canonical/quarantine 计划", async () => {
    const port = fakePort({
      inspectScopeBackfill: vi.fn(async (table) => inspection(table, {
        total: table === "memories" ? 40_000 : 8_372,
        pending: table === "memories" ? 40_000 : 8_372,
        plan: {
          ...inspection(table).plan,
          scanned: table === "memories" ? 40_000 : 8_372,
          quarantined: table === "memories" ? 40_000 : 8_372,
        },
      })),
    });

    const report = await runPostgresSchemaCutover(port, registry);

    expect(report).toMatchObject({
      mode: "dry-run",
      currentVersion: 5,
      targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
      pendingVersions: Array.from(
        { length: POSTGRES_SCHEMA_CUTOVER_TARGET - 5 },
        (_, index) => index + 6,
      ),
      canonical: 0,
      pending: 48_372,
      existingQuarantined: 0,
      plannedQuarantined: 48_372,
      quarantined: 48_372,
      conflicts: 0,
      unresolved: 0,
      allowedQuarantine: 0,
      requiredConfirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      contractApplied: false,
    });
    expect(port.applyScopeBackfill).not.toHaveBeenCalled();
    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });

  it("缺少确认令牌时 apply 零写入", async () => {
    const port = fakePort();

    await expect(runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      allowQuarantine: 0,
    })).rejects.toMatchObject({
      code: "SCHEMA_CUTOVER_CONFIRMATION_REQUIRED",
    });

    expect(port.applyScopeBackfill).not.toHaveBeenCalled();
    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });

  it("apply 未显式声明 quarantine 精确数量时零写入", async () => {
    const port = fakePort();

    await expect(runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
    })).rejects.toMatchObject({
      code: "SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE",
    });

    expect(port.getSchemaContractStatus).not.toHaveBeenCalled();
    expect(port.applyScopeBackfill).not.toHaveBeenCalled();
    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "apply 拒绝非安全 quarantine 数量 %s，且零写入",
    async (allowQuarantine) => {
      const port = fakePort();

      await expect(runPostgresSchemaCutover(port, registry, {
        apply: true,
        maintenance: true,
        quiescenceConfirmed: true,
        confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
        allowQuarantine,
      })).rejects.toMatchObject({
        code: "SCHEMA_CUTOVER_INVALID_QUARANTINE_ALLOWANCE",
      });

      expect(port.getSchemaContractStatus).not.toHaveBeenCalled();
      expect(port.applyScopeBackfill).not.toHaveBeenCalled();
      expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
    },
  );

  it("quarantine 计划与显式 allowance 不精确相等时 fail-closed", async () => {
    const port = fakePort({
      inspectScopeBackfill: vi.fn(async (table) => inspection(table, {
        total: table === "memories" ? 3 : 1,
        quarantined: table === "memories" ? 1 : 0,
        pending: table === "memories" ? 2 : 1,
        plan: {
          ...inspection(table).plan,
          scanned: table === "memories" ? 2 : 1,
          resolved: table === "memories" ? 1 : 0,
          quarantined: 1,
        },
      })),
    });

    await expect(runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 2,
    })).rejects.toMatchObject({
      code: "SCHEMA_CUTOVER_QUARANTINE_MISMATCH",
      report: expect.objectContaining({
        existingQuarantined: 1,
        plannedQuarantined: 2,
        quarantined: 3,
        allowedQuarantine: 2,
        conflicts: 0,
        unresolved: 0,
      }),
    });

    expect(port.applyScopeBackfill).not.toHaveBeenCalled();
    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });

  it("存在冲突时即使 quarantine allowance 精确匹配也始终 fail-closed", async () => {
    const port = fakePort({
      inspectScopeBackfill: vi.fn(async (table) => inspection(table, {
        total: table === "memories" ? 48_000 : 372,
        pending: table === "memories" ? 48_000 : 372,
        plan: {
          ...inspection(table).plan,
          scanned: table === "memories" ? 48_000 : 372,
          quarantined: table === "memories" ? 48_000 : 371,
          conflict: table === "knowledge" ? 1 : 0,
        },
      })),
    });

    await expect(runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 48_371,
    })).rejects.toMatchObject({
      code: "SCHEMA_CUTOVER_UNRESOLVED_SCOPE",
      report: expect.objectContaining({
        quarantined: 48_371,
        conflicts: 1,
        unresolved: 1,
      }),
    });

    expect(port.applyScopeBackfill).not.toHaveBeenCalled();
    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });

  it("全量可解析时先回填并复核，再连续应用到 v10", async () => {
    let inspected = 0;
    const port = fakePort({
      inspectScopeBackfill: vi.fn(async (table) => {
        inspected += 1;
        if (inspected <= 2) {
          return inspection(table, {
            total: 1,
            pending: 1,
            plan: { ...inspection(table).plan, scanned: 1, resolved: 1 },
          });
        }
        return inspection(table, { total: 1, canonical: 1 });
      }),
    });

    const report = await runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 0,
    });

    expect(port.applyScopeBackfill).toHaveBeenCalledTimes(2);
    expect(port.applyScopeBackfill).toHaveBeenNthCalledWith(1, "memories", registry, 0);
    expect(port.applyScopeBackfill).toHaveBeenNthCalledWith(2, "knowledge", registry, 0);
    expect(port.applyScopeContentHashDedupeContract).toHaveBeenCalledWith({
      maintenance: true,
      quiescenceConfirmed: true,
    });
    expect(report).toMatchObject({
      mode: "apply",
      currentVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
      targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
      pendingVersions: [],
      canonical: 2,
      pending: 0,
      unresolved: 0,
      conflicts: 0,
      allowedQuarantine: 0,
      contractApplied: true,
    });
  });

  it("schema 已 ready 时 apply 幂等，不重复回填或 contract", async () => {
    const port = fakePort({
      getSchemaContractStatus: vi.fn(async () => ({
        currentVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        scopeContentHashDedupe: "ready" as const,
      })),
    });

    const report = await runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 0,
    });

    expect(report.alreadyReady).toBe(true);
    expect(report.contractApplied).toBe(false);
    expect(port.applyScopeBackfill).not.toHaveBeenCalled();
    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });

  it("v10 contract ready 但当前 runtime 还有 v11 expand 时不隐藏 pending v11", async () => {
    const port = fakePort({
      getSchemaContractStatus: vi.fn(async () => ({
        currentVersion: 10,
        targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        scopeContentHashDedupe: "ready" as const,
      })),
    });

    const report = await runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 0,
    });

    expect(port.applyScopeContentHashDedupeContract).toHaveBeenCalledTimes(1);
    expect(report.currentVersion).toBe(POSTGRES_SCHEMA_CUTOVER_TARGET);
  });

  it("显式 allowance 精确覆盖 existing+planned quarantine 时允许回填与 DDL", async () => {
    let inspected = 0;
    const port = fakePort({
      inspectScopeBackfill: vi.fn(async (table) => {
        inspected += 1;
        const tableQuarantine = table === "memories" ? 2 : 0;
        if (inspected <= 2) {
          return inspection(table, {
            total: tableQuarantine,
            pending: tableQuarantine,
            plan: {
              ...inspection(table).plan,
              scanned: tableQuarantine,
              quarantined: tableQuarantine,
            },
          });
        }
        return inspection(table, {
          total: tableQuarantine,
          quarantined: tableQuarantine,
        });
      }),
    });

    const report = await runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 2,
    });

    expect(port.applyScopeBackfill).toHaveBeenCalledTimes(2);
    expect(port.applyScopeBackfill).toHaveBeenNthCalledWith(1, "memories", registry, 2);
    expect(port.applyScopeBackfill).toHaveBeenNthCalledWith(2, "knowledge", registry, 0);
    expect(port.applyScopeContentHashDedupeContract).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      quarantined: 2,
      existingQuarantined: 2,
      plannedQuarantined: 0,
      allowedQuarantine: 2,
      conflicts: 0,
      unresolved: 0,
      contractApplied: true,
    });
  });

  it("post-backfill quarantine 漂移时不执行 DDL", async () => {
    let inspected = 0;
    const port = fakePort({
      inspectScopeBackfill: vi.fn(async (table) => {
        inspected += 1;
        if (inspected <= 2) {
          return inspection(table, {
            total: 1,
            pending: 1,
            plan: { ...inspection(table).plan, scanned: 1, quarantined: 1 },
          });
        }
        return inspection(table, { total: 2, quarantined: 2 });
      }),
    });

    await expect(runPostgresSchemaCutover(port, registry, {
      apply: true,
      maintenance: true,
      quiescenceConfirmed: true,
      confirmationToken: POSTGRES_SCHEMA_CUTOVER_CONFIRMATION_TOKEN,
      allowQuarantine: 2,
    })).rejects.toMatchObject({
      code: "SCHEMA_CUTOVER_QUARANTINE_MISMATCH",
      report: expect.objectContaining({ quarantined: 4, allowedQuarantine: 2 }),
    });

    expect(port.applyScopeContentHashDedupeContract).not.toHaveBeenCalled();
  });
});

describe("createPostgresSchemaCutoverPort", () => {
  it("只把固定 scope inspection/backfill/contract facade 暴露给 CLI", async () => {
    const provider = {
      getSchemaContractStatus: vi.fn(async () => ({
        currentVersion: 5,
        targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        scopeContentHashDedupe: "pending" as const,
      })),
      inspectScopeBackfill: vi.fn(async ({ table }: { table: "memories" | "knowledge" }) =>
        inspection(table)),
      applyScopeBackfill: vi.fn(async ({ table }: { table: "memories" | "knowledge" }) => ({
        ...inspection(table).plan,
        mode: "apply" as const,
      })),
      applyScopeContentHashDedupeContract: vi.fn(async () => ({
        currentVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        targetVersion: POSTGRES_SCHEMA_CUTOVER_TARGET,
        scopeContentHashDedupe: "ready" as const,
      })),
    };

    const port = createPostgresSchemaCutoverPort(provider);
    await port.inspectScopeBackfill("memories", registry);
    await port.applyScopeBackfill("knowledge", registry, 2);

    expect(provider.inspectScopeBackfill).toHaveBeenCalledWith({
      table: "memories",
      registry,
      batchSize: 1_000,
    });
    expect(provider.applyScopeBackfill).toHaveBeenCalledWith({
      table: "knowledge",
      registry,
      maintenance: true,
      quiescenceConfirmed: true,
      batchSize: 1_000,
      allowedQuarantine: 2,
    });
    expect(Object.keys(port).sort()).toEqual([
      "applyScopeBackfill",
      "applyScopeContentHashDedupeContract",
      "getSchemaContractStatus",
      "inspectScopeBackfill",
    ]);
  });
});
