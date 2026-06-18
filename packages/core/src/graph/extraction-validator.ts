/**
 * LLM 提取输出校验器。
 *
 * 过滤无效实体和关系，任何不通过的项被丢弃而不是抛错。
 */
import { ENTITY_TYPES, RELATION_PREDICATES } from "./schema.js";
import type { EntityType, RelationPredicate } from "./schema.js";

export interface RawEntity {
  name: unknown;
  type: unknown;
  description?: unknown;
  aliases?: unknown;
}

export interface RawRelation {
  subject: unknown;
  predicate: unknown;
  object: unknown;
  confidence: unknown;
  evidence: unknown;
}

export interface RawLlmExtraction {
  entities?: unknown;
  relations?: unknown;
}

export interface ValidatedEntity {
  name: string;
  type: EntityType;
  description: string;
  aliases: string[];
}

export interface ValidatedRelation {
  subject: string;
  predicate: RelationPredicate;
  object: string;
  confidence: number;
  evidence: string;
}

export interface ValidatedExtraction {
  entities: ValidatedEntity[];
  relations: ValidatedRelation[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateExtraction(
  raw: RawLlmExtraction,
  _sourceText: string,
): ValidatedExtraction {
  const entities: ValidatedEntity[] = [];

  const rawEntities = Array.isArray(raw.entities) ? (raw.entities as unknown[]) : [];
  for (const item of rawEntities) {
    const e = item as RawEntity;
    if (
      !isNonEmptyString(e.name) ||
      e.name.length > 200 ||
      !(ENTITY_TYPES as readonly unknown[]).includes(e.type)
    ) {
      continue;
    }
    const aliases: string[] = Array.isArray(e.aliases)
      ? (e.aliases as unknown[]).filter(isNonEmptyString)
      : [];
    entities.push({
      name: e.name,
      type: e.type as EntityType,
      description: isNonEmptyString(e.description) ? e.description : "",
      aliases,
    });
  }

  const entityNames = new Set(entities.map((e) => e.name));
  const relations: ValidatedRelation[] = [];

  const rawRelations = Array.isArray(raw.relations) ? (raw.relations as unknown[]) : [];
  for (const item of rawRelations) {
    const r = item as RawRelation;
    const conf = r.confidence;
    if (
      !isNonEmptyString(r.subject) ||
      !isNonEmptyString(r.object) ||
      !isNonEmptyString(r.evidence) ||
      !(RELATION_PREDICATES as readonly unknown[]).includes(r.predicate) ||
      typeof conf !== "number" ||
      conf <= 0 ||
      conf > 1.0 ||
      !entityNames.has(r.subject) ||
      !entityNames.has(r.object)
    ) {
      continue;
    }
    relations.push({
      subject: r.subject,
      predicate: r.predicate as RelationPredicate,
      object: r.object,
      confidence: conf,
      evidence: r.evidence,
    });
  }

  return { entities, relations };
}
