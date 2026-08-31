import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeCostEvent, RuntimeCostLedger } from "../../../core/src/cost/runtime-cost.js";
import { JsonlRuntimeCostLedger } from "../../../core/src/cost/runtime-cost-ledger.js";
import { resolveRuntimeCostLedgerPath } from "../../../core/src/runtime/paths.js";
import { runMengshuCli } from "./ms.js";
import { registerRuntimeCostCliCommands } from "./runtime-cost.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const rows: RuntimeCostEvent[] = [
  {
    version: 1,
    timestamp: "2026-08-15T12:00:00.000Z",
    operation: "llm.complete",
    category: "native_memory",
    provider: "openai",
    model: "gpt-test",
    inputTokens: 100,
    outputTokens: 20,
    embeddingUnits: null,
    embeddingUnitKind: null,
    pricingSnapshotVersion: "pricing-v1",
    estimatedMinorUnits: 0.03,
    currency: "USD",
    status: "succeeded",
    rejectionReason: null,
    attempt: 1,
    scopeFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    policyResolution: null,
  },
  {
    version: 1,
    timestamp: "2026-08-16T02:00:00.000Z",
    operation: "budget.reject",
    category: "asset_tool",
    provider: "openai",
    model: "gpt-test",
    inputTokens: 0,
    outputTokens: 0,
    embeddingUnits: null,
    embeddingUnitKind: null,
    pricingSnapshotVersion: "pricing-v1",
    estimatedMinorUnits: 0,
    currency: "USD",
    status: "rejected",
    rejectionReason: "daily_budget_exceeded",
    attempt: 1,
    scopeFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    policyResolution: null,
  },
];

function ledger(): RuntimeCostLedger {
  return { append: vi.fn(), query: vi.fn(async () => rows) };
}

describe("ms cost", () => {
  test("supports an exact local date and JSON output", async () => {
    const output: string[] = [];
    const program = new Command().exitOverride();
    registerRuntimeCostCliCommands(program, {
      ledger: ledger(),
      now: () => new Date("2026-08-16T12:00:00+08:00"),
      writeLine: (line) => output.push(line),
    });

    await program.parseAsync(["node", "ms", "cost", "--date", "2026-08-16", "--json"]);
    const report = JSON.parse(output.join("\n"));
    expect(report.window).toMatchObject({ kind: "date", value: "2026-08-16" });
    expect(report.totals).toMatchObject({ events: 1, rejected: 1 });
    expect(report.byCategory.asset_tool.events).toBe(1);
  });

  test("supports a rolling Nd window and rejects ambiguous selectors", async () => {
    const output: string[] = [];
    const program = new Command().exitOverride();
    registerRuntimeCostCliCommands(program, {
      ledger: ledger(),
      now: () => new Date("2026-08-16T12:00:00Z"),
      writeLine: (line) => output.push(line),
    });
    await program.parseAsync(["node", "ms", "cost", "--window", "2d"]);
    expect(output.join("\n")).toContain("native_memory");
    expect(output.join("\n")).toContain("asset_tool");

    const invalid = new Command().exitOverride();
    registerRuntimeCostCliCommands(invalid, { ledger: ledger() });
    await expect(invalid.parseAsync([
      "node", "ms", "cost", "--date", "2026-08-16", "--window", "2d",
    ])).rejects.toThrow(/cannot be used together/);
  });

  test("runMengshuCli reads cost without config or runtime startup", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "mengshu-cost-cli-"));
    tempDirs.push(homeDir);
    const previous = process.env.MENGSHU_HOME;
    process.env.MENGSHU_HOME = homeDir;
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
    try {
      const persistent = new JsonlRuntimeCostLedger(resolveRuntimeCostLedgerPath());
      await persistent.append(rows[1]);
      await runMengshuCli(["node", "ms", "cost", "--date", "2026-08-16", "--json"]);
      expect(JSON.parse(output.join("\n")).totals).toMatchObject({ events: 1, rejected: 1 });
    } finally {
      if (previous === undefined) delete process.env.MENGSHU_HOME;
      else process.env.MENGSHU_HOME = previous;
    }
  });
});
