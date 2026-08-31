import { randomUUID } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  SkillCandidate,
  SkillCandidateRepository,
  SkillCandidateStatus,
} from "../lifecycle/skill-candidate-types.js";
import type { PostgresSkillArtifactClient } from "./postgres-repository.js";

function decode(value: unknown): SkillCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SKILL_CANDIDATE_INVALID_ROW");
  const candidate = value as SkillCandidate;
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string" ||
      !Array.isArray(candidate.steps) || typeof candidate.createdAt !== "number") {
    throw new Error("SKILL_CANDIDATE_INVALID_ROW");
  }
  return structuredClone(candidate);
}
export class PostgresSkillCandidateRepository implements SkillCandidateRepository {
  constructor(readonly client: PostgresSkillArtifactClient, readonly now: () => number = Date.now) {}

  async create(
    input: Omit<SkillCandidate, "id" | "createdAt"> & { id?: string },
  ): Promise<SkillCandidate> {
    const id = input.id ?? `skill-${randomUUID()}`;
    const createdAt = this.now();
    const candidate: SkillCandidate = { ...input, id, createdAt };
    if (candidate.scope.visibility !== "private") throw new Error("SKILL_CANDIDATE_SCOPE_MISMATCH");
    const scopeFingerprint = authorityScopeFingerprint(candidate.scope);
    const result = await this.client.query(
      `/* skill-candidate:create */
INSERT INTO mengshu_skill_candidates (
  scope_fingerprint, candidate_id, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, topic_label, status, confidence,
  candidate, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
RETURNING candidate_id`,
      [scopeFingerprint, id, candidate.scope.tenantId, candidate.scope.userId,
        candidate.scope.appId, candidate.scope.projectId, candidate.scope.agentId,
        candidate.scope.namespace, candidate.scope.visibility, candidate.topicLabel,
        candidate.status, candidate.confidence, JSON.stringify(candidate), createdAt,
        candidate.updatedAt ?? null],
    );
    if (result.rowCount !== 1) throw new Error("SKILL_CANDIDATE_CONFLICT");
    return structuredClone(candidate);
  }

  async get(id: string): Promise<SkillCandidate | undefined> {
    const result = await this.client.query<{ candidate: unknown }>(
      `/* skill-candidate:get */
SELECT candidate FROM mengshu_skill_candidates WHERE candidate_id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? undefined : decode(result.rows[0].candidate);
  }

  async list(filter: {
    scope?: MemoryScope;
    status?: SkillCandidateStatus;
    topicLabel?: string;
    minConfidence?: number;
    limit?: number;
  } = {}): Promise<SkillCandidate[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown): void => {
      params.push(value);
      conditions.push(condition.replace("?", `$${params.length}`));
    };
    if (filter.scope !== undefined) add("scope_fingerprint = ?", authorityScopeFingerprint(filter.scope));
    if (filter.status !== undefined) add("status = ?", filter.status);
    if (filter.topicLabel !== undefined) add("topic_label = ?", filter.topicLabel);
    if (filter.minConfidence !== undefined) add("confidence >= ?", filter.minConfidence);
    const limit = filter.limit === undefined ? 100 : Math.max(1, Math.min(1_000, filter.limit));
    params.push(limit);
    const result = await this.client.query<{ candidate: unknown }>(
      `/* skill-candidate:list */
SELECT candidate FROM mengshu_skill_candidates
${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
ORDER BY created_at DESC, candidate_id LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => decode(row.candidate));
  }

  async updateStatus(
    id: string,
    status: SkillCandidateStatus,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const current = await this.get(id);
    if (current === undefined) throw new Error("SKILL_CANDIDATE_NOT_FOUND");
    const updatedAt = this.now();
    const candidate: SkillCandidate = {
      ...current,
      status,
      updatedAt,
      ...(metadata === undefined ? {} : { metadata: { ...current.metadata, ...metadata } }),
    };
    const result = await this.client.query(
      `/* skill-candidate:update-status */
UPDATE mengshu_skill_candidates SET
  status = $1, candidate = $2::jsonb, updated_at = $3
WHERE candidate_id = $4 AND status = $5
RETURNING candidate_id`,
      [status, JSON.stringify(candidate), updatedAt, id, current.status],
    );
    if (result.rowCount !== 1) throw new Error("SKILL_CANDIDATE_CONFLICT");
  }

  async delete(id: string): Promise<void> {
    await this.updateStatus(id, "archived", { archivedBy: "repository-delete" });
  }

  async findByTopic(topicLabel: string, scope?: MemoryScope): Promise<SkillCandidate[]> {
    return this.list({ topicLabel, ...(scope === undefined ? {} : { scope }) });
  }
}
