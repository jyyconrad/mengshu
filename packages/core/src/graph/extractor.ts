/**
 * Rule-based graph extractor.
 *
 * 第一阶段不依赖 LLM：从 chunk 文本、sourceId 和 metadata 中抽取文件/项目/工具/概念
 * 实体，并生成 allowlist relation；所有 relation 都绑定当前 chunk 作为 evidence。
 */

import { createHash } from "node:crypto";
import { scopeToKey } from "../core/scope.js";
import type { MemoryScope } from "../core/types.js";
import type {
  EntityType,
  GraphEntityRecord,
  GraphExtractionInput,
  GraphExtractionResult,
  GraphRelationRecord,
  RelationPredicate,
} from "./types.js";

const TOOL_ALIASES: Record<string, string> = {
  postgres: "postgresql",
  postgresql: "postgresql",
  lancedb: "lancedb",
  supabase: "supabase",
  openclaw: "openclaw",
  mcp: "mcp",
  rest: "rest",
  sdk: "sdk",
  bm25: "bm25",
};

function hashId(prefix: string, parts: string[]): string {
  const digest = createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function entity(
  scope: MemoryScope,
  type: EntityType,
  displayName: string,
  createdAt: number,
  metadata: Record<string, unknown> = {},
): GraphEntityRecord {
  const canonicalName = normalizeName(displayName);
  const scopeKey = scopeToKey(scope);
  return {
    id: hashId("ent", [scopeKey, type, canonicalName]),
    scope,
    canonicalName,
    displayName,
    type,
    aliases: [displayName],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: metadata.sourceId ? 1 : 0,
    lastSeenAt: createdAt,
    hotness: 0,
    queryHits30d: 0,
    status: "active",
    createdAt,
    updatedAt: createdAt,
    metadata,
  };
}

function relation(
  scope: MemoryScope,
  subjectId: string,
  predicate: RelationPredicate,
  objectId: string,
  chunkId: string,
  createdAt: number,
  confidence: number,
  sourceKind: string,
  metadata: Record<string, unknown> = {},
): GraphRelationRecord {
  const scopeKey = scopeToKey(scope);
  return {
    id: hashId("rel", [scopeKey, subjectId, predicate, objectId]),
    scope,
    subjectId,
    predicate,
    objectId,
    confidence,
    evidenceChunkIds: [chunkId],
    evidenceCount: 1,
    firstSeenAt: createdAt,
    lastSeenAt: createdAt,
    status: confidence < 0.5 ? "weak" : "active",
    sourceKinds: [sourceKind],
    metadata,
  };
}

function extractFilePaths(text: string, sourceId?: string): string[] {
  const matches: string[] = text.match(/(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+/g) ?? [];
  if (sourceId?.startsWith("/") || sourceId?.startsWith("file:")) {
    matches.push(sourceId);
  }
  return Array.from(new Set(matches));
}

function extractProjectNames(text: string, metadata: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const projectPath = typeof metadata.projectPath === "string" ? metadata.projectPath : undefined;
  if (projectPath) {
    names.add(projectPath.split("/").filter(Boolean).at(-1) ?? projectPath);
  }
  for (const match of text.matchAll(/\b([a-zA-Z][\w-]{2,})\s+(?:project|repo|repository)\b/gi)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/\b(mengshu|openclaw)\b/gi)) {
    names.add(match[1]);
  }
  return Array.from(names);
}

function extractTools(text: string): string[] {
  const lower = text.toLowerCase();
  return Object.keys(TOOL_ALIASES)
    .filter((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower))
    .map((name) => TOOL_ALIASES[name]);
}

function addUniqueEntity(map: Map<string, GraphEntityRecord>, record: GraphEntityRecord): GraphEntityRecord {
  const existing = map.get(record.id);
  if (existing) {
    existing.mentionCount += 1;
    existing.mentionCount30d += 1;
    existing.aliases = Array.from(new Set([...existing.aliases, ...record.aliases]));
    existing.updatedAt = Math.max(existing.updatedAt, record.updatedAt);
    existing.lastSeenAt = Math.max(existing.lastSeenAt ?? 0, record.lastSeenAt ?? 0);
    return existing;
  }
  map.set(record.id, record);
  return record;
}

export function extractGraph(input: GraphExtractionInput): GraphExtractionResult {
  const entities = new Map<string, GraphEntityRecord>();
  const relations: GraphRelationRecord[] = [];
  const metadata = {
    ...(input.metadata ?? {}),
    sourceId: input.sourceId,
  };
  const sourceKind = typeof input.metadata?.source === "string" ? input.metadata.source : "chunk";

  const chunkEntity = addUniqueEntity(
    entities,
    entity(input.scope, "chunk", input.chunkId, input.createdAt, metadata),
  );

  const projectEntities = extractProjectNames(input.text, metadata).map((name) =>
    addUniqueEntity(entities, entity(input.scope, "project", name, input.createdAt, metadata)),
  );
  const fileEntities = extractFilePaths(input.text, input.sourceId).map((filePath) =>
    addUniqueEntity(entities, entity(input.scope, "file", filePath, input.createdAt, metadata)),
  );
  const toolEntities = extractTools(input.text).map((tool) =>
    addUniqueEntity(entities, entity(input.scope, "tool", tool, input.createdAt, metadata)),
  );

  for (const target of [...projectEntities, ...fileEntities, ...toolEntities]) {
    relations.push(relation(
      input.scope,
      chunkEntity.id,
      "mentions",
      target.id,
      input.chunkId,
      input.createdAt,
      0.75,
      sourceKind,
    ));
  }

  for (const project of projectEntities) {
    for (const tool of toolEntities) {
      if (/\b(use|uses|using|采用|使用|基于)\b/i.test(input.text)) {
        relations.push(relation(
          input.scope,
          project.id,
          "uses",
          tool.id,
          input.chunkId,
          input.createdAt,
          0.72,
          sourceKind,
        ));
      }
    }
    for (const file of fileEntities) {
      relations.push(relation(
        input.scope,
        project.id,
        "mentions",
        file.id,
        input.chunkId,
        input.createdAt,
        0.6,
        sourceKind,
      ));
    }
  }

  return {
    entities: Array.from(entities.values()),
    relations,
  };
}
