import { createHash } from "node:crypto";

import { packSlotsToPrompt } from "../context/slot-prompt-packer.js";
import { FIVE_QUESTIONS, type ContextFastResponse } from "../domain/semantic-types.js";
import type {
  KnowledgeResourceIndexItem,
  KnowledgeResourceIndexResult,
  KnowledgeResourceWarning,
} from "./knowledge-resource-types.js";

const SEARCH_TOOL = Object.freeze({
  name: "memory_knowledge_search",
  description: "Search authorized Knowledge resources in exact scope",
});
const READ_TOOL = Object.freeze({
  name: "memory_knowledge_read",
  description: "Read one authorized revision-pinned Knowledge resource",
});

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function evidenceRef(resource: KnowledgeResourceIndexItem): string {
  return `knowledge:${resource.ref}@${resource.revision}`;
}

function indexLine(resource: KnowledgeResourceIndexItem): string {
  const source = resource.sourceRef
    ? ` (${resource.sourceRef.kind}: ${resource.sourceRef.ref})`
    : "";
  return `- [knowledge:${resource.ref}@${resource.revision}] ${resource.title}${source}`;
}

/**
 * Add a bounded Knowledge index to the resource slot without claiming a recall hit.
 * Full content remains available only through the revision-pinned read/search capability.
 */
export function applyKnowledgeResourceIndexToContext(
  response: ContextFastResponse,
  index: KnowledgeResourceIndexResult,
  task?: string,
): ContextFastResponse {
  if (index.resources.length === 0 && index.warnings.length === 0) return response;
  const result = structuredClone(response);
  result.warnings = unique([...(result.warnings ?? []), ...index.warnings]);
  if (index.resources.length === 0) return result;
  if (!result.assemblyPlan) {
    result.warnings = unique([...result.warnings, "knowledge_resource_unavailable"]);
    return result;
  }

  const plan = result.assemblyPlan;
  const nativeDynamicContentHash = plan.dynamicContentHash;
  const currentSlot = result.slots.resource ?? {
    semanticType: "resource" as const,
    question: FIVE_QUESTIONS.resource,
    content: "",
    sourceIds: [],
    evidenceRefs: [],
    recallReceipts: [],
    nodeCount: 0,
    tokenEstimate: 0,
  };
  const currentAssembly = plan.slots.resource ?? {
    semanticType: "resource" as const,
    mustRead: [],
    navigation: [],
    assetRefs: [],
    evidenceRefs: [],
    filtered: [],
    tokenBudget: 0,
  };
  const refs = index.resources.map(evidenceRef);
  currentAssembly.navigation = [
    ...currentAssembly.navigation,
    ...index.resources.map((resource) => ({
      ref: resource.ref,
      kind: "knowledge" as const,
      level: "R2" as const,
      semanticType: "resource" as const,
      revision: resource.revision,
      title: resource.title,
      evidenceRefs: [evidenceRef(resource)],
    })),
  ];
  currentAssembly.evidenceRefs = unique([...currentAssembly.evidenceRefs, ...refs]);

  const used = currentSlot.tokenEstimate ?? currentSlot.content.length;
  let remaining = Math.max(0, currentAssembly.tokenBudget - used);
  const includedLines: string[] = [];
  const includedRefs: string[] = [];
  let budgetExceeded = false;
  for (const resource of index.resources) {
    const line = indexLine(resource);
    const cost = line.length + (currentSlot.content || includedLines.length > 0 ? 1 : 0);
    if (cost > remaining) {
      budgetExceeded = true;
      currentAssembly.filtered = [
        ...currentAssembly.filtered,
        { ref: resource.ref, reason: "budget_exceeded" },
      ];
      continue;
    }
    includedLines.push(line);
    includedRefs.push(evidenceRef(resource));
    remaining -= cost;
  }
  if (includedLines.length > 0) {
    currentSlot.content = [currentSlot.content, ...includedLines].filter(Boolean).join("\n");
    currentSlot.tokenEstimate = currentSlot.content.length;
    currentSlot.evidenceRefs = unique([...(currentSlot.evidenceRefs ?? []), ...includedRefs]);
  }
  if (budgetExceeded) {
    result.warnings = unique([
      ...result.warnings,
      "knowledge_resource_budget_exceeded" satisfies KnowledgeResourceWarning,
    ]);
  }
  result.slots.resource = currentSlot;
  plan.slots.resource = currentAssembly;

  const toolNames = new Set(plan.tools.map((tool) => tool.name));
  for (const tool of [SEARCH_TOOL, READ_TOOL]) {
    if (!toolNames.has(tool.name)) plan.tools.push({ ...tool });
  }
  plan.dynamicContentHash = digest({
    native: nativeDynamicContentHash,
    knowledge: index.resources.map((resource) => ({
      ref: resource.ref,
      revision: resource.revision,
    })),
    displayed: includedLines,
  });
  result.content = packSlotsToPrompt(result.slots, task);
  result.telemetry.tokenEstimate = result.content.length;
  return result;
}
