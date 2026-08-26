import { createHash } from "node:crypto";

import {
  FIVE_QUESTIONS,
  type ContextFastResponse,
  type SlotAssembly,
  type SlotContextBlock,
} from "../domain/semantic-types.js";
import { requireRecallReceipt } from "../domain/recall-receipt-validation.js";
import type { MemorySemanticType } from "../domain/types.js";
import { packSlotsToPrompt } from "../context/slot-prompt-packer.js";
import type {
  AgentLoadout,
  LoadoutAssemblyResult,
  LoadoutContribution,
} from "./types.js";

const BODY_MODES = new Set(["must_read", "slot_summary"]);
const TOOL_MODES = new Set(["index_then_tool", "tool_only"]);

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function ensureSlot(
  slots: ContextFastResponse["slots"],
  semanticType: MemorySemanticType,
): SlotContextBlock {
  return slots[semanticType] ?? {
    semanticType,
    question: FIVE_QUESTIONS[semanticType],
    content: "",
    sourceIds: [],
    evidenceRefs: [],
    recallReceipts: [],
    nodeCount: 0,
    tokenEstimate: 0,
  };
}

function ensureAssembly(
  current: SlotAssembly | undefined,
  semanticType: MemorySemanticType,
  tokenBudget: number,
): SlotAssembly {
  return current ?? {
    semanticType,
    mustRead: [],
    navigation: [],
    assetRefs: [],
    evidenceRefs: [],
    filtered: [],
    tokenBudget,
  };
}

function appendBody(
  block: SlotContextBlock,
  contribution: LoadoutContribution,
): SlotContextBlock {
  if (!contribution.recallSource) throw new Error("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
  requireRecallReceipt({
    score: contribution.score,
    source: contribution.recallSource,
    scoreBreakdown: contribution.scoreBreakdown,
  }, "CONTEXT_RECALL_BREAKDOWN_REQUIRED");
  const sourceId = `asset:${contribution.assetId}@${contribution.assetVersion}`;
  const content = [block.content, `- ${contribution.content}`].filter(Boolean).join("\n");
  return {
    ...block,
    content,
    sourceIds: [...block.sourceIds, sourceId],
    evidenceRefs: unique([...(block.evidenceRefs ?? []), ...contribution.evidenceRefs]),
    recallReceipts: [
      ...(block.recallReceipts ?? []),
      {
        sourceId,
        score: contribution.score,
        source: contribution.recallSource,
        scoreBreakdown: contribution.scoreBreakdown,
      },
    ],
    nodeCount: block.nodeCount + 1,
    tokenEstimate: content.length,
  };
}

/** Merge an already-governed Loadout assembly back into the canonical five-slot response. */
export function applyLoadoutAssemblyToContext(
  response: ContextFastResponse,
  loadout: AgentLoadout | undefined,
  assembly: LoadoutAssemblyResult,
  task?: string,
): ContextFastResponse {
  if (!loadout || !assembly.enhancementEnabled) return response;
  if (!response.assemblyPlan || !assembly.receipt ||
      assembly.receipt.loadoutId !== loadout.id ||
      assembly.receipt.loadoutVersion !== loadout.version) {
    throw new Error("LOADOUT_ASSEMBLY_RECEIPT_REQUIRED");
  }

  const result = clone(response);
  const plan = result.assemblyPlan!;
  let injected = 0;
  for (const contribution of assembly.contributions) {
    const slot = contribution.slot;
    const currentAssembly = ensureAssembly(
      plan.slots[slot],
      slot,
      loadout.nativeMemoryPolicy.tokenBudgets[slot],
    );
    const assetRef = { assetId: contribution.assetId, version: contribution.assetVersion };
    currentAssembly.assetRefs = [...currentAssembly.assetRefs, assetRef];
    currentAssembly.evidenceRefs = unique([
      ...currentAssembly.evidenceRefs,
      ...contribution.evidenceRefs,
    ]);

    if (BODY_MODES.has(contribution.disclosureMode)) {
      const block = appendBody(ensureSlot(result.slots, slot), contribution);
      result.slots[slot] = block;
      currentAssembly.mustRead = [
        ...currentAssembly.mustRead,
        {
          ref: contribution.assetId,
          semanticType: slot,
          content: contribution.content,
          evidenceRefs: [...contribution.evidenceRefs],
        },
      ];
      injected += 1;
    } else {
      currentAssembly.navigation = [
        ...currentAssembly.navigation,
        {
          ref: contribution.assetId,
          kind: "asset",
          level: contribution.disclosureMode === "navigation" ? "R2" : "R3",
          semanticType: slot,
        },
      ];
    }
    plan.slots[slot] = currentAssembly;
  }

  for (const item of assembly.degraded) {
    const currentAssembly = ensureAssembly(
      plan.slots[item.slot],
      item.slot,
      loadout.nativeMemoryPolicy.tokenBudgets[item.slot],
    );
    currentAssembly.filtered = [
      ...currentAssembly.filtered,
      { ref: item.assetId, reason: item.reason },
    ];
    plan.slots[item.slot] = currentAssembly;
  }

  plan.denied = [
    ...plan.denied,
    ...assembly.denied.map((item) => ({ ref: item.assetId, reason: item.reason })),
  ];
  if (assembly.degraded.length > 0) {
    result.warnings = unique([
      ...(result.warnings ?? []),
      ...assembly.degraded.map((item) =>
        `budget_exceeded: asset ${item.assetId} downgraded to navigation`),
    ]);
  }
  const hasToolAssets = assembly.contributions.some((item) =>
    TOOL_MODES.has(item.disclosureMode));
  const toolNames = new Set(plan.tools.map((tool) => tool.name));
  for (const tool of [
    { name: "memory_asset_list", description: "List discoverable governed memory assets" },
    ...(hasToolAssets
      ? [{ name: "memory_asset_read", description: "Read an authorized governed memory asset" }]
      : []),
    { name: "memory_asset_explain", description: "Explain an asset version and its evidence" },
  ]) {
    if (!toolNames.has(tool.name)) plan.tools.push(tool);
  }

  const assetVersions = [...assembly.receipt.assetVersions]
    .sort((left, right) => left.assetId.localeCompare(right.assetId) || left.version - right.version);
  plan.versions.loadout = loadout.version;
  plan.versions.assetVersionSetHash = hash(assetVersions);
  plan.stableContentHash = hash({
    native: response.assemblyPlan.stableContentHash,
    loadout: loadout.version,
    assets: assetVersions,
    profile: plan.slots.profile,
    rules: plan.slots.rules,
  });
  plan.dynamicContentHash = hash({
    native: response.assemblyPlan.dynamicContentHash,
    loadout: loadout.version,
    assets: assetVersions,
    task_context: plan.slots.task_context,
    experience: plan.slots.experience,
    resource: plan.slots.resource,
  });
  result.content = packSlotsToPrompt(result.slots, task);
  result.telemetry.nodesUsed += injected;
  result.telemetry.tokenEstimate = result.content.length;
  return result;
}
