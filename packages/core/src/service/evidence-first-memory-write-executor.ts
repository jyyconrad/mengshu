import { createHash } from "node:crypto";

import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
  PersistedMemoryWriteResult,
} from "./write-kernel.js";

type SaveExplicitCommand = Extract<MemoryWriteCommand, { type: "saveExplicit" }>;

export interface EvidenceFirstMemoryWriteExecutorDependencies {
  executeKernel(command: MemoryWriteCommand): Promise<MemoryWriteKernelResult>;
  linkDuplicateEvidence?(input: DuplicateEvidenceLinkInput): Promise<DuplicateEvidenceLinkReceipt>;
}

export interface DuplicateEvidenceLinkInput {
  readonly command: SaveExplicitCommand;
  readonly evidenceMemoryId: string;
  readonly targetMemoryId: string;
}

export interface DuplicateEvidenceLinkReceipt {
  readonly linkId: string;
}

export type EvidenceFirstMemoryWriteResult =
  | MemoryWriteKernelResult
  | {
      status: "evidence_not_persisted";
      evidence: MemoryWriteKernelResult;
      governanceExecuted: false;
    }
  | {
      status: "governance_persisted";
      evidenceMemoryId: string;
      evidence: PersistedMemoryWriteResult;
      governance: Extract<MemoryWriteKernelResult, { status: "persisted" }>;
      link: {
        status: "linked";
        evidenceMemoryId: string;
      };
    }
  | {
      status: "governance_rejected";
      evidenceMemoryId: string;
      evidence: PersistedMemoryWriteResult;
      governance: Extract<MemoryWriteKernelResult, { status: "rejected" }>;
      evidenceRetained: true;
    }
  | {
      status: "governance_duplicate";
      evidenceMemoryId: string;
      evidence: PersistedMemoryWriteResult;
      governance: Extract<MemoryWriteKernelResult, { status: "duplicate" }>;
      evidenceRetained: true;
      link: {
        status: "linked";
        linkId: string;
        evidenceMemoryId: string;
        targetMemoryId: string;
      } | {
        status: "not_linked";
        evidenceMemoryId: string;
        reason: "duplicate_target_missing";
      };
    }
  | {
      status: "governance_ignored";
      evidenceMemoryId: string;
      evidence: PersistedMemoryWriteResult;
      governance: Extract<MemoryWriteKernelResult, { status: "ignored" }>;
      evidenceRetained: true;
    };

export interface EvidenceFirstMemoryWriteExecutor {
  execute(command: MemoryWriteCommand): Promise<EvidenceFirstMemoryWriteResult>;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("evidence child command must be JSON serializable");
    return JSON.stringify(value);
  }
  if (value === undefined) return "undefined";
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new Error("evidence child command must be JSON serializable without cycles");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function evidenceChildHash(command: SaveExplicitCommand): string {
  const snapshot = {
    type: command.type,
    idempotencyKey: command.idempotencyKey,
    clientScope: command.clientScope,
    text: command.text,
    kind: command.kind,
    semanticType: command.semanticType,
    container: command.container,
    confidence: command.confidence,
    category: command.category,
    dataType: command.dataType,
    tableName: command.tableName,
    metadata: command.metadata,
    provenance: command.provenance,
    evidenceIds: command.evidenceIds,
  };
  return createHash("sha256")
    .update("mengshu:evidence-first-write:v1\0")
    .update(canonicalJson(snapshot))
    .digest("hex");
}

function evidenceSourceId(command: SaveExplicitCommand, childHash: string): string {
  const provenanceSourceId = command.provenance?.sourceId?.trim();
  return provenanceSourceId || `event:${childHash}`;
}

function evidenceCommand(command: SaveExplicitCommand): MemoryWriteCommand {
  const childHash = evidenceChildHash(command);
  const sourceId = evidenceSourceId(command, childHash);
  const {
    type: _type,
    idempotencyKey: _idempotencyKey,
    semanticType: _semanticType,
    container: _container,
    confidence: _confidence,
    evidenceIds: _evidenceIds,
    ...shared
  } = command;
  return {
    ...shared,
    type: "importEvidence",
    idempotencyKey: `evidence:${childHash}`,
    kind: "observation",
    container: "session_candidate",
    sourceId,
    metadata: Object.freeze({
      ...(command.metadata ?? {}),
      eventType: "explicit_save",
    }),
    provenance: Object.freeze({
      ...(command.provenance ?? {}),
      sourceId,
    }),
    evidenceIds: [sourceId],
  };
}

function isPersistedEvidence(
  result: MemoryWriteKernelResult,
): result is PersistedMemoryWriteResult {
  return result.status === "persisted" &&
    "route" in result &&
    result.recordType === "memory" &&
    result.route === "evidence_only" &&
    result.memoryId.length > 0;
}

async function executeSaveExplicit(
  command: SaveExplicitCommand,
  dependencies: EvidenceFirstMemoryWriteExecutorDependencies,
): Promise<EvidenceFirstMemoryWriteResult> {
  const evidence = await dependencies.executeKernel(evidenceCommand(command));
  if (!isPersistedEvidence(evidence)) {
    return {
      status: "evidence_not_persisted",
      evidence,
      governanceExecuted: false,
    };
  }

  const evidenceMemoryId = evidence.memoryId;
  const governance = await dependencies.executeKernel({
    ...command,
    evidenceIds: [evidenceMemoryId],
  });

  switch (governance.status) {
    case "persisted":
      return {
        status: "governance_persisted",
        evidenceMemoryId,
        evidence,
        governance,
        link: { status: "linked", evidenceMemoryId },
      };
    case "rejected":
      return {
        status: "governance_rejected",
        evidenceMemoryId,
        evidence,
        governance,
        evidenceRetained: true,
      };
    case "duplicate": {
      if (governance.duplicateOf === undefined) {
        return {
          status: "governance_duplicate",
          evidenceMemoryId,
          evidence,
          governance,
          evidenceRetained: true,
          link: {
            status: "not_linked",
            evidenceMemoryId,
            reason: "duplicate_target_missing",
          },
        };
      }
      if (!dependencies.linkDuplicateEvidence) {
        throw new Error("duplicate evidence link capability is unavailable");
      }
      const link = await dependencies.linkDuplicateEvidence({
        command,
        evidenceMemoryId,
        targetMemoryId: governance.duplicateOf,
      });
      if (!link || typeof link.linkId !== "string" || link.linkId.length === 0) {
        throw new Error("duplicate evidence link receipt is invalid");
      }
      return {
        status: "governance_duplicate",
        evidenceMemoryId,
        evidence,
        governance,
        evidenceRetained: true,
        link: {
          status: "linked",
          linkId: link.linkId,
          evidenceMemoryId,
          targetMemoryId: governance.duplicateOf,
        },
      };
    }
    case "ignored":
      return {
        status: "governance_ignored",
        evidenceMemoryId,
        evidence,
        governance,
        evidenceRetained: true,
      };
  }
}

export function createEvidenceFirstMemoryWriteExecutor(
  dependencies: EvidenceFirstMemoryWriteExecutorDependencies,
): EvidenceFirstMemoryWriteExecutor {
  if (!dependencies || typeof dependencies.executeKernel !== "function" ||
      (dependencies.linkDuplicateEvidence !== undefined &&
        typeof dependencies.linkDuplicateEvidence !== "function")) {
    throw new Error("evidence-first memory write executor dependencies are invalid");
  }
  return Object.freeze({
    execute(command: MemoryWriteCommand): Promise<EvidenceFirstMemoryWriteResult> {
      return command.type === "saveExplicit"
        ? executeSaveExplicit(command, dependencies)
        : dependencies.executeKernel(command);
    },
  });
}
