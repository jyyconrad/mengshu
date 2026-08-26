/**
 * Fast-path observation 的 transport intent 到原生写入治理语义的纯映射。
 *
 * Transport 只能表达用户意图，不能直接授予 active 生命周期。auto/remember
 * 都必须经过统一 validator/admission 链，并先落到候选容器；ignore 不产生持久化。
 */
import type { AdmissionRoute, MemoryContainer } from "../domain/types.js";

export type FastPathObservationIntent = "remember" | "auto" | "ignore";

export type FastPathObservationEffectiveRoute = Exclude<AdmissionRoute, "active">;

export interface IgnoredFastPathObservationPolicy {
  disposition: "ignore";
  durable: false;
  requiresAdmission: false;
  reason: "transport_ignore";
}

export interface GovernedFastPathObservationPolicy {
  disposition: "governed";
  durable: "after_admission";
  requiresAdmission: true;
  admissionIntent: Exclude<FastPathObservationIntent, "ignore">;
  container: Extract<MemoryContainer, "session_candidate">;
  effectiveRoute: FastPathObservationEffectiveRoute | undefined;
  reason:
    | "automatic_observation_requires_admission"
    | "explicit_observation_requires_admission";
}

export type FastPathObservationPolicy =
  | IgnoredFastPathObservationPolicy
  | GovernedFastPathObservationPolicy;

export interface FastPathObservationPolicyInput {
  /** 缺省按 auto 处理。 */
  intent?: FastPathObservationIntent;
  /** 统一 validator/admission 链的输出；准入前调用时不传。 */
  admissionRoute?: AdmissionRoute;
}

function governedRoute(
  route: AdmissionRoute | undefined,
): FastPathObservationEffectiveRoute | undefined {
  return route === "active" ? "candidate" : route;
}

/**
 * 生成 fast-path observation 的原生持久化决策。
 *
 * 可在准入前调用以获得 admissionIntent/container，也可在准入后再次调用以收敛
 * effectiveRoute。该函数刻意不返回 MemoryLifecycleStatus，避免用 pending 污染主库状态。
 */
export function mapFastPathObservationPolicy(
  input: FastPathObservationPolicyInput,
): FastPathObservationPolicy {
  const intent = input.intent ?? "auto";
  if (intent === "ignore") {
    return {
      disposition: "ignore",
      durable: false,
      requiresAdmission: false,
      reason: "transport_ignore",
    };
  }

  return {
    disposition: "governed",
    durable: "after_admission",
    requiresAdmission: true,
    admissionIntent: intent,
    container: "session_candidate",
    effectiveRoute: governedRoute(input.admissionRoute),
    reason: intent === "remember"
      ? "explicit_observation_requires_admission"
      : "automatic_observation_requires_admission",
  };
}
