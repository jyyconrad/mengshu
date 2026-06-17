/**
 * Graph schema single source of truth.
 *
 * 定义知识图谱的实体类型和关系谓词，作为唯一事实来源。
 * LLM prompt、validator 和类型定义均从此文件导入，确保 schema 一致性。
 */

/**
 * 实体类型（closed schema）
 */
export const ENTITY_TYPES = [
  "person",
  "organization",
  "project",
  "repo",
  "file",
  "topic",
  "tool",
  "task",
  "concept",
  "user",
  "agent",
  "chunk",
  "document",
  "other",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * 关系谓词（closed schema）
 */
export const RELATION_PREDICATES = [
  "mentions",
  "works_on",
  "uses",
  "owns",
  "depends_on",
  "decided",
  "prefers",
  "blocked_by",
  "fixed_by",
  "supersedes",
  "related_to",
] as const;

export type RelationPredicate = (typeof RELATION_PREDICATES)[number];
