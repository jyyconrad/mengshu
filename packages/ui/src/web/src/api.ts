/**
 * Browser-side Console REST client.
 *
 * 前端只通过 `/v1/console/*` 访问数据，不直接读取数据库；scope 在每次请求中显式传入。
 */

export interface Scope {
  tenantId: string;
  appId: string;
  userId: string;
  projectId: string;
  agentId: string;
  namespace: string;
}

export const defaultScope: Scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "default",
  projectId: "default",
  agentId: "default",
  namespace: "memories",
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export function fetchOverview(scope: Scope) {
  return request<{
    metrics: Record<string, number>;
    health: { ok: boolean; records?: number; error?: string };
    hotTopics: Array<{ id: string; label: string; hotness: number }>;
    dailyDigest?: { title: string; summary: string };
  }>("/v1/console/overview", {
    method: "POST",
    body: JSON.stringify({ scope }),
  });
}

export function lookup(scope: Scope, query: string) {
  return request<{
    results: Array<{
      id: string;
      kind: string;
      title: string;
      preview: string;
      score: number;
      sourceLabel: string;
      namespace: string;
      raw?: string;
    }>;
  }>("/v1/console/lookup", {
    method: "POST",
    body: JSON.stringify({ scope, query, limit: 10 }),
  });
}

export function fetchGraph(scope: Scope, query: string) {
  return request<{
    entities: Array<{ id: string; displayName: string; type: string; hotness: number }>;
    relations: Array<{ id: string; subjectId: string; predicate: string; objectId: string; confidence: number }>;
  }>("/v1/console/graph", {
    method: "POST",
    body: JSON.stringify({ scope, query, depth: 2, limit: 20 }),
  });
}

export function fetchJobs() {
  return request<{
    jobs: Array<{ id: string; type: string; status: string; attempts: number; error?: string }>;
    counts: Record<string, number>;
  }>("/v1/console/jobs");
}

export interface Candidate {
  id: string;
  preview: string;
  semanticType?: string;
  kind: string;
  confidence: number;
  status: string;
  evidenceIds: string[];
  createdAt: number;
}

export type CandidateReviewAction =
  | { action: "approve"; ids: string[] }
  | { action: "reject"; ids: string[]; reason?: string }
  | { action: "archive"; ids: string[] };

export function fetchCandidates(scope: Scope, filter: { status?: string; limit?: number } = { status: "pending" }) {
  return request<{ candidates: Candidate[]; total: number }>("/v1/console/candidates", {
    method: "POST",
    body: JSON.stringify({ scope, filter }),
  });
}

export function reviewCandidates(action: CandidateReviewAction) {
  return request<{ affected: number; promoted: string[]; errors: string[] }>(
    "/v1/console/candidates/review",
    {
      method: "POST",
      body: JSON.stringify({ action }),
    }
  );
}
