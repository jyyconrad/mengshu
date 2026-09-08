import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { EvolutionTransportError } from "./evolution.js";

interface HostOwner { readonly tenantId: string; readonly userId: string }
const requests = new AsyncLocalStorage<HostOwner>();
export const EVOLUTION_OWNER_HEADER = "x-mengshu-owner-token";

export function assertEvolutionOwnerRequest(expected: HostOwner): HostOwner {
  const owner = requests.getStore();
  if (!owner || owner.tenantId !== expected.tenantId || owner.userId !== expected.userId) {
    throw new EvolutionTransportError(403, "EVOLUTION_OWNER_REQUIRED");
  }
  return owner;
}

/** Only an independently authenticated operator request may mint this async context. */
export async function withAuthenticatedEvolutionOwner<T>(input: {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly secret?: string;
  readonly owner: HostOwner;
}, work: () => Promise<T>): Promise<T> {
  const entries = Object.entries(input.headers).filter(([key]) => key.toLowerCase() === EVOLUTION_OWNER_HEADER);
  const supplied = entries.length === 1 ? entries[0]![1] : undefined;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!input.secret || input.secret.length < 32 || input.secret.length > 4096 ||
      typeof supplied !== "string" || supplied.length > 4096 ||
      !timingSafeEqual(digest(supplied), digest(input.secret)) ||
      !input.owner.tenantId || !input.owner.userId) {
    throw new EvolutionTransportError(403, "EVOLUTION_OWNER_REQUIRED");
  }
  return requests.run(Object.freeze({ tenantId: input.owner.tenantId, userId: input.owner.userId }), work);
}
