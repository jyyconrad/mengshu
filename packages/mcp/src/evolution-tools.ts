import {
  EVOLUTION_RUN_INPUT_SCHEMA, EVOLUTION_BATCH_INPUT_SCHEMA,
  invokeEvolutionCapability, type EvolutionBatchCapability,
} from "../../api/src/evolution.js";
import type { McpMemoryTool } from "./tools.js";
import { EVOLUTION_CONTROL_OPERATIONS, evolutionControlSchema, invokeEvolutionControl } from "../../api/src/evolution-review.js";
import { EVOLUTION_SOURCE_CONTROL_OPERATIONS, evolutionSourceControlSchema, invokeEvolutionSourceControl } from "../../api/src/evolution-source-control.js";
import { EVOLUTION_REUSE_OPERATIONS, evolutionReuseSchema, invokeEvolutionReuseControl } from "../../api/src/evolution-reuse-control.js";
import { EVOLUTION_GOVERNANCE_OPERATIONS, evolutionGovernanceSchema, invokeEvolutionGovernanceControl } from "../../api/src/evolution-control.js";
import { assertEvolutionOwnerRequest } from "../../api/src/evolution-owner-auth.js";
import type { AuthorityScope } from "../../core/src/domain/authority-scope.js";

export function buildEvolutionTools(capability: EvolutionBatchCapability, authority?: AuthorityScope): McpMemoryTool[] {
  const tools: McpMemoryTool[] = (["run", "status", "resume"] as const).map(operation => ({
    name: `memory_evolution_${operation}`,
    description: `${operation} a controlled host-bound memory evolution batch.`,
    inputSchema: operation === "run" ? EVOLUTION_RUN_INPUT_SCHEMA : EVOLUTION_BATCH_INPUT_SCHEMA,
    execute: args => invokeEvolutionCapability(capability, operation, args),
  }));
  for (const operation of EVOLUTION_CONTROL_OPERATIONS) {
    if (operation === "cancel" ? !capability.cancel : !capability.review) continue;
    if (operation === "review/list" && !capability.review?.list || operation === "review/detail" && !capability.review?.detail) continue;
    tools.push({ name: `memory_evolution_${operation.replaceAll("/", "_")}`,
      description: "Owner-authenticated control of an exact evolution review or cancellation.",
      inputSchema: evolutionControlSchema(operation), execute: args => invokeEvolutionControl(capability, operation, args),
    });
  }
  if (capability.sourceControl) for (const operation of EVOLUTION_SOURCE_CONTROL_OPERATIONS) {
    tools.push({ name: `memory_evolution_${operation.replaceAll("/", "_").replaceAll("-", "_")}`,
      description: operation === "source/attest" ? "Owner submits a trusted-issuer signed exact evidence statement." : "Owner revokes a source trust statement; does not purge source data.",
      inputSchema: evolutionSourceControlSchema(operation), execute: args => invokeEvolutionSourceControl(capability, operation, args) });
  }
  if (capability.reuse) for (const operation of EVOLUTION_REUSE_OPERATIONS) {
    tools.push({ name: `memory_evolution_${operation.replaceAll("/", "_")}`,
      description: "Owner controls same-owner reuse grants or runs a host-registered independent evaluation plan.",
      inputSchema: evolutionReuseSchema(operation), execute: args => invokeEvolutionReuseControl(capability, operation, args) });
  }
  if (capability.control && authority) {
    const owner = Object.freeze({ tenantId: authority.tenantId, userId: authority.userId });
    for (const operation of EVOLUTION_GOVERNANCE_OPERATIONS) {
      tools.push({ name: `memory_evolution_${operation.replaceAll("/", "_").replaceAll("-", "_")}`,
        description: "Owner-authenticated bounded source reconciliation, revocation or exact governance undo.",
        inputSchema: evolutionGovernanceSchema(operation), execute: async args => {
          assertEvolutionOwnerRequest(owner);
          return invokeEvolutionGovernanceControl(capability, operation, args);
        } });
    }
  }
  return tools;
}
