import type {
  AuthorityScopedForgetInput,
  AuthorityScopedForgetResult,
  AuthorityScopedForgetService,
  ForgetTransactionPort,
} from "../domain/service-types.js";
import { isPostgresForgetTransactionPort } from "../db/providers/postgres-forget-transaction.js";

declare const authorityScopedForgetCapabilityBrand: unique symbol;

/** Runtime-minted destructive capability with a module-private runtime brand. */
export interface AuthorityScopedForgetCapability {
  readonly [authorityScopedForgetCapabilityBrand]: true;
  forget(input: AuthorityScopedForgetInput): Promise<AuthorityScopedForgetResult>;
}

const mintedCapabilities = new WeakSet<object>();

/** @internal Only runtime assembly should mint this after obtaining a real port. */
export function createAuthorityScopedForgetCapability(
  service: AuthorityScopedForgetService,
  transactions: ForgetTransactionPort,
): AuthorityScopedForgetCapability {
  if (!isPostgresForgetTransactionPort(transactions)) {
    throw new Error("A real Postgres forget transaction port is required");
  }
  const forget = service.forget.bind(service);
  const capability = Object.freeze({
    forget: (input: AuthorityScopedForgetInput) => forget(input),
  });
  mintedCapabilities.add(capability);
  return capability as AuthorityScopedForgetCapability;
}

export function isAuthorityScopedForgetCapability(
  value: unknown,
): value is AuthorityScopedForgetCapability {
  return typeof value === "object" && value !== null && mintedCapabilities.has(value);
}
