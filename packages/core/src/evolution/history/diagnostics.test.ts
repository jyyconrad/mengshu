import { describe, expect, test, vi } from "vitest";
import { AuthorityScopeError } from "../../domain/authority-scope.js";
import { HistoryNativeDiagnostics, HistoryNativeReadVerificationError, historyDiagnosticCode, reportHistoryDiagnostic, type HistoryDiagnostic } from "./diagnostics.js";
import type { HistoryPgClient } from "./postgres-read.js";

describe("history allowlisted native diagnostics", () => {
  test("reports authority/transaction codes without message, field, detail or stack", () => {
    const events: HistoryDiagnostic[] = [];
    reportHistoryDiagnostic(event => { events.push(event); }, "evidence", "native-apply", new AuthorityScopeError("CLIENT_FIELD_FORBIDDEN", "private scope detail", "private field"));
    expect(events).toEqual([{ schema: "mengshu.history-p16-diagnostic/v1", phase: "evidence", stage: "native-apply", code: "CLIENT_FIELD_FORBIDDEN" }]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(historyDiagnosticCode({ code: "MEMORY_WRITE_TX_MUTATION_FAILED_23502" })).toBe("MEMORY_WRITE_TX_MUTATION_FAILED_23502");
  });

  test("unknown error properties and runtime labels cannot become a data channel", () => {
    const observer = vi.fn();
    reportHistoryDiagnostic(observer, "private phase" as "evidence", "private stage" as "native-apply", { code: "HISTORY_PRIVATE_BODY", column: "private column", detail: "private body", message: "private message" }, "private receipt" as "missing");
    expect(observer).toHaveBeenCalledExactlyOnceWith({ schema: "mengshu.history-p16-diagnostic/v1", phase: "operator", stage: "database-query", code: "HISTORY_DIAGNOSTIC_REDACTED" });
    const getter = vi.fn(() => "secret"), error = Object.defineProperties({}, { code: { get: getter }, column: { get: getter }, message: { get: getter }, stack: { get: getter } });
    reportHistoryDiagnostic(observer, "evidence", "native-apply", error);
    expect(getter).not.toHaveBeenCalled();
    expect(historyDiagnosticCode(Object.create({ code: "CLIENT_FIELD_FORBIDDEN" }))).toBe("HISTORY_DIAGNOSTIC_REDACTED");
  });

  test("observes known query stage/SQLSTATE/column but rethrows the identical failure without replay", async () => {
    const events: HistoryDiagnostic[] = [], diagnostics = new HistoryNativeDiagnostics(event => { events.push(event); });
    const error = { code: "23502", column: "vector", detail: "private row content", query: "private sql" };
    const query = vi.fn(async () => { throw error; });
    const client = diagnostics.client({ query, release() {} });
    await expect(diagnostics.run("evidence", "native-apply", () => client.query("/* history:native-raw-insert */ PRIVATE SQL", ["private parameter"])) ).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { schema: "mengshu.history-p16-diagnostic/v1", phase: "evidence", stage: "native-raw-insert", code: "HISTORY_DATABASE_ERROR", sqlState: "23502", column: "vector" },
      { schema: "mengshu.history-p16-diagnostic/v1", phase: "evidence", stage: "native-apply", code: "HISTORY_DATABASE_ERROR", sqlState: "23502", column: "vector" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
  });

  test("passes query results and release through unchanged, emitting nothing on success", async () => {
    const observer = vi.fn(), rows = { rows: [{ id: "synthetic" }], rowCount: 1 }, query = vi.fn(async () => rows), release = vi.fn();
    const client = new HistoryNativeDiagnostics(observer).client({ query, release } as unknown as HistoryPgClient);
    expect(await client.query("SELECT $1", ["synthetic"])).toBe(rows);
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT $1", ["synthetic"]);
    client.release(); expect(release).toHaveBeenCalledTimes(1); expect(observer).not.toHaveBeenCalled();
  });

  test("observer exceptions or rejected promises never change transaction errors", async () => {
    const error = { code: "40001" };
    for (const observer of [() => { throw new Error("observer"); }, async () => { throw new Error("observer"); }]) {
      const diagnostics = new HistoryNativeDiagnostics(observer);
      await expect(diagnostics.run("activate", "native-apply", async () => { throw error; })).rejects.toBe(error);
    }
  });

  test("restores phase after failure and never emits arbitrary SQL tags", async () => {
    const events: HistoryDiagnostic[] = [], diagnostics = new HistoryNativeDiagnostics(event => { events.push(event); });
    const client = diagnostics.client({ query: async () => { throw { code: "42P01", column: "unknown column" }; }, release() {} });
    await expect(diagnostics.run("archive", "native-apply", () => client.query("BEGIN ISOLATION LEVEL SERIALIZABLE"))).rejects.toEqual({ code: "42P01", column: "unknown column" });
    await expect(client.query("/* history:private-body */ SELECT private_body")).rejects.toMatchObject({ code: "42P01" });
    expect(events[0]).toMatchObject({ phase: "archive", stage: "transaction-begin" });
    expect(events.at(-1)).toEqual({ schema: "mengshu.history-p16-diagnostic/v1", phase: "operator", stage: "database-query", code: "HISTORY_DATABASE_ERROR", sqlState: "42P01" });
  });

  test("native read errors retain the code and expose only bounded fixed failed-check names in JSON reports", () => {
    const error = new HistoryNativeReadVerificationError("activate", { unitIdentity: true, receiptIdentity: true, exactScope: true, confidenceNotIncreased: false, canonicalIdentityPreserved: true, evidenceRead: true, currentRead: false, lookupRead: false, contextRead: true, evidenceRoots: true });
    expect(error.code).toBe("HISTORY_NATIVE_READ_VERIFICATION_FAILED");
    expect(error.message).toBe("HISTORY_NATIVE_READ_VERIFICATION_FAILED phase=activate failed=confidenceNotIncreased,currentRead,lookupRead");
    expect(Object.isFrozen(error.failedChecks)).toBe(true);
    const observer = vi.fn(); reportHistoryDiagnostic(observer, "activate", "native-read-verification", error);
    expect(observer).toHaveBeenCalledExactlyOnceWith({ schema: "mengshu.history-p16-diagnostic/v1", phase: "activate", stage: "native-read-verification", code: error.code, failedChecks: ["confidenceNotIncreased", "currentRead", "lookupRead"] });
    expect(Object.isFrozen(observer.mock.calls[0][0].failedChecks)).toBe(true);
  });

  test("diagnostic failedChecks ignore arbitrary labels, getters, duplicates and over-budget data", () => {
    const getter = vi.fn(() => "private getter"), checks = ["private body", "currentRead", "currentRead"];
    Object.defineProperty(checks, "3", { get: getter });
    Object.defineProperty(checks, "20", { get: getter });
    const observer = vi.fn();
    reportHistoryDiagnostic(observer, "activate", "native-read-verification", { code: "HISTORY_NATIVE_READ_VERIFICATION_FAILED", failedChecks: checks, message: "private row" });
    expect(observer.mock.calls[0][0].failedChecks).toEqual(["currentRead"]);
    expect(JSON.stringify(observer.mock.calls)).not.toContain("private"); expect(getter).not.toHaveBeenCalled();
  });
});
