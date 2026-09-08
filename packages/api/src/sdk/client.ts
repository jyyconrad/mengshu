/**
 * mengshu JavaScript client SDK.
 *
 * SDK 通过 M2 REST API 访问 MemoryService，提供 bearer 注入、请求超时和稳定
 * 错误类型；它不依赖 OpenClaw，也不直接访问本地数据库。
 */

import type {
  MemoryClientContextInput,
  MemoryClientContextResult,
  MemoryClientFetch,
  MemoryClientHealth,
  MemoryClientOptions,
  MemoryClientRecallInput,
  MemoryClientRecallResult,
  MemoryClientStoreInput,
  MemoryClientStoreResult,
} from "./types.js";
import type { EvolutionBatchReport, EvolutionRunRequest, EvolutionReviewDecisionRequest, EvolutionProposalListRequest } from "../../../core/src/evolution/types.js";
import type { publicEvolutionReview, publicEvolutionProposalSummary, publicEvolutionProposalDetail } from "../evolution-review.js";
import type { RuntimeBackgroundWorkSnapshot, RuntimeBackgroundWorkUpdate } from "../../../core/src/runtime/background-work.js";
import type { EvolutionSourceAttestationRequest, EvolutionSourceAttestationRevocationRequest, EvolutionSourceControlReceipt } from "../evolution-source-control.js";
import type { EvolutionReuseControlCapability, EvolutionReuseGrantsRequest, invokeEvolutionReuseControl } from "../evolution-reuse-control.js";
import { parseEvolutionGovernanceRequest, type EvolutionUndoApprovalRequest, type EvolutionUndoApprovalReceipt, type EvolutionUndoPreview } from "../evolution-control.js";
import type { EvolutionControlRequest } from "../../../core/src/evolution/types.js";

export class MemoryClientError extends Error {
  status?: number;
  code?: string;
  body?: unknown;

  constructor(message: string, options: { status?: number; code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "MemoryClientError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

export class MemoryClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly ownerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: MemoryClientFetch;

  constructor(options: MemoryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.ownerToken = options.ownerToken;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  health(): Promise<MemoryClientHealth> {
    return this.request("/v1/health", { method: "GET" });
  }

  backgroundWorkStatus(): Promise<RuntimeBackgroundWorkSnapshot> {
    return this.request("/v1/runtime/background", { method: "GET" });
  }

  updateBackgroundWork(input: RuntimeBackgroundWorkUpdate): Promise<RuntimeBackgroundWorkSnapshot> {
    return this.request("/v1/runtime/background", { method: "POST", body: input, owner: true });
  }

  evolveMemory(input: EvolutionRunRequest): Promise<EvolutionBatchReport> {
    return this.request("/v1/evolution/run", { method: "POST", body: input });
  }

  evolutionStatus(batchId: string): Promise<EvolutionBatchReport> {
    return this.request("/v1/evolution/status", { method: "POST", body: { batchId } });
  }

  resumeEvolution(batchId: string): Promise<EvolutionBatchReport> {
    return this.request("/v1/evolution/resume", { method: "POST", body: { batchId }, owner: true });
  }

  cancelEvolution(batchId: string): Promise<EvolutionBatchReport> {
    return this.request("/v1/evolution/cancel", { method: "POST", body: { batchId }, owner: true });
  }

  async runEvolutionControl(input: EvolutionControlRequest): Promise<EvolutionBatchReport> {
    return this.request("/v1/evolution/control/run", {
      method: "POST", body: parseEvolutionGovernanceRequest("control/run", input), owner: true,
    });
  }

  async previewEvolutionUndo(operationReceiptId: string): Promise<EvolutionUndoPreview> {
    return this.request("/v1/evolution/control/undo-preview", {
      method: "POST", body: parseEvolutionGovernanceRequest("control/undo-preview", { operationReceiptId }), owner: true,
    });
  }

  async approveEvolutionUndo(input: EvolutionUndoApprovalRequest): Promise<EvolutionUndoApprovalReceipt> {
    return this.request("/v1/evolution/control/undo-approve", {
      method: "POST", body: parseEvolutionGovernanceRequest("control/undo-approve", input), owner: true,
    });
  }

  previewEvolutionReview(proposalId: string): Promise<ReturnType<typeof publicEvolutionReview>> {
    return this.request("/v1/evolution/review/preview", { method: "POST", body: { proposalId }, owner: true });
  }

  listEvolutionProposals(input: EvolutionProposalListRequest = {}): Promise<{
    proposals: Array<ReturnType<typeof publicEvolutionProposalSummary>>; nextCursor?: string;
  }> {
    return this.request("/v1/evolution/review/list", { method: "POST", body: input, owner: true });
  }

  evolutionProposalDetail(proposalId: string): Promise<ReturnType<typeof publicEvolutionProposalDetail>> {
    return this.request("/v1/evolution/review/detail", { method: "POST", body: { proposalId }, owner: true });
  }

  evolutionReviewStatus(reviewId: string): Promise<ReturnType<typeof publicEvolutionReview>> {
    return this.request("/v1/evolution/review/status", { method: "POST", body: { reviewId }, owner: true });
  }

  decideEvolutionReview(input: EvolutionReviewDecisionRequest): Promise<{
    id: string; reviewId: string; bindingHash: string; decision: "approve" | "reject"; decidedAt: number; expiresAt: number; reason?: string;
  }> {
    return this.request("/v1/evolution/review/decide", { method: "POST", body: input, owner: true });
  }

  applyEvolutionReview(approvalReceiptId: string): Promise<EvolutionBatchReport> {
    return this.request("/v1/evolution/review/apply", { method: "POST", body: { approvalReceiptId }, owner: true });
  }

  attestEvolutionSource(input: EvolutionSourceAttestationRequest): Promise<EvolutionSourceControlReceipt> {
    return this.request("/v1/evolution/source/attest", { method: "POST", body: input, owner: true });
  }

  revokeEvolutionSourceAttestation(input: EvolutionSourceAttestationRevocationRequest): Promise<EvolutionSourceControlReceipt> {
    return this.request("/v1/evolution/source/revoke-attestation", { method: "POST", body: input, owner: true });
  }

  evolutionReuseStatus(): ReturnType<EvolutionReuseControlCapability["status"]> {
    return this.request("/v1/evolution/reuse/status", { method: "POST", body: {}, owner: true });
  }

  replaceEvolutionReuseGrants(input: EvolutionReuseGrantsRequest): ReturnType<EvolutionReuseControlCapability["replaceGrants"]> {
    return this.request("/v1/evolution/reuse/grants", { method: "POST", body: input, owner: true });
  }

  evaluateEvolutionReuse(planId: string): ReturnType<typeof invokeEvolutionReuseControl> {
    return this.request("/v1/evolution/reuse/evaluate", { method: "POST", body: { planId }, owner: true });
  }

  storeMemory(input: MemoryClientStoreInput): Promise<MemoryClientStoreResult> {
    return this.request("/v1/memories", { method: "POST", body: input });
  }

  recall(input: MemoryClientRecallInput): Promise<MemoryClientRecallResult> {
    return this.request("/v1/recall", { method: "POST", body: input });
  }

  buildContext(input: MemoryClientContextInput): Promise<MemoryClientContextResult> {
    return this.request("/v1/context", { method: "POST", body: input });
  }

  private async request<T>(path: string, options: { method: string; body?: unknown; owner?: boolean }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {};
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (options.owner && this.ownerToken) headers["x-mengshu-owner-token"] = this.ownerToken;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        ...(options.owner ? { redirect: "error" as const } : {}),
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const body = await readResponseBody(response);
      if (!response.ok) {
        throw new MemoryClientError(errorMessageFromBody(body, response.statusText), {
          status: response.status,
          body,
        });
      }
      return body as T;
    } catch (error) {
      if (error instanceof MemoryClientError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new MemoryClientError("Memory request timed out", { code: "timeout" });
      }
      throw new MemoryClientError(error instanceof Error ? error.message : String(error), {
        code: "request_failed",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string") {
    return (body as Record<string, string>).error;
  }
  return fallback || "Memory client request failed";
}

export type {
  MemoryClientContextInput,
  MemoryClientContextResult,
  MemoryClientHealth,
  MemoryClientOptions,
  MemoryClientRecallInput,
  MemoryClientRecallResult,
  MemoryClientStoreInput,
  MemoryClientStoreResult,
} from "./types.js";
