import { describe, expect, test, vi } from "vitest";
import type {
  AuthorityScopedForgetService,
  ForgetTransactionPort,
} from "../domain/service-types.js";
import {
  createAuthorityScopedForgetCapability,
  isAuthorityScopedForgetCapability,
} from "./authority-forget-capability.js";
import { PostgresForgetTransactionPort } from "../db/providers/postgres-forget-transaction.js";

function realTestPort(): PostgresForgetTransactionPort {
  return new PostgresForgetTransactionPort({
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => undefined,
    }),
  });
}

describe("authority-scoped forget capability", () => {
  test("rejects structurally identical services that were not minted by the runtime boundary", () => {
    const fake = { forget: vi.fn() };

    expect(isAuthorityScopedForgetCapability(fake)).toBe(false);
  });

  test("mints a frozen opaque capability only from an explicit transaction assembly", async () => {
    const service: AuthorityScopedForgetService = {
      forget: vi.fn(async () => ({
        action: "delete" as const,
        affected: 0,
        deleted: 0,
        affectedIds: [],
        transactional: true as const,
        idempotentReplay: false,
      })),
    };
    const transactions: ForgetTransactionPort = realTestPort();

    const capability = createAuthorityScopedForgetCapability(service, transactions);

    expect(isAuthorityScopedForgetCapability(capability)).toBe(true);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(capability).not.toBe(service);
    await capability.forget({} as never);
    expect(service.forget).toHaveBeenCalledTimes(1);
  });

  test("rejects a plain transaction duck even when it exposes transaction()", () => {
    const service: AuthorityScopedForgetService = {
      forget: vi.fn(),
    };
    const fake: ForgetTransactionPort = {
      transaction: vi.fn(),
    };

    expect(() => createAuthorityScopedForgetCapability(service, fake))
      .toThrow(/real postgres forget transaction port/i);
  });
});
