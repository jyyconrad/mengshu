import { describe, expect, test } from "vitest";

import {
  MarkdownWorksetImportError,
  MarkdownWorksetImporter,
  markdownWorksetActivationConfirmationToken,
  markdownWorksetRollbackConfirmationToken,
  prepareMarkdownWorksetImport,
  type MarkdownWorksetImportActivationPort,
  type MarkdownWorksetImportActivationReceipt,
  type MarkdownWorksetImportCounts,
  type MarkdownWorksetImportPlan,
  type MarkdownWorksetImportReceipt,
  type MarkdownWorksetImportSnapshot,
  type MarkdownWorksetImportTransaction,
} from "./markdown-workset-importer.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetManifestSha256,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
  type MarkdownWorksetFileInput,
  type MarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
} from "./markdown-workset.js";
import type { HistoricalSourceDisposition } from "./history-curation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const NOW = "2026-08-28T08:00:00.000Z";

function nativeRecord(index: number): MarkdownWorksetNativeRecord {
  const id = `${String(index).padStart(8, "0")}-1111-4111-8111-${String(index).padStart(12, "0")}`;
  return {
    id,
    sourceTable: "memories",
    text: `governed memory ${index}`,
    contentHash: `legacy-hash-${index}`,
    vector: [index / 10, 0.25],
    importance: 0.8,
    category: "fact",
    dataType: "memory",
    metadata: { index, semanticType: "rules" },
    createdAt: "2026-08-28T00:00:00.000Z",
    tenantId: "tenant-a",
    userId: "user-a",
    canonicalProjectId: "project-a",
    productId: "codex",
    producerId: "agent-a",
    namespace: "memories",
    visibility: "private",
    lifecycleStatus: "active",
    scopeKey: "tenant-a:codex:user-a:project-a:agent-a:memories",
  };
}

function sourceRef(index: number): string {
  return `memories:${nativeRecord(index).id}`;
}

interface GovernedFixtureEntry {
  readonly index: number;
  readonly disposition: HistoricalSourceDisposition;
  readonly target?: string;
  readonly mergedFrom?: readonly string[];
}

function governedFixture(
  entries: readonly GovernedFixtureEntry[] = [
    { index: 1, disposition: "canonical_keep", target: sourceRef(1), mergedFrom: [sourceRef(4)] },
    { index: 2, disposition: "distinct_keep", target: sourceRef(2) },
    { index: 3, disposition: "lookup_only", target: sourceRef(3) },
    { index: 4, disposition: "merge_exact", target: sourceRef(1) },
    { index: 5, disposition: "merge_semantic", target: sourceRef(2) },
    { index: 6, disposition: "supersede", target: sourceRef(2) },
    { index: 7, disposition: "archive_stale" },
    { index: 8, disposition: "quarantine" },
  ],
): { manifest: MarkdownWorksetManifest; files: readonly MarkdownWorksetFileInput[] } {
  const files = entries.map((entry) => {
    const record = createMarkdownWorksetRecord({
      phase: "governed",
      scopeFingerprint: HASH_A,
      disposition: entry.disposition,
      canonicalTargetRef: entry.target,
      mergedFrom: entry.mergedFrom,
      policyVersion: "history-curation/v1",
      record: nativeRecord(entry.index),
    });
    return {
      relativePath: `governed/${String(entry.index).padStart(2, "0")}.md`,
      markdown: renderNativeRecordMarkdown(record),
    };
  });
  return {
    files,
    manifest: createMarkdownWorksetManifest({
      migrationRunId: "markdown-import-2026-08-28-01",
      phase: "governed",
      policyVersion: "history-curation/v1",
      createdAt: "2026-08-28T07:00:00.000Z",
      files,
    }),
  };
}

function counts(plan: MarkdownWorksetImportPlan): MarkdownWorksetImportCounts {
  return {
    liveRows: plan.liveRows.length,
    mappings: plan.mappings.length,
    archived: plan.archiveLedger.length,
    quarantined: plan.quarantineLedger.length,
  };
}

class FakeTransaction implements MarkdownWorksetImportTransaction {
  readonly events: string[];
  readonly current: MarkdownWorksetImportSnapshot;
  readonly receipts: Map<string, MarkdownWorksetImportReceipt>;
  failAt?: "before-image" | "stage-count" | "stage-hash" | "replace-count" |
    "replace-hash" | "restore-count" | "restore-hash" | "receipt";

  constructor(
    events: string[],
    current: MarkdownWorksetImportSnapshot,
    receipts: Map<string, MarkdownWorksetImportReceipt>,
  ) {
    this.events = events;
    this.current = current;
    this.receipts = receipts;
  }

  async readCurrentSnapshot(): Promise<MarkdownWorksetImportSnapshot> {
    this.events.push("read-current");
    return this.current;
  }

  async saveBeforeImage(input: {
    readonly runId: string;
    readonly snapshot: MarkdownWorksetImportSnapshot;
  }) {
    this.events.push("save-before-image");
    if (this.failAt === "before-image") throw new Error("injected before-image failure");
    return { beforeImageHash: HASH_B, snapshot: input.snapshot };
  }

  async stagePlan(plan: MarkdownWorksetImportPlan) {
    this.events.push("stage-plan");
    const stagedCounts = counts(plan);
    return {
      stageHash: this.failAt === "stage-hash" ? HASH_C : plan.stageHash,
      counts: this.failAt === "stage-count"
        ? { ...stagedCounts, mappings: stagedCounts.mappings - 1 }
        : stagedCounts,
    };
  }

  async replaceFromStage(input: {
    readonly runId: string;
    readonly expectedCurrentSnapshotHash: string;
    readonly stageHash: string;
    readonly expectedSnapshot: MarkdownWorksetImportSnapshot;
  }): Promise<MarkdownWorksetImportSnapshot> {
    this.events.push("atomic-replace");
    if (this.failAt === "replace-hash") {
      return { ...input.expectedSnapshot, snapshotHash: HASH_C };
    }
    if (this.failAt === "replace-count") {
      return {
        ...input.expectedSnapshot,
        counts: { ...input.expectedSnapshot.counts, liveRows: input.expectedSnapshot.counts.liveRows + 1 },
      };
    }
    return input.expectedSnapshot;
  }

  async restoreBeforeImage(input: {
    readonly runId: string;
    readonly beforeImageHash: string;
    readonly expectedCurrentSnapshotHash: string;
    readonly expectedRestoredSnapshot: MarkdownWorksetImportSnapshot;
  }): Promise<MarkdownWorksetImportSnapshot> {
    this.events.push("restore-before-image");
    if (this.failAt === "restore-hash") {
      return { ...input.expectedRestoredSnapshot, snapshotHash: HASH_C };
    }
    if (this.failAt === "restore-count") {
      return {
        ...input.expectedRestoredSnapshot,
        counts: { ...input.expectedRestoredSnapshot.counts, archived: 99 },
      };
    }
    return input.expectedRestoredSnapshot;
  }

  async writeReceipt(receipt: MarkdownWorksetImportReceipt): Promise<MarkdownWorksetImportReceipt> {
    this.events.push("write-receipt");
    const persisted = this.failAt === "receipt"
      ? { ...receipt, requestHash: HASH_C }
      : receipt;
    this.receipts.set(`${receipt.kind}:${receipt.idempotencyKey}`, persisted);
    return persisted;
  }
}

class FakeActivationPort implements MarkdownWorksetImportActivationPort {
  readonly events: string[] = [];
  readonly receipts = new Map<string, MarkdownWorksetImportReceipt>();
  current: MarkdownWorksetImportSnapshot = {
    snapshotHash: HASH_A,
    counts: { liveRows: 12, mappings: 12, archived: 0, quarantined: 0 },
  };
  failAt?: FakeTransaction["failAt"];

  async withRunLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    this.events.push(`lock:${runId}`);
    return work();
  }

  async readReceipt(
    kind: MarkdownWorksetImportReceipt["kind"],
    idempotencyKey: string,
  ): Promise<MarkdownWorksetImportReceipt | undefined> {
    this.events.push(`read-receipt:${kind}`);
    return this.receipts.get(`${kind}:${idempotencyKey}`);
  }

  async transaction<T>(
    work: (transaction: MarkdownWorksetImportTransaction) => Promise<T>,
  ): Promise<T> {
    this.events.push("begin");
    const pending = new Map(this.receipts);
    const transaction = new FakeTransaction(this.events, this.current, pending);
    transaction.failAt = this.failAt;
    try {
      const result = await work(transaction);
      this.receipts.clear();
      for (const [key, value] of pending) this.receipts.set(key, value);
      this.events.push("commit");
      return result;
    } catch (error) {
      this.events.push("rollback");
      throw error;
    }
  }
}

function activationInput(plan: MarkdownWorksetImportPlan) {
  return {
    plan,
    maintenanceMode: true as const,
    quiescenceConfirmed: true as const,
    manifestHash: plan.manifestHash,
    verifyHash: plan.verifyHash,
    expectedCurrentSnapshotHash: HASH_A,
    idempotencyKey: "activate-workset-001",
    confirmationToken: markdownWorksetActivationConfirmationToken({
      plan,
      expectedCurrentSnapshotHash: HASH_A,
    }),
  };
}

describe("Markdown workset import planner", () => {
  test("strict verify 后只物化 keep/lookup target，并完整保存 mapping、archive、quarantine ledger", () => {
    const fixture = governedFixture();
    const plan = prepareMarkdownWorksetImport({ mode: "prepare", ...fixture });

    expect(plan.mode).toBe("prepare");
    expect(plan.liveRows.map((row) => [row.targetRef, row.materialization])).toEqual([
      [sourceRef(1), "canonical_keep"],
      [sourceRef(2), "distinct_keep"],
      [sourceRef(3), "lookup_only"],
    ]);
    expect(new Set(plan.liveRows.map((row) => row.targetRef)).size).toBe(3);
    expect(plan.mappings).toHaveLength(8);
    expect(plan.archiveLedger.map((row) => row.disposition)).toEqual(["supersede", "archive_stale"]);
    expect(plan.quarantineLedger.map((row) => row.disposition)).toEqual(["quarantine"]);
    expect(plan.counts).toEqual({
      sourceTotal: 8,
      liveTargetTotal: 3,
      mappingTotal: 8,
      archiveTotal: 2,
      quarantineTotal: 1,
      unresolvedTotal: 0,
    });
    expect(plan.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.manifestHash).toBe(markdownWorksetManifestSha256(
      serializeMarkdownWorksetManifest(fixture.manifest),
    ));
    expect(plan.verifyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.resultSnapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("dry-run 仍严格验证但不能进入 activation；文件或 policy 漂移 fail closed", async () => {
    const fixture = governedFixture();
    const dryRun = prepareMarkdownWorksetImport({ mode: "dry_run", ...fixture });
    const port = new FakeActivationPort();
    const importer = new MarkdownWorksetImporter(port, () => NOW);

    await expect(importer.activate(activationInput(dryRun)))
      .rejects.toMatchObject({ code: "MARKDOWN_IMPORT_NOT_PREPARED" });
    expect(port.events).toEqual([]);

    const forgedPrepare = { ...dryRun, mode: "prepare" as const };
    await expect(importer.activate(activationInput(forgedPrepare)))
      .rejects.toMatchObject({ code: "MARKDOWN_IMPORT_INVALID_INPUT" });
    expect(port.events).toEqual([]);

    const drifted = fixture.files.map((file, index) => index === 0
      ? { ...file, markdown: file.markdown.replace("governed memory 1", "tampered") }
      : file);
    expect(() => prepareMarkdownWorksetImport({
      mode: "prepare",
      manifest: fixture.manifest,
      files: drifted,
    })).toThrowError(expect.objectContaining({ code: "MARKDOWN_IMPORT_VERIFY_FAILED" }));

    const wrongPolicy = governedFixture([
      { index: 1, disposition: "canonical_keep", target: sourceRef(1) },
    ]);
    const policyDriftFile = wrongPolicy.files[0]!;
    const policyDriftManifest = { ...wrongPolicy.manifest, policyVersion: "other-policy/v1" };
    expect(() => prepareMarkdownWorksetImport({
      mode: "prepare",
      manifest: policyDriftManifest,
      files: [policyDriftFile],
    })).toThrowError(MarkdownWorksetImportError);
  });

  test("重复 live target、缺失 canonical target 与 source coverage 不完整均拒绝", () => {
    const duplicateTarget = governedFixture([
      { index: 1, disposition: "canonical_keep", target: sourceRef(1) },
      { index: 2, disposition: "distinct_keep", target: sourceRef(1) },
    ]);
    expect(() => prepareMarkdownWorksetImport({ mode: "prepare", ...duplicateTarget }))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_IMPORT_DUPLICATE_LIVE_TARGET" }));

    const missingTarget = governedFixture([
      { index: 1, disposition: "canonical_keep" },
    ]);
    expect(() => prepareMarkdownWorksetImport({ mode: "prepare", ...missingTarget }))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_IMPORT_UNRESOLVED_SOURCE" }));

    const danglingSupersede = governedFixture([
      { index: 1, disposition: "canonical_keep", target: sourceRef(1) },
      { index: 2, disposition: "supersede", target: sourceRef(99) },
    ]);
    expect(() => prepareMarkdownWorksetImport({ mode: "prepare", ...danglingSupersede }))
      .toThrowError(expect.objectContaining({ code: "MARKDOWN_IMPORT_UNRESOLVED_SOURCE" }));
  });

  test("相同 governed files 的 hash 和排序不依赖输入顺序", () => {
    const fixture = governedFixture();
    const forward = prepareMarkdownWorksetImport({ mode: "prepare", ...fixture });
    const reversed = prepareMarkdownWorksetImport({
      mode: "prepare",
      manifest: fixture.manifest,
      files: [...fixture.files].reverse(),
    });

    expect(reversed).toEqual(forward);
  });
});

describe("Markdown workset atomic activation", () => {
  test("在 run lock 内保存 before-image、stage、CAS replace 并写幂等 receipt", async () => {
    const plan = prepareMarkdownWorksetImport({ mode: "prepare", ...governedFixture() });
    const port = new FakeActivationPort();
    const importer = new MarkdownWorksetImporter(port, () => NOW);
    const input = activationInput(plan);

    const receipt = await importer.activate(input);

    expect(receipt.kind).toBe("activate");
    expect(receipt.beforeImageHash).toBe(HASH_B);
    expect(receipt.beforeSnapshot.snapshotHash).toBe(HASH_A);
    expect(receipt.afterSnapshot).toEqual(plan.resultSnapshot);
    expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(port.events).toEqual([
      `lock:${plan.runId}`,
      "read-receipt:activate",
      "begin",
      "read-current",
      "save-before-image",
      "stage-plan",
      "atomic-replace",
      "write-receipt",
      "commit",
    ]);

    port.events.length = 0;
    await expect(importer.activate(input)).resolves.toEqual(receipt);
    expect(port.events).toEqual([`lock:${plan.runId}`, "read-receipt:activate"]);
  });

  test("maintenance、quiescence、manifest/verify hash 与精确 token 任一缺失都不触碰 port", async () => {
    const plan = prepareMarkdownWorksetImport({ mode: "prepare", ...governedFixture() });
    const valid = activationInput(plan);
    const variants = [
      { ...valid, maintenanceMode: false as const },
      { ...valid, quiescenceConfirmed: false as const },
      { ...valid, manifestHash: HASH_C },
      { ...valid, verifyHash: HASH_C },
      { ...valid, confirmationToken: `${valid.confirmationToken}:force` },
    ];

    for (const input of variants) {
      const port = new FakeActivationPort();
      const importer = new MarkdownWorksetImporter(port, () => NOW);
      await expect(importer.activate(input as Parameters<typeof importer.activate>[0]))
        .rejects.toBeInstanceOf(MarkdownWorksetImportError);
      expect(port.events).toEqual([]);
    }
  });

  test("同一 idempotency key 不同 request hash 拒绝，snapshot CAS 漂移不保存 before-image", async () => {
    const plan = prepareMarkdownWorksetImport({ mode: "prepare", ...governedFixture() });
    const port = new FakeActivationPort();
    const importer = new MarkdownWorksetImporter(port, () => NOW);
    const input = activationInput(plan);
    await importer.activate(input);

    const changed = {
      ...input,
      expectedCurrentSnapshotHash: HASH_C,
      confirmationToken: markdownWorksetActivationConfirmationToken({
        plan,
        expectedCurrentSnapshotHash: HASH_C,
      }),
    };
    await expect(importer.activate(changed))
      .rejects.toMatchObject({ code: "MARKDOWN_IMPORT_IDEMPOTENCY_CONFLICT" });

    const freshPort = new FakeActivationPort();
    freshPort.current = { ...freshPort.current, snapshotHash: HASH_B };
    const freshImporter = new MarkdownWorksetImporter(freshPort, () => NOW);
    await expect(freshImporter.activate(input))
      .rejects.toMatchObject({ code: "MARKDOWN_IMPORT_SNAPSHOT_DRIFT" });
    expect(freshPort.events).not.toContain("save-before-image");
    expect(freshPort.receipts.size).toBe(0);
  });

  test.each([
    "before-image",
    "stage-count",
    "stage-hash",
    "replace-count",
    "replace-hash",
    "receipt",
  ] as const)("故障注入 %s 时 transaction rollback 且不留下 receipt", async (failAt) => {
    const plan = prepareMarkdownWorksetImport({ mode: "prepare", ...governedFixture() });
    const port = new FakeActivationPort();
    port.failAt = failAt;
    const importer = new MarkdownWorksetImporter(port, () => NOW);

    await expect(importer.activate(activationInput(plan))).rejects.toBeDefined();
    expect(port.events.at(-1)).toBe("rollback");
    expect(port.receipts.size).toBe(0);
  });
});

describe("Markdown workset rollback receipt", () => {
  async function activated(): Promise<{
    importer: MarkdownWorksetImporter;
    port: FakeActivationPort;
    receipt: MarkdownWorksetImportActivationReceipt;
  }> {
    const plan = prepareMarkdownWorksetImport({ mode: "prepare", ...governedFixture() });
    const port = new FakeActivationPort();
    const importer = new MarkdownWorksetImporter(port, () => NOW);
    const receipt = await importer.activate(activationInput(plan));
    port.current = receipt.afterSnapshot;
    port.events.length = 0;
    return { importer, port, receipt };
  }

  test("按 activation before-image 原子恢复并写可幂等重放的 rollback receipt", async () => {
    const { importer, port, receipt } = await activated();
    const input = {
      activationReceipt: receipt,
      maintenanceMode: true as const,
      quiescenceConfirmed: true as const,
      expectedCurrentSnapshotHash: receipt.afterSnapshot.snapshotHash,
      idempotencyKey: "rollback-workset-001",
      confirmationToken: markdownWorksetRollbackConfirmationToken({
        activationReceipt: receipt,
        expectedCurrentSnapshotHash: receipt.afterSnapshot.snapshotHash,
      }),
    };

    const rollbackReceipt = await importer.rollback(input);

    expect(rollbackReceipt.kind).toBe("rollback");
    expect(rollbackReceipt.activationReceiptHash).toBe(receipt.receiptHash);
    expect(rollbackReceipt.restoredSnapshot).toEqual(receipt.beforeSnapshot);
    expect(port.events).toEqual([
      `lock:${receipt.runId}`,
      "read-receipt:rollback",
      "begin",
      "read-current",
      "restore-before-image",
      "write-receipt",
      "commit",
    ]);

    port.events.length = 0;
    await expect(importer.rollback(input)).resolves.toEqual(rollbackReceipt);
    expect(port.events).toEqual([`lock:${receipt.runId}`, "read-receipt:rollback"]);
  });

  test("激活后 snapshot 漂移或 restore count/hash 不一致时 rollback fail closed", async () => {
    const first = await activated();
    first.port.current = { ...first.receipt.afterSnapshot, snapshotHash: HASH_C };
    const driftInput = {
      activationReceipt: first.receipt,
      maintenanceMode: true as const,
      quiescenceConfirmed: true as const,
      expectedCurrentSnapshotHash: first.receipt.afterSnapshot.snapshotHash,
      idempotencyKey: "rollback-workset-001",
      confirmationToken: markdownWorksetRollbackConfirmationToken({
        activationReceipt: first.receipt,
        expectedCurrentSnapshotHash: first.receipt.afterSnapshot.snapshotHash,
      }),
    };
    await expect(first.importer.rollback(driftInput))
      .rejects.toMatchObject({ code: "MARKDOWN_IMPORT_SNAPSHOT_DRIFT" });
    expect(first.port.events).not.toContain("restore-before-image");

    for (const failAt of ["restore-count", "restore-hash"] as const) {
      const next = await activated();
      next.port.failAt = failAt;
      const input = {
        ...driftInput,
        activationReceipt: next.receipt,
        expectedCurrentSnapshotHash: next.receipt.afterSnapshot.snapshotHash,
        confirmationToken: markdownWorksetRollbackConfirmationToken({
          activationReceipt: next.receipt,
          expectedCurrentSnapshotHash: next.receipt.afterSnapshot.snapshotHash,
        }),
      };
      await expect(next.importer.rollback(input)).rejects.toBeDefined();
      expect(next.port.events.at(-1)).toBe("rollback");
      expect([...next.port.receipts.values()].filter((item) => item.kind === "rollback")).toHaveLength(0);
    }
  });
});
