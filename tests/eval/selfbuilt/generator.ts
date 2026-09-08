import { createHash } from "node:crypto";

import type {
  MemoryKind,
  MemoryLifecycleStatus,
  MemoryScope,
  MemorySemanticType,
} from "../../../packages/core/src/domain/types.js";
import {
  parseSelfBuiltEvalCaseV1,
  SELFBUILT_CAPABILITIES,
  SELFBUILT_SCENARIOS,
  type SelfBuiltCapability,
  type SelfBuiltEvalCaseV1,
  type SelfBuiltHydrationState,
  type SelfBuiltMemoryEventV1,
  type SelfBuiltScenario,
  type SelfBuiltSourceClass,
} from "./protocol.js";

export const SELFBUILT_DATASET_ID = "mengshu-selfbuilt-v1" as const;
export const SELFBUILT_DATASET_VERSION = "template-v1" as const;
export const SELFBUILT_CASE_COUNT = 360;

export interface SelfBuiltDatasetManifest {
  readonly schemaVersion: "mengshu.selfbuilt-dataset/v1";
  readonly datasetId: typeof SELFBUILT_DATASET_ID;
  readonly datasetVersion: typeof SELFBUILT_DATASET_VERSION;
  readonly status: "frozen";
  readonly sourceType: "deterministic-synthetic";
  readonly scoreAuthority: "selfbuilt-diagnostic";
  readonly formalReleaseEligible: false;
  readonly generatorVersion: "selfbuilt-generator/v1";
  readonly randomSeed: 42;
  readonly caseCount: number;
  readonly splitCounts: Readonly<{ dev: number; test: number }>;
  readonly countsByCapability: Readonly<Record<SelfBuiltCapability, number>>;
  readonly countsByScenario: Readonly<Record<SelfBuiltScenario, number>>;
  readonly crossDistribution: Readonly<Record<
    SelfBuiltCapability,
    Readonly<Record<SelfBuiltScenario, number>>
  >>;
  readonly casesSha256: string;
}

interface CapabilityShape {
  readonly semanticType: MemorySemanticType;
  readonly kind: MemoryKind;
}

const CAPABILITY_SHAPES: Readonly<Record<SelfBuiltCapability, CapabilityShape>> = Object.freeze({
  "durable-facts-profile-rules": { semanticType: "profile", kind: "preference" },
  "task-project-continuity": { semanticType: "task_context", kind: "task" },
  "temporal-update-conflict": { semanticType: "task_context", kind: "fact" },
  "cross-source-evidence": { semanticType: "experience", kind: "observation" },
  "negative-interference-abstention": { semanticType: "resource", kind: "knowledge" },
  "scope-lifecycle-sensitive": { semanticType: "task_context", kind: "decision" },
});
const SOURCE_CLASSES = ["session", "document", "tool", "agent-history"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scope(cell: number): MemoryScope {
  return Object.freeze({
    tenantId: "tenant-selfbuilt",
    appId: "codex",
    userId: `user-${cell % 3}`,
    projectId: `project-${cell % 7}`,
    agentId: "agent-eval",
    namespace: "memories",
    workspaceId: `workspace-${cell % 4}`,
    sessionId: `session-${cell}`,
    visibility: "private" as const,
  });
}

function wrongScope(base: MemoryScope, semanticType: MemorySemanticType): MemoryScope {
  const workspaceReusable = semanticType === "profile" || semanticType === "rules" ||
    semanticType === "experience";
  return Object.freeze({
    ...base,
    ...(workspaceReusable
      ? { workspaceId: `${base.workspaceId}-other`, sessionId: `${base.sessionId}-other` }
      : { projectId: `${base.projectId}-other`, sessionId: `${base.sessionId}-other` }),
  });
}

function event(input: {
  readonly id: string;
  readonly evidenceRef?: string;
  readonly occurredAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly scope: MemoryScope;
  readonly text: string;
  readonly semanticType: MemorySemanticType;
  readonly kind: MemoryKind;
  readonly lifecycleStatus?: MemoryLifecycleStatus;
  readonly sourceClass: SelfBuiltSourceClass;
  readonly supersededBy?: string;
  readonly hydrationState?: SelfBuiltHydrationState;
}): SelfBuiltMemoryEventV1 {
  return Object.freeze({
    eventId: input.id,
    evidenceRef: input.evidenceRef ?? `evidence-${input.id}`,
    occurredAt: input.occurredAt,
    validFrom: input.validFrom ?? input.occurredAt,
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
    scope: input.scope,
    text: input.text,
    semanticType: input.semanticType,
    kind: input.kind,
    lifecycleStatus: input.lifecycleStatus ?? "active",
    admissionRoute: "active",
    sourceClass: input.sourceClass,
    ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
    ...(input.hydrationState === undefined ? {} : { hydrationState: input.hydrationState }),
  });
}

function phrase(language: "zh" | "en", anchor: string, role: string): string {
  return language === "zh"
    ? `${anchor} ${role}，该内容仅用于确定性自建评测。`
    : `${anchor} ${role}; deterministic self-built evaluation content only.`;
}

function makeCase(
  capability: SelfBuiltCapability,
  scenario: SelfBuiltScenario,
  sample: number,
  capabilityIndex: number,
  scenarioIndex: number,
): Readonly<SelfBuiltEvalCaseV1> {
  const cell = capabilityIndex * SELFBUILT_SCENARIOS.length * 10 + scenarioIndex * 10 + sample;
  const baseScope = scope(cell);
  const shape = CAPABILITY_SHAPES[capability];
  const language = sample % 2 === 0 ? "zh" as const : "en" as const;
  const split = sample < 2 ? "dev" as const : "test" as const;
  const anchor = `sb${capabilityIndex}${scenarioIndex}${sample}`;
  const oldAt = new Date(Date.UTC(2026, 0, 1 + cell)).toISOString();
  const currentAt = new Date(Date.UTC(2026, 0, 2 + cell)).toISOString();
  const queryAt = new Date(Date.UTC(2026, 0, 3 + cell)).toISOString();
  const currentId = `${anchor}-current`;
  const currentEvidence = `evidence-${currentId}`;
  const events: SelfBuiltMemoryEventV1[] = [];
  const forbidden: string[] = [];
  const required: string[] = [];
  const abstain = capability === "negative-interference-abstention";
  const sourceClass = SOURCE_CLASSES[cell % SOURCE_CLASSES.length]!;

  const addCurrent = (suffix = "current", source = sourceClass) => {
    const id = `${anchor}-${suffix}`;
    const evidenceRef = `evidence-${id}`;
    events.push(event({
      id, evidenceRef, occurredAt: currentAt, scope: baseScope,
      text: phrase(language, anchor, suffix === "current-2"
        ? "supporting canonical evidence" : "current canonical evidence"),
      semanticType: shape.semanticType, kind: shape.kind, sourceClass: source,
      ...(scenario === "hydration-fallback" ? { hydrationState: "unavailable" as const } : {}),
    }));
    required.push(evidenceRef);
  };

  if (abstain) {
    const id = `${anchor}-forbidden`;
    const includesAnchor = scenario !== "direct-recall" && scenario !== "cross-source" &&
      scenario !== "hydration-fallback";
    const lifecycleStatus: MemoryLifecycleStatus = scenario === "lifecycle-block"
      ? "revoked" : scenario === "temporal-update" ? "superseded" : "active";
    const targetScope = scenario === "scope-isolation"
      ? wrongScope(baseScope, shape.semanticType) : baseScope;
    const validTo = scenario === "temporal-update" ? currentAt : undefined;
    events.push(event({
      id, occurredAt: oldAt, validTo, scope: targetScope,
      text: includesAnchor
        ? phrase(language, `${anchor} ${anchor} ${anchor}`, "forbidden obsolete evidence")
        : phrase(language, `noise${cell}`, "irrelevant blocked item"),
      semanticType: shape.semanticType, kind: shape.kind, lifecycleStatus,
      sourceClass,
      ...(scenario === "hydration-fallback" ? { hydrationState: "unavailable" as const } : {}),
    }));
    forbidden.push(`evidence-${id}`);
  } else {
    switch (scenario) {
      case "direct-recall":
        addCurrent();
        break;
      case "temporal-update": {
        const oldId = `${anchor}-old`;
        events.push(event({
          id: oldId, occurredAt: oldAt, validTo: currentAt, scope: baseScope,
          text: phrase(language, `${anchor} ${anchor} ${anchor}`, "obsolete superseded evidence"),
          semanticType: shape.semanticType, kind: shape.kind, lifecycleStatus: "superseded",
          sourceClass, supersededBy: currentId,
        }));
        forbidden.push(`evidence-${oldId}`);
        addCurrent();
        break;
      }
      case "cross-source":
        addCurrent("current", "session");
        addCurrent("current-2", "document");
        break;
      case "scope-isolation": {
        const wrongId = `${anchor}-wrong-scope`;
        events.push(event({
          id: wrongId, occurredAt: currentAt, scope: wrongScope(baseScope, shape.semanticType),
          text: phrase(language, `${anchor} ${anchor} ${anchor}`, "cross-scope forbidden evidence"),
          semanticType: shape.semanticType, kind: shape.kind, sourceClass,
        }));
        forbidden.push(`evidence-${wrongId}`);
        addCurrent();
        break;
      }
      case "lifecycle-block": {
        const revokedId = `${anchor}-revoked`;
        events.push(event({
          id: revokedId, occurredAt: currentAt, scope: baseScope,
          text: phrase(language, `${anchor} ${anchor} ${anchor}`, "revoked forbidden evidence"),
          semanticType: shape.semanticType, kind: shape.kind, lifecycleStatus: "revoked",
          sourceClass,
        }));
        forbidden.push(`evidence-${revokedId}`);
        addCurrent();
        break;
      }
      case "hydration-fallback":
        addCurrent();
        break;
    }
  }

  for (let index = 0; index < 3; index += 1) {
    const id = `${anchor}-noise-${index}`;
    events.push(event({
      id, occurredAt: oldAt, scope: baseScope,
      text: phrase(language, `noise${cell}-${index}`, "unrelated distractor"),
      semanticType: shape.semanticType, kind: shape.kind,
      sourceClass: SOURCE_CLASSES[(cell + index + 1) % SOURCE_CLASSES.length]!,
    }));
  }

  return parseSelfBuiltEvalCaseV1({
    schemaVersion: "1",
    id: `selfbuilt-${capabilityIndex}-${scenarioIndex}-${sample}`,
    track: "selfbuilt",
    datasetId: SELFBUILT_DATASET_ID,
    datasetVersion: SELFBUILT_DATASET_VERSION,
    split,
    language,
    capability,
    scenario,
    memoryStream: events,
    query: {
      text: language === "zh" ? `${anchor} 当前有效证据是什么` : `What is the current ${anchor} evidence`,
      scope: baseScope,
      occurredAt: queryAt,
      expectedMode: abstain ? "abstain" : "answer",
      topK: scenario === "cross-source" ? 3 : 2,
    },
    gold: { requiredEvidenceRefs: required, forbiddenEvidenceRefs: forbidden },
  });
}

export function generateSelfBuiltCases(): readonly Readonly<SelfBuiltEvalCaseV1>[] {
  const cases: Readonly<SelfBuiltEvalCaseV1>[] = [];
  SELFBUILT_CAPABILITIES.forEach((capability, capabilityIndex) => {
    SELFBUILT_SCENARIOS.forEach((scenario, scenarioIndex) => {
      for (let sample = 0; sample < 10; sample += 1) {
        cases.push(makeCase(capability, scenario, sample, capabilityIndex, scenarioIndex));
      }
    });
  });
  return Object.freeze(cases);
}

export function serializeSelfBuiltCases(cases: readonly Readonly<SelfBuiltEvalCaseV1>[]): string {
  return cases.map((item) => JSON.stringify(parseSelfBuiltEvalCaseV1(item))).join("\n") + "\n";
}

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key,
    values.filter((value) => value === key).length])) as Record<T, number>;
}

export function buildSelfBuiltManifest(
  cases: readonly Readonly<SelfBuiltEvalCaseV1>[],
  jsonl: string,
): Readonly<SelfBuiltDatasetManifest> {
  if (cases.length !== SELFBUILT_CASE_COUNT || serializeSelfBuiltCases(cases) !== jsonl) {
    throw new Error("self-built dataset is not the canonical 360-case serialization");
  }
  const countsByCapability = countBy(cases.map((item) => item.capability), SELFBUILT_CAPABILITIES);
  const countsByScenario = countBy(cases.map((item) => item.scenario), SELFBUILT_SCENARIOS);
  const crossDistribution = Object.fromEntries(SELFBUILT_CAPABILITIES.map((capability) => [
    capability,
    countBy(cases.filter((item) => item.capability === capability).map((item) => item.scenario),
      SELFBUILT_SCENARIOS),
  ])) as Record<SelfBuiltCapability, Record<SelfBuiltScenario, number>>;
  if (Object.values(countsByCapability).some((count) => count !== 60) ||
      Object.values(countsByScenario).some((count) => count !== 60) ||
      Object.values(crossDistribution).some((row) => Object.values(row).some((count) => count !== 10))) {
    throw new Error("self-built dataset quotas are invalid");
  }
  return Object.freeze({
    schemaVersion: "mengshu.selfbuilt-dataset/v1",
    datasetId: SELFBUILT_DATASET_ID,
    datasetVersion: SELFBUILT_DATASET_VERSION,
    status: "frozen",
    sourceType: "deterministic-synthetic",
    scoreAuthority: "selfbuilt-diagnostic",
    formalReleaseEligible: false,
    generatorVersion: "selfbuilt-generator/v1",
    randomSeed: 42,
    caseCount: cases.length,
    splitCounts: Object.freeze({
      dev: cases.filter((item) => item.split === "dev").length,
      test: cases.filter((item) => item.split === "test").length,
    }),
    countsByCapability: Object.freeze(countsByCapability),
    countsByScenario: Object.freeze(countsByScenario),
    crossDistribution: Object.freeze(Object.fromEntries(
      Object.entries(crossDistribution).map(([key, value]) => [key, Object.freeze(value)]),
    )) as SelfBuiltDatasetManifest["crossDistribution"],
    casesSha256: sha256(jsonl),
  });
}
