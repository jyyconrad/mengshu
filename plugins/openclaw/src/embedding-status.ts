import type {
  EmbeddingRecallPolicyDecision,
  EmbeddingWriteGuardSnapshot,
  EmbeddingWriteReasonCode,
} from "../../../packages/core/src/storage/embedding-space-policy.js";
import type { RuntimeLifecycleSnapshot } from "../../../packages/core/src/runtime/runtime-lifecycle.js";

export type OpenClawEmbeddingRegistryStatus =
  | "active"
  | "missing"
  | "mismatch"
  | "unavailable"
  | "legacy"
  | "unsupported";

export type OpenClawEmbeddingWriteMode =
  | "write-enabled"
  | "read-only"
  | "legacy-write-through";

export interface OpenClawEmbeddingStatus {
  status: OpenClawEmbeddingRegistryStatus;
  writeMode: OpenClawEmbeddingWriteMode;
  embeddingReadMode: EmbeddingRecallPolicyDecision["mode"];
  lifecycleState: RuntimeLifecycleSnapshot["state"];
  lifecycleReady: boolean;
  reasonCode: EmbeddingWriteReasonCode;
}

/**
 * 将内部 guard snapshot 收口为 OpenClaw 可公开的稳定、脱敏状态。
 *
 * 不包含 fingerprint、baseURL、provider error 或配置值；active 只对应
 * Postgres enforced guard 的 active-space-match。
 */
export function describeOpenClawEmbeddingStatus(
  dbType: string | undefined,
  snapshot: EmbeddingWriteGuardSnapshot,
  readSnapshot: EmbeddingRecallPolicyDecision,
  lifecycleSnapshot: Pick<RuntimeLifecycleSnapshot, "state" | "ready">,
): OpenClawEmbeddingStatus {
  const reasonCode = snapshot.decision.reasonCode;
  const embeddingReadMode = readSnapshot.mode;
  const lifecycle = {
    lifecycleState: lifecycleSnapshot.state,
    lifecycleReady: lifecycleSnapshot.ready,
  };
  if (dbType !== "postgres") {
    return {
      status: "legacy",
      writeMode: "legacy-write-through",
      embeddingReadMode,
      ...lifecycle,
      reasonCode,
    };
  }
  if (snapshot.enforcement !== "enforced") {
    return {
      status: "unsupported",
      writeMode: "read-only",
      embeddingReadMode,
      ...lifecycle,
      reasonCode,
    };
  }
  if (reasonCode === "active-space-match" && snapshot.decision.allowed) {
    return {
      status: "active",
      writeMode: "write-enabled",
      embeddingReadMode,
      ...lifecycle,
      reasonCode,
    };
  }
  if (reasonCode === "registry-active-space-missing") {
    return {
      status: "missing",
      writeMode: "read-only",
      embeddingReadMode,
      ...lifecycle,
      reasonCode,
    };
  }
  if (reasonCode === "active-space-mismatch") {
    return {
      status: "mismatch",
      writeMode: "read-only",
      embeddingReadMode,
      ...lifecycle,
      reasonCode,
    };
  }
  return {
    status: "unavailable",
    writeMode: "read-only",
    embeddingReadMode,
    ...lifecycle,
    reasonCode,
  };
}
