import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";
import { registerEvolutionCliCommands } from "./evolve.js";
import { parseEvolutionGovernanceRequest } from "../evolution-control.js";

function fixture() {
  const invoke = vi.fn().mockResolvedValue({ batchId: "batch-one", status: "completed" });
  const output = vi.fn();
  const program = new Command().exitOverride().configureOutput({
    writeOut: () => undefined, writeErr: () => undefined,
  });
  registerEvolutionCliCommands(program, { client: { invoke }, output });
  return { invoke, output, run: (args: string[]) => program.parseAsync(args, { from: "user" }) };
}

describe("ms evolve", () => {
  test("governance controls forward the exact three-method contract without model budgets or authority", async () => {
    const hash = "a".repeat(64);
    const requests = [
      { command: "control", operation: "control/run" as const, body: { input: { mode: "control", work: { kind: "source_reconcile", sourceId: "notes" } }, action: "execute_control", idempotencyKey: "control" } },
      { command: "undo-approve", operation: "control/undo-approve" as const, body: { operationReceiptId: hash, currentStateHash: hash,
        expectedRevision: 0, idempotencyKey: "approve", operationIdempotencyKey: "undo", expiresAt: 1000 } },
    ];
    for (const row of requests) {
      const f = fixture(); await f.run(["evolve", row.command, "--request", JSON.stringify(row.body)]);
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith({ method: "POST", path: `/v1/evolution/${row.operation}`,
        body: parseEvolutionGovernanceRequest(row.operation, row.body) });
      expect(f.output).toHaveBeenCalledOnce();
      for (const body of [{ ...row.body, handler: "build_tree" }, { ...row.body, authority: "owner" }, "not-json", "x".repeat(20_000)]) {
        const bad = fixture(); await expect(bad.run(["evolve", row.command, "--request", typeof body === "string" ? body : JSON.stringify(body)])).rejects.toThrow();
        expect(bad.invoke).not.toHaveBeenCalled();
      }
    }
    const f = fixture(); await f.run(["evolve", "undo-preview", hash]);
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith({ method: "POST", path: "/v1/evolution/control/undo-preview", body: { operationReceiptId: hash } });
    for (const args of [["undo-preview", "../private"], ["undo-preview", hash, "--model", "other"],
      ["control", "--request", "{}", "--handler", "build_tree"], ["undo-approve"]]) {
      const bad = fixture(); await expect(bad.run(["evolve", ...args])).rejects.toThrow(); expect(bad.invoke).not.toHaveBeenCalled();
    }
  });
  test("signed source and reuse control proxy exact typed requests without local runtime creation", async () => {
    const grants = { expectedRevision: 0, idempotencyKey: "grant-one", grants: [] };
    const revoke = { sourceId: "notes", sourceRevision: "r1", expectedRevision: 0, idempotencyKey: "revoke-one",
      operationIdempotencyKey: "revoke-operation", expiresAt: 1000 };
    for (const [args, operation, body] of [
      [["reuse-status"], "reuse/status", {}],
      [["reuse-evaluate", "plan-one"], "reuse/evaluate", { planId: "plan-one" }],
      [["reuse-grants", "--request", JSON.stringify(grants)], "reuse/grants", grants],
      [["source-revoke-attestation", "--request", JSON.stringify(revoke)], "source/revoke-attestation", revoke],
    ] as const) {
      const f = fixture(); await f.run(["evolve", ...args]);
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith({ method: "POST", path: `/v1/evolution/${operation}`, body });
    }
    for (const args of [["reuse-evaluate", "plan", "--model", "other"],
      ["reuse-grants", "--request", JSON.stringify({ ...grants, accepted: true })],
      ["source-revoke-attestation", "--request", JSON.stringify({ ...revoke, path: "/private" })],
      ["source-attest", "--request", "{}"], ["source-attest", "--request", "not-json"]]) {
      const f = fixture(); await expect(f.run(["evolve", ...args])).rejects.toThrow();
      expect(f.invoke).not.toHaveBeenCalled();
    }
  });
  test("owner proposal inventory is bounded and rejects client authority and source paths", async () => {
    const f = fixture();
    await f.run(["evolve", "proposals", "--batch-id", "batch-1", "--status", "review", "--limit", "12"]);
    expect(f.invoke).toHaveBeenCalledWith({ method: "POST", path: "/v1/evolution/review/list", body: {
      batchId: "batch-1", status: "review", limit: 12,
    } });
    await f.run(["evolve", "proposal", "proposal-1"]);
    expect(f.invoke).toHaveBeenLastCalledWith({ method: "POST", path: "/v1/evolution/review/detail", body: { proposalId: "proposal-1" } });
    for (const args of [["--limit", "51"], ["--status", "approved"], ["--scope", "other"], ["--path", "/private"]]) {
      const invalid = fixture();
      await expect(invalid.run(["evolve", "proposals", ...args])).rejects.toThrow();
      expect(invalid.invoke).not.toHaveBeenCalled();
    }
  });
  test("background control is a host proxy with explicit mode, batch allowlist and revision", async () => {
    const f = fixture();
    await f.run(["evolve", "background"]);
    expect(f.invoke).toHaveBeenCalledWith({ method: "GET", path: "/v1/runtime/background" });
    const revision = "11111111-1111-4111-8111-111111111111";
    await f.run(["evolve", "background", "--mode", "evolution_only", "--expected-revision", revision, "--batch-id", "batch-one"]);
    expect(f.invoke).toHaveBeenLastCalledWith({ method: "POST", path: "/v1/runtime/background", body: {
      mode: "evolution_only", expectedRevision: revision, allowedBatchIds: ["batch-one"],
    } });
    for (const args of [["--mode", "all"], ["--mode", "evolution_only", "--expected-revision", revision],
      ["--mode", "paused", "--expected-revision", revision, "--handler", "build_tree"]]) {
      const invalid = fixture();
      await expect(invalid.run(["evolve", "background", ...args])).rejects.toThrow();
      expect(invalid.invoke).not.toHaveBeenCalled();
    }
  });
  test("defaults inventory to preview and sends no authority or model", async () => {
    const f = fixture();
    await f.run(["evolve", "inventory"]);
    expect(f.invoke).toHaveBeenCalledWith({
      method: "POST", path: "/v1/evolution/run", body: {
        input: { mode: "inventory", selection: "baseline" }, action: "preview",
        idempotencyKey: expect.any(String),
      },
    });
    expect(f.output).toHaveBeenCalledWith({ batchId: "batch-one", status: "completed" });
  });

  test("validates action exclusivity and bounded integers before invoking", async () => {
    for (const args of [
      ["--dry-run", "--propose"], ["--propose", "--apply-allowed"],
      ["--max-records", "0"], ["--max-records", "1.5"], ["--max-records", "101"],
      ["--selection", "all"], ["--model", "untrusted"], ["--tenant-id", "other"],
    ]) {
      const f = fixture();
      await expect(f.run(["evolve", "inventory", ...args])).rejects.toThrow();
      expect(f.invoke).not.toHaveBeenCalled();
    }
  });

  test("passes propose limits and a caller retry key", async () => {
    const f = fixture();
    await f.run(["evolve", "inventory", "--propose", "--selection", "baseline",
      "--max-records", "12", "--idempotency-key", "operator-one"]);
    expect(f.invoke).toHaveBeenCalledWith({ method: "POST", path: "/v1/evolution/run", body: {
      input: { mode: "inventory", selection: "baseline" }, action: "propose",
      idempotencyKey: "operator-one", limits: { maxRecords: 12 },
    } });
  });

  test("directory requests require a sourceId and cannot supply a remote path", async () => {
    const f = fixture();
    await f.run(["evolve", "scan", "--source-id", "notes", "--apply-allowed"]);
    expect(f.invoke).toHaveBeenCalledWith({ method: "POST", path: "/v1/evolution/run", body: {
      input: { mode: "directory", sourceId: "notes" }, action: "apply_allowed",
      idempotencyKey: expect.any(String),
    } });
    const invalid = fixture();
    await expect(invalid.run(["evolve", "scan"])).rejects.toThrow();
    expect(invalid.invoke).not.toHaveBeenCalled();
    await expect(fixture().run(["evolve", "scan", "/tmp/arbitrary", "--source-id", "notes"]))
      .rejects.toThrow();
    await expect(fixture().run(["evolve", "scan", "--source-id", "notes:private"]))
      .rejects.toThrow();
  });

  test("status/resume use bounded batch IDs without scope overrides", async () => {
    for (const operation of ["status", "resume"]) {
      const f = fixture();
      await f.run(["evolve", operation, "batch:one"]);
      expect(f.invoke).toHaveBeenCalledWith({
        method: "POST", path: `/v1/evolution/${operation}`, body: { batchId: "batch:one" },
      });
      const invalid = fixture();
      await expect(invalid.run(["evolve", operation, "../other"])).rejects.toThrow();
      expect(invalid.invoke).not.toHaveBeenCalled();
    }
  });

  test("owner review commands forward only exact IDs and binding hashes", async () => {
    const hash = "a".repeat(64);
    for (const [args, path, body] of [
      [["review", "proposal-1"], "review/preview", { proposalId: "proposal-1" }],
      [["apply", "approval-1"], "review/apply", { approvalReceiptId: "approval-1" }],
      [["cancel", "batch-1"], "cancel", { batchId: "batch-1" }],
      [["approve", "review-1", "--binding-hash", hash, "--idempotency-key", "approve-1"], "review/decide", { reviewId: "review-1", expectedBindingHash: hash, decision: "approve", idempotencyKey: "approve-1" }],
    ] as const) {
      const f = fixture();
      await f.run(["evolve", ...args]);
      expect(f.invoke).toHaveBeenCalledWith({ method: "POST", path: `/v1/evolution/${path}`, body });
    }
    for (const args of [["approve", "r"], ["apply", "a", "--actor", "owner"], ["review", "p", "--path", "/private"]]) {
      const f = fixture();
      await expect(f.run(["evolve", ...args])).rejects.toThrow();
      expect(f.invoke).not.toHaveBeenCalled();
    }
  });
});
