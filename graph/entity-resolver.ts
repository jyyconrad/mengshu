/**
 * 将 LLM 验证后的提取结果解析为图谱记录。
 *
 * 使用确定性 ID（scope+type+canonicalName），与规则提取器保持一致。
 */
import { createHash } from "node:crypto";
import { scopeToKey } from "../core/scope.js";
import type { MemoryScope } from "../core/types.js";
import type { GraphEntityRecord, GraphExtractionResult, GraphRelationRecord } from "./types.js";
import type { ValidatedExtraction } from "./extraction-validator.js";

function hashId(prefix: string, parts: string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function canonicalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function resolveExtraction(
  validated: ValidatedExtraction,
  scope: MemoryScope,
  chunkId: string,
  createdAt: number,
): GraphExtractionResult {
  const scopeKey = scopeToKey(scope);

  const entities: GraphEntityRecord[] = validated.entities.map((entity) => {
    const id = hashId("ent", [scopeKey, entity.type, canonicalize(entity.name)]);
    const aliases = [...new Set([entity.name, ...entity.aliases])];
    return {
      id,
      scope,
      canonicalName: canonicalize(entity.name),
      displayName: entity.name,
      type: entity.type,
      aliases,
      mentionCount: 1,
      mentionCount30d: 1,
      distinctSourceCount: 1,
      hotness: 0,
      queryHits30d: 0,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      metadata: { description: entity.description, source: "llm" },
    };
  });

  const nameToId = new Map<string, string>(
    entities.map((e, i) => [validated.entities[i].name, e.id]),
  );

  const relations: GraphRelationRecord[] = validated.relations.map((relation) => {
    const subjectId = nameToId.get(relation.subject)!;
    const objectId = nameToId.get(relation.object)!;
    const id = hashId("rel", [scopeKey, subjectId, relation.predicate, objectId]);
    return {
      id,
      scope,
      subjectId,
      predicate: relation.predicate,
      objectId,
      confidence: relation.confidence,
      evidenceChunkIds: [chunkId],
      evidenceCount: 1,
      firstSeenAt: createdAt,
      lastSeenAt: createdAt,
      status: relation.confidence < 0.5 ? "weak" : "active",
      sourceKinds: ["llm"],
      metadata: { evidence: relation.evidence },
    };
  });

  return { entities, relations };
}
