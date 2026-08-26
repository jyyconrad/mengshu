import type { Command } from "commander";
import {
  RUNTIME_COST_CATEGORIES,
  aggregateRuntimeCost,
  type RuntimeCostEvent,
  type RuntimeCostLedger,
} from "../../../core/src/cost/runtime-cost.js";

export interface RegisterRuntimeCostCliOptions {
  ledger: RuntimeCostLedger;
  now?: () => Date;
  writeLine?: (line: string) => void;
}

interface RuntimeCostCliFlags {
  date?: string;
  window?: string;
  json?: boolean;
}

interface CostWindow {
  kind: "date" | "rolling";
  value: string;
  from: Date;
  to: Date;
}

function exactLocalDate(value: string): { from: Date; to: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("--date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const from = new Date(year, month - 1, day);
  if (from.getFullYear() !== year || from.getMonth() !== month - 1 || from.getDate() !== day) {
    throw new Error("--date is not a valid calendar date");
  }
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

function resolveWindow(flags: RuntimeCostCliFlags, now: Date): CostWindow {
  if (flags.date && flags.window) {
    throw new Error("--date and --window cannot be used together");
  }
  if (flags.date) {
    const { from, to } = exactLocalDate(flags.date);
    return { kind: "date", value: flags.date, from, to };
  }
  if (flags.window) {
    const match = /^(\d+)d$/.exec(flags.window);
    const days = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("--window must be Nd where N is between 1 and 3650");
    }
    return {
      kind: "rolling",
      value: flags.window,
      from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
      to: now,
    };
  }
  const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const { from, to } = exactLocalDate(local);
  return { kind: "date", value: local, from, to };
}

function inWindow(event: RuntimeCostEvent, window: CostWindow): boolean {
  const timestamp = Date.parse(event.timestamp);
  return timestamp >= window.from.getTime() && timestamp < window.to.getTime();
}

function formatTextReport(
  window: CostWindow,
  aggregate: ReturnType<typeof aggregateRuntimeCost>,
): string {
  const lines = [
    `mengshu 成本报告  ${window.kind === "date" ? "日期" : "窗口"}: ${window.value}`,
    `事件: ${aggregate.totals.events}  provider attempts: ${aggregate.totals.providerAttempts}  retries: ${aggregate.totals.retries}  rejected: ${aggregate.totals.rejected}`,
    `tokens: input=${aggregate.totals.inputTokens} output=${aggregate.totals.outputTokens} embedding=${aggregate.totals.embeddingUnits}`,
    `estimated minor units: ${aggregate.totals.estimatedMinorUnits}  unpriced events: ${aggregate.totals.unpricedEvents}`,
    "",
    "category          events  attempts  failed  rejected  estimated_minor_units",
  ];
  for (const category of RUNTIME_COST_CATEGORIES) {
    const row = aggregate.byCategory[category];
    if (row.events === 0) continue;
    lines.push(
      `${category.padEnd(17)} ${String(row.events).padStart(6)} ${String(row.providerAttempts).padStart(9)} ${String(row.failed).padStart(7)} ${String(row.rejected).padStart(9)} ${String(row.estimatedMinorUnits).padStart(21)}`,
    );
  }
  if (aggregate.totals.unpricedEvents > 0) {
    lines.push("warning: some events are unpriced; estimates are local snapshots, not provider bills");
  }
  return lines.join("\n");
}

export function registerRuntimeCostCliCommands(
  program: Command,
  options: RegisterRuntimeCostCliOptions,
): void {
  program
    .command("cost")
    .description("Show the local append-only runtime cost ledger")
    .option("--date <YYYY-MM-DD>", "Exact local calendar date")
    .option("--window <Nd>", "Rolling N-day window")
    .option("--json", "Machine-readable JSON output", false)
    .action(async (flags: RuntimeCostCliFlags) => {
      const now = options.now?.() ?? new Date();
      const window = resolveWindow(flags, now);
      const events = (await options.ledger.query()).filter((event) => inWindow(event, window));
      const aggregate = aggregateRuntimeCost(events);
      const report = {
        window: {
          kind: window.kind,
          value: window.value,
          from: window.from.toISOString(),
          to: window.to.toISOString(),
        },
        ...aggregate,
        estimateNotice: "Local pricing snapshot estimate only; not a provider bill",
      };
      const write = options.writeLine ?? console.log;
      write(flags.json ? JSON.stringify(report, null, 2) : formatTextReport(window, aggregate));
    });
}
