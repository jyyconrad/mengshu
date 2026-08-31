import type { RuntimeCostCategory, RuntimeCostContext } from "../cost/runtime-cost.js";
import { fingerprintRuntimeScope } from "../cost/runtime-cost.js";
import type { MemoryScope } from "../domain/types.js";
import type { ResolvedMemoryPolicy } from "./types.js";

export function memoryPolicyCostContext(input: {
  readonly scope: MemoryScope;
  readonly resolvedPolicy?: ResolvedMemoryPolicy;
  readonly category: RuntimeCostCategory;
  readonly operation: string;
  readonly classifyOverlay?: boolean;
}): RuntimeCostContext {
  const receipt = input.resolvedPolicy?.receipt;
  return {
    category: input.classifyOverlay && input.resolvedPolicy?.source === "overlay"
      ? "policy_overlay"
      : input.category,
    operation: input.operation,
    scopeFingerprint: receipt === undefined
      ? fingerprintRuntimeScope(input.scope)
      : `sha256:${receipt.scopeFingerprint}`,
    ...(receipt === undefined ? {} : { policyResolution: receipt }),
  };
}
