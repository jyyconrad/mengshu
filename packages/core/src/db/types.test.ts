import { describe, expect, test } from "vitest";
import {
  DEFAULT_VECTOR_CANDIDATE_LIMIT,
  DatabaseStoreCleanupError,
  isDatabaseStoreCleanupError,
  isDatabaseStoreResult,
  parseDatabaseStoreCleanupError,
  parseDatabaseStoreResult,
  resolveVectorCandidateLimit,
} from "./types.js";

describe("vector candidate pool contract", () => {
  test("uses an explicit default independent from the final result limit", () => {
    expect(resolveVectorCandidateLimit({})).toBe(DEFAULT_VECTOR_CANDIDATE_LIMIT);
    expect(resolveVectorCandidateLimit({ candidateLimit: 37 })).toBe(37);
  });

  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid candidate limit %s",
    (candidateLimit) => {
      expect(() => resolveVectorCandidateLimit({ candidateLimit })).toThrow(/candidateLimit/);
    },
  );
});

const validReceipt = () => ({
  inserted: 1,
  duplicates: 0,
  records: [{ requestedId: "requested-1", persistedId: "persisted-1", stored: true }],
});

describe("database store receipt contract", () => {
  test("accepts a consistent plain-data receipt and neutral cleanup error", () => {
    const receipt = validReceipt();
    const error = new DatabaseStoreCleanupError(receipt, "completed");

    expect(isDatabaseStoreResult(receipt)).toBe(true);
    expect(isDatabaseStoreCleanupError(error)).toBe(true);
  });

  test.each([
    { ...validReceipt(), inserted: 0 },
    { ...validReceipt(), extra: "forged" },
    { ...validReceipt(), records: [{ ...validReceipt().records[0], extra: true }] },
    { ...validReceipt(), records: [{ requestedId: " requested", persistedId: "x", stored: true }] },
  ])("rejects malformed or extended receipt %#", (receipt) => {
    expect(isDatabaseStoreResult(receipt)).toBe(false);
  });

  test("rejects accessor-backed forged fields without invoking business logic", () => {
    let reads = 0;
    const receipt = Object.defineProperties({}, {
      inserted: { enumerable: true, get: () => { reads += 1; return 1; } },
      duplicates: { enumerable: true, value: 0 },
      records: { enumerable: true, value: validReceipt().records },
    });

    expect(isDatabaseStoreResult(receipt)).toBe(false);
    expect(reads).toBe(0);
  });

  test("rejects proxies, symbols and nested proxies without invoking proxy traps", () => {
    let descriptorReads = 0;
    const proxiedReceipt = new Proxy(validReceipt(), {
      getOwnPropertyDescriptor(target, key) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const symbolExtended = Object.assign(validReceipt(), { [Symbol("extra")]: true });
    const nestedProxy = {
      ...validReceipt(),
      records: new Proxy(validReceipt().records, {}),
    };

    expect(parseDatabaseStoreResult(proxiedReceipt)).toBeUndefined();
    expect(descriptorReads).toBe(0);
    expect(parseDatabaseStoreResult(symbolExtended)).toBeUndefined();
    expect(parseDatabaseStoreResult(nestedProxy)).toBeUndefined();
  });

  test("returns a recursively frozen snapshot isolated from later descriptor values", () => {
    const original = validReceipt();
    const parsed = parseDatabaseStoreResult(original);
    expect(parsed).toBeDefined();

    original.records[0]!.persistedId = "changed-after-parse";
    original.records.push({ requestedId: "requested-2", persistedId: "persisted-2", stored: true });

    expect(parsed).toEqual(validReceipt());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.records)).toBe(true);
    expect(Object.isFrozen(parsed!.records[0])).toBe(true);
  });

  test("cleanup error owns an immutable normalized receipt snapshot", () => {
    const original = validReceipt();
    const error = new DatabaseStoreCleanupError(original, "completed");
    original.records[0]!.persistedId = "changed-after-error";

    const parsed = parseDatabaseStoreCleanupError(error);
    expect(parsed?.receipt).toEqual(validReceipt());
    expect(Object.isFrozen(error.receipt)).toBe(true);
    expect(Object.isFrozen(error.receipt.records)).toBe(true);
    expect(() => Object.defineProperty(error, "receipt", { value: original })).toThrow();
    expect(parseDatabaseStoreCleanupError(new Proxy(error, {}))).toBeUndefined();
  });

  test("a forged prototype instance still fails the strict cleanup guard", () => {
    const forged = Object.assign(Object.create(DatabaseStoreCleanupError.prototype), {
      code: "DATABASE_STORE_CLEANUP_FAILED",
      cleanupFailed: true,
      warning: "database_store_cleanup_failed",
      operationStatus: "completed",
      receipt: validReceipt(),
    });
    expect(isDatabaseStoreCleanupError(forged)).toBe(false);
  });
});
