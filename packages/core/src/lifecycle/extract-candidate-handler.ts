/**
 * legacy extract_candidate job handler。
 *
 * 候选抽取、validator 与 admission 已收敛到 candidate-spec-computation.ts；本文件
 * 只保留旧 JobHandler 适配和候选区/audit 持久化，以便后续 native fenced handler
 * 在不复用 legacy 写路径的前提下消费同一个纯计算边界。
 */

import type { CandidateRepository } from "./candidate-types.js";
import type { TypeExtractor } from "./type-extractor.js";
import type { MemoryScope } from "../domain/types.js";
import { inferProfileLayer } from "../domain/profile-layer.js";
import type { JobRecord } from "../storage/repositories/types.js";
import type { JobHandler } from "../runtime/jobs.js";
import type { LlmClient } from "../runtime/llm/llm-client.js";
import { types as nodeUtilTypes } from "node:util";
import {
  computeCandidateSpecs,
  type CandidateComputationDeps,
  type ComputedCandidateSpec,
} from "./candidate-spec-computation.js";
import type { AuthoritativeCandidateEvidenceFact } from
  "./candidate-confidence-deriver.js";

export interface ExtractCandidateHandlerDeps {
  extractor: TypeExtractor;
  candidates: CandidateRepository;
  llmClient?: LlmClient;
  /** Legacy adapter 可选接入；缺失时 valueScore receipt 明确标 legacy_unknown。 */
  resolveMaxSimilarity?: CandidateComputationDeps["resolveMaxSimilarity"];
  /** Legacy adapters must explicitly prove persisted evidence; absence stays fail-closed. */
  readEvidenceFacts?(input: {
    scope: MemoryScope;
    evidenceIds: readonly string[];
  }): Promise<readonly AuthoritativeCandidateEvidenceFact[]>;
  audit?(input: {
    scope: MemoryScope;
    action: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

interface ExtractPayload {
  scope?: MemoryScope;
  text?: string;
  traceId?: string;
  intent?: string;
}

function readPayload(job: JobRecord): ExtractPayload {
  const payload = job.payload as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      nodeUtilTypes.isProxy(payload)) {
    throw new Error("extract_candidate payload must be an exact own-data record");
  }
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("extract_candidate payload must be an exact own-data record");
  }
  const allowed = new Set(["scope", "text", "traceId", "intent"]);
  const keys = Reflect.ownKeys(payload);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new Error("extract_candidate payload must be an exact own-data record");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    // 每个字段的 descriptor 恰好读取一次；accessor 从不执行。
    const descriptor = Object.getOwnPropertyDescriptor(payload, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("extract_candidate payload must be an exact own-data record");
    }
    snapshot[key] = descriptor.value;
  }
  const scope = snapshot.scope;
  const text = snapshot.text;
  const traceId = snapshot.traceId;
  const intent = snapshot.intent;
  return Object.freeze({
    ...(scope === undefined ? {} : { scope: scope as MemoryScope }),
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof traceId === "string" ? { traceId } : {}),
    ...(typeof intent === "string" ? { intent } : {}),
  });
}

/** 同 scope 已有 pending + 同批最终 text 去重后执行 legacy 写入与审计。 */
async function persistCandidates(
  deps: ExtractCandidateHandlerDeps,
  scope: MemoryScope,
  traceId: string,
  specs: readonly ComputedCandidateSpec[],
): Promise<number> {
  const existing = await deps.candidates.list({ scope, status: "pending" });
  const existingTexts = new Set(existing.map((candidate) => candidate.text));
  let created = 0;

  for (const spec of specs) {
    if (existingTexts.has(spec.text)) continue;

    const metadata: Record<string, unknown> = { ...spec.metadata };
    if (spec.semanticType === "profile") {
      metadata.profileLayer = inferProfileLayer(spec.text, scope);
    }
    const record = await deps.candidates.enqueue({
      scope,
      text: spec.text,
      semanticType: spec.semanticType,
      kind: spec.kind,
      confidence: spec.confidence,
      reason: spec.reason,
      evidenceIds: [...spec.evidence.eventIds],
      extractor: spec.extractor,
      metadata,
    });
    existingTexts.add(spec.text);
    created += 1;

    if (deps.audit) {
      await deps.audit({
        scope,
        action: "candidate.extract",
        targetId: record.id,
        metadata: { ...spec.auditMetadata, traceId },
      });
    }
  }
  return created;
}

/** 构造旧 runtime 使用的 extract_candidate handler；未注册任何 native handler。 */
export function createExtractCandidateHandler(
  deps: ExtractCandidateHandlerDeps,
): JobHandler {
  return async (job: JobRecord): Promise<{ created: number }> => {
    const { scope, text, traceId, intent } = readPayload(job);
    if (!scope || !text || text.trim().length === 0) return { created: 0 };
    if (traceId === undefined) {
      throw new Error("extract_candidate traceId is required");
    }

    const evidenceFacts = deps.readEvidenceFacts
      ? await deps.readEvidenceFacts({ scope, evidenceIds: [traceId] })
      : undefined;
    const computation = await computeCandidateSpecs(
      {
        extractor: deps.extractor,
        ...(deps.llmClient ? { llmClient: deps.llmClient } : {}),
        ...(deps.resolveMaxSimilarity
          ? { resolveMaxSimilarity: deps.resolveMaxSimilarity }
          : {}),
      },
      { scope, text, traceId, ...(intent ? { intent } : {}), ...(evidenceFacts ? { evidenceFacts } : {}) },
    );
    if (computation.fallbackReason === "llm_extraction_failed" && deps.audit) {
      await deps.audit({
        scope,
        action: "llm_extraction_failed",
        targetId: traceId,
        metadata: {
          reason: computation.fallbackReason,
          fallbackTo: "heuristic",
          intent: intent ?? "auto",
          textLength: text.length,
        },
      });
    }
    return {
      created: await persistCandidates(deps, scope, traceId, computation.specs),
    };
  };
}
