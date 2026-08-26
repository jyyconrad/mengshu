import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { ScopeLevel } from "./candidate-validator.js";

export interface CandidateTreeRoutingInput {
  readonly scope: MemoryScope;
  readonly semanticType: MemorySemanticType;
  readonly targetScope: ScopeLevel;
  readonly riskFlags: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly explicit: boolean;
}

export interface CandidateTreeRoutingEnvelope {
  readonly version: 1;
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly scopeVisibility: ScopeLevel;
  readonly riskFlags: readonly string[];
  readonly topicLabels: readonly string[];
  readonly topicHotnessEligible: false;
  readonly explicitGlobal: boolean;
  readonly isWorkspaceRule: boolean;
}

/** 把 validator 裁决投影为 D-03/D-21 tree routing，不读取调用方自由 metadata。 */
export function candidateTreeRoutingEnvelope(
  input: CandidateTreeRoutingInput,
): CandidateTreeRoutingEnvelope | undefined {
  const evidenceId = input.evidenceIds[0];
  if (evidenceId === undefined) return undefined;
  const sourceId = input.scope.sessionId ?? evidenceId;
  return Object.freeze({
    version: 1 as const,
    evidenceId,
    sourceId,
    entityIds: Object.freeze([] as string[]),
    scopeVisibility: input.targetScope,
    riskFlags: Object.freeze([...input.riskFlags]),
    topicLabels: Object.freeze([] as string[]),
    topicHotnessEligible: false as const,
    explicitGlobal: input.explicit && input.targetScope === "global",
    isWorkspaceRule: input.semanticType === "rules" && input.targetScope === "workspace",
  });
}
