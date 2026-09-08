import type { CompleteRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { MemoryScope } from "../domain/types.js";
import { sameExactReuseScope } from "../evolution/reuse/explicit-reuse-authorizer.js";
import type { SkillReadResult } from "../skills/types.js";
import type { LoadoutAssetCandidate } from "./types.js";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 将已审核 Skill 的只读结果投影为 Loadout 候选。排序分数必须来自既有 governed
 * recall/search 链路；本函数不引入第五套“Skill score”。
 */
export function resolveSkillLoadoutCandidate(input: {
  readonly read: SkillReadResult;
  readonly scope: MemoryScope;
  readonly score: number;
  readonly scoreBreakdown: CompleteRecallScoreBreakdown;
  readonly tokenEstimate: number;
}): LoadoutAssetCandidate {
  const artifact = input.read.artifact;
  const content = [
    `# ${artifact.title}`,
    artifact.description,
    artifact.applicability === undefined ? "" : `适用范围: ${artifact.applicability}`,
  ].filter(Boolean).join("\n\n");
  return freeze({
    assetId: artifact.skillId,
    assetVersion: artifact.version,
    assetKind: "skill" as const,
    status: artifact.status,
    contentValidity: input.read.validity === "valid" ? "current" as const : "stale" as const,
    scope: artifact.scope,
    semanticTypes: ["experience", "resource"] as const,
    recordId: artifact.skillId,
    content,
    evidenceRefs: [...artifact.evidenceChunkIds],
    lifecycleEligible: artifact.status === "published" && input.read.validity === "valid" &&
      artifact.executionMode === "suggest_only" && sameExactReuseScope(artifact.scope, input.scope),
    riskBlocked: artifact.riskBoundaries.some((boundary) =>
      /(?:不可逆|付费|删除|credential|secret|payment|delete)/i.test(boundary)),
    conflictUnresolved: false,
    score: input.score,
    scoreBreakdown: input.scoreBreakdown,
    recallSource: "text" as const,
    tokenEstimate: input.tokenEstimate,
  });
}
