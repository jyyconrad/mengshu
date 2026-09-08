import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { RuntimeClient } from "../runtime-client.js";
import { parseEvolutionProposalList, parseEvolutionReviewDecision } from "../../../core/src/evolution/schema.js";
import { parseRuntimeBackgroundWorkUpdate } from "../../../core/src/runtime/background-work.js";
import { parseEvolutionSourceControl } from "../evolution-source-control.js";
import { parseEvolutionReuseGrants } from "../evolution-reuse-control.js";
import { parseEvolutionGovernanceRequest } from "../evolution-control.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LIMITS = [
  ["maxRecords", "max-records", 100],
  ["maxFiles", "max-files", 20],
  ["maxBytes", "max-bytes", 10_000_000],
  ["maxLlmCalls", "max-llm-calls", 10],
  ["maxInputTokens", "max-input-tokens", 40_000],
  ["maxOutputTokens", "max-output-tokens", 8_000],
  ["maxDurationMs", "max-duration-ms", 300_000],
] as const;

function identifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error("Evolution identifier is invalid");
  }
  return value;
}

export function registerEvolutionCliCommands(program: Command, options: {
  readonly client: Pick<RuntimeClient, "invoke">;
  readonly output?: (value: unknown) => void;
}): void {
  const output = options.output ?? ((value: unknown) => console.log(JSON.stringify(value, null, 2)));
  const evolve = program.command("evolve").description("Run controlled memory evolution on RuntimeHost");
  for (const [command, operation] of [["control", "control/run"], ["undo-approve", "control/undo-approve"]] as const) {
    evolve.command(command).allowExcessArguments(false).requiredOption("--request <json>", "Exact owner governance request")
      .action(async (flags: { request: string }) => {
        if (Buffer.byteLength(flags.request) > (operation === "control/run" ? 16_384 : 4096)) throw new Error("Evolution control request is too large");
        const body = parseEvolutionGovernanceRequest(operation, JSON.parse(flags.request));
        output(await options.client.invoke({ method: "POST", path: `/v1/evolution/${operation}`, body }));
      });
  }
  evolve.command("undo-preview <receipt-id>").allowExcessArguments(false).action(async (operationReceiptId: string) => {
    const body = parseEvolutionGovernanceRequest("control/undo-preview", { operationReceiptId });
    output(await options.client.invoke({ method: "POST", path: "/v1/evolution/control/undo-preview", body }));
  });
  for (const [command, operation] of [["source-attest", "source/attest"], ["source-revoke-attestation", "source/revoke-attestation"],
    ["reuse-grants", "reuse/grants"]] as const) {
    evolve.command(command).allowExcessArguments(false).requiredOption("--request <json>", "Exact signed source or owner grant request")
      .action(async (flags: { request: string }) => {
        if (Buffer.byteLength(flags.request) > 16_384) throw new Error("Evolution control request is too large");
        const value: unknown = JSON.parse(flags.request);
        const body = operation === "reuse/grants" ? parseEvolutionReuseGrants(value) : parseEvolutionSourceControl(operation, value);
        output(await options.client.invoke({ method: "POST", path: `/v1/evolution/${operation}`, body }));
      });
  }
  evolve.command("reuse-status").allowExcessArguments(false).action(async () =>
    output(await options.client.invoke({ method: "POST", path: "/v1/evolution/reuse/status", body: {} })));
  evolve.command("maintenance").allowExcessArguments(false).action(async () =>
    output(await options.client.invoke({ method: "GET", path: "/v1/runtime/maintenance" })));
  evolve.command("reuse-evaluate <plan-id>").allowExcessArguments(false).action(async (planId: string) =>
    output(await options.client.invoke({ method: "POST", path: "/v1/evolution/reuse/evaluate", body: { planId: identifier(planId) } })));
  evolve.command("proposals").allowExcessArguments(false)
    .description("List bounded proposals for owner review")
    .option("--batch-id <id>", "Exact batch identifier")
    .option("--status <status>", "staged, rejected, review, applied, or noop")
    .option("--limit <count>", "At most 50 proposals")
    .option("--cursor <cursor>", "Opaque next-page cursor returned by the host")
    .action(async (flags: Record<string, unknown>) => {
      const body = parseEvolutionProposalList({ ...flags,
        ...(flags.limit === undefined ? {} : { limit: typeof flags.limit === "string" && /^\d+$/.test(flags.limit) ? Number(flags.limit) : NaN }),
      });
      output(await options.client.invoke({ method: "POST", path: "/v1/evolution/review/list", body }));
    });
  evolve.command("background").allowExcessArguments(false)
    .description("Inspect or explicitly change the host background maintenance gate")
    .option("--mode <mode>", "all, paused, or evolution_only")
    .option("--expected-revision <revision>", "Current host background revision")
    .option("--batch-id <id>", "Allow exactly this evolution batch (repeatable)", (id: string, prior: string[]) => [...prior, id], [])
    .action(async (flags: { mode?: string; expectedRevision?: string; batchId: string[] }) => {
      if (flags.mode === undefined && flags.expectedRevision === undefined && flags.batchId.length === 0) {
        output(await options.client.invoke({ method: "GET", path: "/v1/runtime/background" }));
        return;
      }
      const body = parseRuntimeBackgroundWorkUpdate({ mode: flags.mode, expectedRevision: flags.expectedRevision, allowedBatchIds: flags.batchId });
      output(await options.client.invoke({ method: "POST", path: "/v1/runtime/background", body }));
    });
  const run = async (input: Record<string, string>, flags: Record<string, unknown>) => {
    if ([flags.dryRun, flags.propose, flags.applyAllowed].filter(Boolean).length > 1) {
      throw new Error("Evolution action flags are mutually exclusive");
    }
    const limits: Record<string, number> = {};
    for (const [field, , maximum] of LIMITS) {
      if (flags[field] === undefined) continue;
      const raw = flags[field];
      const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`Evolution ${field} must be an integer from 1 to ${maximum}`);
      }
      limits[field] = value;
    }
    const idempotencyKey = identifier(flags.idempotencyKey ?? randomUUID());
    output(await options.client.invoke({ method: "POST", path: "/v1/evolution/run", body: {
      input,
      action: flags.applyAllowed ? "apply_allowed" : flags.propose ? "propose" : "preview",
      idempotencyKey,
      ...(Object.keys(limits).length ? { limits } : {}),
    } }));
  };
  const actions = (command: Command) => {
    command.allowExcessArguments(false)
      .option("--dry-run", "Preview without model calls or canonical writes")
      .option("--propose", "Prepare isolated proposals")
      .option("--apply-allowed", "Apply only governed allowed operations")
      .option("--idempotency-key <key>", "Stable request retry key");
    for (const [, flag, maximum] of LIMITS) {
      command.option(`--${flag} <count>`, `Batch limit (maximum ${maximum})`);
    }
    return command;
  };
  actions(evolve.command("inventory").description("Process host-bound inventory"))
    .option("--selection <selection>", "baseline; changed/due require provider watermarks", "baseline")
    .action(async (flags: Record<string, unknown>) => {
      if (!["changed", "due", "baseline"].includes(flags.selection as string)) {
        throw new Error("Evolution selection is invalid");
      }
      await run({ mode: "inventory", selection: flags.selection as string }, flags);
    });
  actions(evolve.command("scan").description("Process a host-registered directory source"))
    .requiredOption("--source-id <id>", "Host-registered source identifier")
    .action(async (flags: Record<string, unknown>) => {
      const sourceId = identifier(flags.sourceId);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sourceId)) throw new Error("Evolution sourceId is invalid");
      await run({ mode: "directory", sourceId }, flags);
    });
  for (const operation of ["status", "resume", "cancel"] as const) {
    evolve.command(`${operation} <batch-id>`).allowExcessArguments(false)
      .description(`${operation === "status" ? "Inspect" : "Resume"} a host-bound batch`)
      .action(async (batchId: string) => {
        output(await options.client.invoke({
          method: "POST", path: `/v1/evolution/${operation}`, body: { batchId: identifier(batchId) },
        }));
      });
  }
  for (const [command, path, field] of [
    ["proposal", "review/detail", "proposalId"], ["review", "review/preview", "proposalId"], ["review-status", "review/status", "reviewId"],
    ["apply", "review/apply", "approvalReceiptId"],
  ] as const) {
    evolve.command(`${command} <id>`).allowExcessArguments(false)
      .description(`${command} an exact owner-reviewed evolution change`)
      .action(async (id: string) => output(await options.client.invoke({
        method: "POST", path: `/v1/evolution/${path}`, body: { [field]: identifier(id) },
      })));
  }
  for (const decision of ["approve", "reject"] as const) {
    evolve.command(`${decision} <review-id>`).allowExcessArguments(false)
      .requiredOption("--binding-hash <hash>", "Exact hash returned by owner review")
      .requiredOption("--idempotency-key <key>", "Stable decision retry key")
      .option("--reason <reason>", "Bounded operator decision reason")
      .action(async (reviewId: string, flags: Record<string, unknown>) => {
        const body = parseEvolutionReviewDecision({ reviewId: identifier(reviewId), expectedBindingHash: flags.bindingHash,
          decision, idempotencyKey: identifier(flags.idempotencyKey), ...(flags.reason === undefined ? {} : { reason: flags.reason }) });
        output(await options.client.invoke({ method: "POST", path: "/v1/evolution/review/decide", body }));
      });
  }
}
