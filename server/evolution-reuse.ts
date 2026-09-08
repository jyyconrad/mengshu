import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolveAuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import type { MemoryKind } from "../packages/core/src/domain/types.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { validateExplicitReuseGrant, sameExactReuseScope } from "../packages/core/src/evolution/reuse/explicit-reuse-authorizer.js";
import { fingerprintTargetProfile } from "../packages/core/src/evolution/reuse/target-compatibility.js";
import type { SkillPairedValidationResult } from "../packages/core/src/evolution/reuse/skill-paired-validator.js";
import type { SkillArtifactRepository } from "../packages/core/src/skills/repository.js";
import type { PostgresEvolutionPool } from "../packages/core/src/evolution/postgres-common.js";
import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { assertEvolutionOwnerRequest } from "../packages/api/src/evolution-owner-auth.js";
import { EvolutionTransportError } from "../packages/api/src/evolution.js";
import { parseEvolutionReuseGrants, type EvolutionReuseControlCapability, type EvolutionReuseGrantsRequest } from "../packages/api/src/evolution-reuse-control.js";
import { createPostgresEvolutionHostState } from "./evolution-host-state.js";
import type { EvolutionHostControl } from "./evolution-control.js";
import type { GlobalEvolutionConfig } from "./evolution-config.js";
import { createHostSkillPairedEvaluator, createHostSkillPairedValidator, createLlmReuseEvaluationModel,
  createHostSkillDraftGate, type HostSkillPairedEvaluationPlan, type SyntheticReuseHoldout } from "./reuse-evaluator.js";
import { hostStateEntryLive, type createHostReuseRuntimeRouter } from "./reuse-runtime.js";

/** The locator and expected digest are frozen operator configuration, never request arguments. */
export async function readPinnedEvolutionJson(path: string, hash: string, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_000_000 || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("evaluation_file_invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("evaluation_file_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    signal.throwIfAborted();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        createHash("sha256").update(bytes.subarray(0, offset)).digest("hex") !== hash) throw new Error("evaluation_file_changed");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally { await file.close(); }
}

/** No evaluation runs during composition. Registration locates input, it never establishes a behavioral proof. */
export function createEvolutionReuseRuntime(input: {
  control: EvolutionHostControl; config: GlobalEvolutionConfig; pool: PostgresEvolutionPool;
  repository: SkillArtifactRepository; llmClient: LlmClient; router: ReturnType<typeof createHostReuseRuntimeRouter>;
}) {
  const { state } = input.control, { authority, scope } = state;
  const blocked = (reason: string): SkillPairedValidationResult => ({ status: "blocked", reason, publishAllowed: false, executionAllowed: false });
  const capability: EvolutionReuseControlCapability = Object.freeze({
    status: async () => {
      assertEvolutionOwnerRequest(authority);
      const profile = await input.control.readTarget(scope), grants = await state.read({ kind: "reuse_grants", id: "grants" });
      const value = hostStateEntryLive(grants, Date.now()) ? grants.value as { grants?: { id: string }[] } : undefined;
      return { ...(profile ? { targetFingerprint: fingerprintTargetProfile(profile) } : {}), grantsRevision: grants?.revision ?? 0,
        grantIds: (value?.grants ?? []).map(grant => grant.id) };
    },
    replaceGrants: async (raw: EvolutionReuseGrantsRequest, signal?: AbortSignal) => {
      assertEvolutionOwnerRequest(authority);
      const request = parseEvolutionReuseGrants(raw);
      if (new Set(request.grants.map(grant => grant.id)).size !== request.grants.length) throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
      let grants;
      try {
        grants = request.grants.map(grant => validateExplicitReuseGrant({ id: grant.id,
          sourceScope: resolveAuthorityScope(authority, grant.source), targetScope: scope,
          claimKinds: grant.claimKinds as MemoryKind[], notBefore: grant.notBefore, expiresAt: grant.expiresAt,
        }, authority));
      } catch { throw new EvolutionTransportError(400, "EVOLUTION_REUSE_GRANT_INVALID"); }
      const receipt = await state.put({ kind: "reuse_grants", id: "grants", expectedRevision: request.expectedRevision,
        idempotencyKey: request.idempotencyKey, value: { grants: JSON.parse(JSON.stringify(grants)) } }, signal);
      return { receiptId: receipt.id, revision: receipt.revision, valueHash: receipt.valueHash };
    },
    evaluate: async (request: { planId: string }, signal = new AbortController().signal) => {
      assertEvolutionOwnerRequest(authority);
      if (!request || Object.keys(request).length !== 1 || typeof request.planId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.planId)) throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
      const binding = input.config.config.evolution?.reuse?.evaluations?.find(item => item.id === request.planId);
      if (!binding) return blocked("evaluation_not_registered");
      if (!input.llmClient.available) return blocked("evaluation_model_unavailable");
      try {
        const plan = await readPinnedEvolutionJson(binding.planFile, binding.planFileHash, 128_000, signal) as HostSkillPairedEvaluationPlan;
        const source = plan.sourceScope;
        if (plan.id !== request.planId || !sameExactReuseScope(plan.targetScope, scope) ||
            !sameExactReuseScope(resolveAuthorityScope(authority, { appId: source.appId, projectId: source.projectId,
              agentId: source.agentId, namespace: source.namespace, visibility: source.visibility }), source)) return blocked("evaluation_scope_mismatch");
        const current = await input.control.readTarget(scope), llm = input.config.config.llm;
        if (!llm || !current || current.model.provider !== (llm.provider ?? "openai") ||
            current.model.modelId !== (llm.reasoningModel ?? llm.model) ||
            fingerprintTargetProfile(plan.target) !== fingerprintTargetProfile(current)) return blocked("evaluation_target_model_mismatch");
        if (!plan.budget || plan.budget.costUnit !== "milliseconds" || plan.budget.maximumPairs > 500 ||
            plan.budget.maximumArmDurationMs > 30_000 || plan.budget.maximumCostPerArm > 30_000) return blocked("evaluation_budget_invalid");
        const sourceState = createPostgresEvolutionHostState({ pool: input.pool, authority, scope: plan.sourceScope,
          authorizeOwner: () => ({ ...assertEvolutionOwnerRequest(authority), actorId: "runtime-host-owner", authentication: "authenticated_owner" }) });
        const evaluator = createHostSkillPairedEvaluator({ state: sourceState, repository: input.repository,
          readTarget: input.control.readTarget,
          model: createLlmReuseEvaluationModel({ client: { available: input.llmClient.available,
            complete: (messages, options) => input.llmClient.complete(messages, { ...options,
              costContext: { category: "operator", operation: "memory_evolution.evaluate", scopeFingerprint: authorityScopeFingerprint(scope) } }),
          }, readTarget: input.control.readTarget, modelType: "reasoning" }),
          holdoutTasks: { read: async request => {
            if (request.holdoutRef !== plan.holdoutRef || authorityScopeFingerprint(request.sourceScope) !== authorityScopeFingerprint(plan.sourceScope)) return undefined;
            return await readPinnedEvolutionJson(binding.holdoutFile, binding.holdoutFileHash, 2_000_000, request.signal) as SyntheticReuseHoldout;
          } },
        });
        return await createHostSkillPairedValidator({ state, evaluator, repository: input.repository,
          readTarget: input.control.readTarget, reuseAuthorizer: input.router.forScope(scope).authorizer,
        }).validate(plan, signal);
      } catch { return blocked(signal.aborted ? "evaluation_cancelled" : "evaluation_input_or_proof_unavailable"); }
    },
  });
  return Object.freeze({ capability, skillDraftGate: createHostSkillDraftGate({ state, readTarget: input.control.readTarget }) });
}
