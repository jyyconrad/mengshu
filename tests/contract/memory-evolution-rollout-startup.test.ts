import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { RuntimeHost } from "../../server/runtime-host.js";
import { RuntimeLifecycle } from "../../packages/core/src/runtime/runtime-lifecycle.js";
import { PostgresDurableJobV2RuntimeBundleError } from "../../packages/core/src/db/providers/postgres.js";
import { nativeStartupError, safeNativeBatchDiagnostic, safeNativeStartupSnapshot, startNativeHostWithDiagnostics } from "../fixtures/memory-evolution-rollout/startup-diagnostics.js";

describe("bounded native startup diagnostics, no PG/model/runtime readiness substitutes in live fixture", () => {
  test("all finite native validation, candidate, admission and guard reasons remain visible in the safe projection", () => {
    const files = ["packages/core/src/evolution/schema.ts", "packages/core/src/evolution/proposal-validation.ts", "packages/core/src/lifecycle/candidate-validator.ts",
      "packages/core/src/evolution/governed-writer.ts", "packages/core/src/evolution/batch-service.ts",
      "packages/core/src/evolution/attested-input.ts", "server/evolution-input-budget.ts", "server/evolution-attestation.ts",
      "packages/core/src/evolution/directory-input.ts", "packages/core/src/evolution/proposal-source.ts",
      "packages/core/src/evolution/review-binding.ts", "packages/core/src/evolution/governed-evidence-materializer.ts",
      "packages/core/src/evolution/postgres-related-targets.ts",
      "packages/core/src/lifecycle/admission-decision.ts", "runtime.ts"];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
      const codes = new Set<string>();
      const literals = (node: ts.Node | undefined): void => {
        if (!node) return;
        if (ts.isStringLiteralLike(node) && /^[a-z][a-z0-9_]{0,95}$/.test(node.text)) codes.add(node.text);
        else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(literals);
        else if (ts.isConditionalExpression(node)) { literals(node.whenTrue); literals(node.whenFalse); }
      };
      const visit = (node: ts.Node): void => {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
          const name = node.expression.getText(source);
          if (["reject", "review", "fail", "EvolutionError"].includes(name) || name.endsWith(".reasons.push")) literals(node.arguments[0]);
          if (["rejected", "invalidate", "finish"].includes(name)) literals(node.arguments[1]);
        }
        if (ts.isPropertyAssignment(node) && ["reason", "reasons"].includes(node.name.getText(source))) literals(node.initializer);
        if (ts.isTypeAliasDeclaration(node) && node.name.text === "RejectReason" && ts.isUnionTypeNode(node.type)) {
          for (const child of node.type.types) if (ts.isLiteralTypeNode(child) && ts.isStringLiteral(child.literal)) {
            codes.add(child.literal.text); codes.add(`candidate_${child.literal.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const code of codes) {
        const diagnostic = JSON.parse(safeNativeBatchDiagnostic({ status: "blocked", reasons: [code] },
          [{ operation: "create", status: "rejected", validation: { outcome: "rejected", reasons: [code] } }]));
        expect.soft(diagnostic.reasons[0], `${file}:${code}`).toBe(code);
        expect.soft(diagnostic.proposals[0].validation.reasons, `${file}:${code}`).toEqual([code]);
      }
    }
  });
  test("proposal projection distinguishes quote rejection from host guard refusal without quoting material or authority", () => {
    const access = vi.fn(() => { throw new Error("synthetic-private-proposal"); });
    const proposal = Object.defineProperty({ operation: "create", semanticType: "resource", status: "rejected",
      validation: { outcome: "rejected", reasons: ["quote_mismatch"], contextEligible: false },
      proposedText: "synthetic-private-proposal", quotes: [{ quote: "synthetic-private-proposal" }],
      scope: { userId: "synthetic-private-proposal" }, signature: "synthetic-private-proposal", toJSON: access }, "body", { get: access });
    const diagnostic = safeNativeBatchDiagnostic({ status: "blocked", reasons: ["attestation_transaction_budget_exhausted"] }, [proposal]);
    expect(JSON.parse(diagnostic)).toMatchObject({ reasons: ["attestation_transaction_budget_exhausted"], proposals: [{
      operation: "create", semanticType: "resource", status: "rejected", validation: { outcome: "rejected", reasons: ["quote_mismatch"], contextEligible: false },
    }] });
    expect(diagnostic).not.toMatch(/synthetic-private|scope|signature|proposedText|quotes/);
    expect(access).not.toHaveBeenCalled();
    expect(JSON.parse(safeNativeBatchDiagnostic({}, Array(20).fill(proposal))).proposals).toHaveLength(8);
  });
  test("batch diagnostics retain actual state and budget reasons but never arbitrary report fields or getters", () => {
    const access = vi.fn(() => { throw new Error("synthetic-private-report-data"); });
    const counts = Object.defineProperty({ applied: 0, review: 1 }, "proposed", { get: access });
    const diagnostic = safeNativeBatchDiagnostic({ status: "blocked", reasons: ["attestation_transaction_budget_exhausted",
      "synthetic-private-report-data", ...Array(20).fill("owner_review_required")], counts,
    usage: { llmCalls: 0, bytes: 256, text: "synthetic-private-report-data" }, checkpoint: { text: "synthetic-private-report-data" },
    config: "synthetic-private-report-data", resumable: false, toJSON: access });
    expect(JSON.parse(diagnostic)).toMatchObject({ status: "blocked", counts: { applied: 0, review: 1 }, usage: { llmCalls: 0, bytes: 256 } });
    expect(JSON.parse(diagnostic).reasons).toHaveLength(8);
    expect(diagnostic).toContain("attestation_transaction_budget_exhausted");
    expect(diagnostic).toContain("unclassified_reason");
    expect(diagnostic).not.toMatch(/synthetic-private|checkpoint|config/);
    expect(access).not.toHaveBeenCalled();
  });
  test("exports only allowlisted code/component and snapshot fields, never arbitrary error data", () => {
    const secret = "synthetic-secret-must-not-leak";
    const error = Object.assign(new Error(`connection failed ${secret}`), { code: "42P01", component: "database", config: { apiKey: secret }, body: secret });
    const result = nativeStartupError("host", error, { state: "failed", ready: false, failureCode: "HOST_START_FAILED", config: secret,
      issues: [{ component: secret, code: secret, detail: secret }] }, { state: "failed", ready: false, failure: error, text: secret });
    expect(result.message).toContain('"code":"42P01","component":"database"');
    expect(result.message).toContain('"state":"failed","ready":false');
    expect(result.message).toContain('"component":"unknown_component","code":"unclassified_error"');
    expect(result.message).not.toContain(secret);
    expect(result).not.toHaveProperty("cause");
  });
  test("diagnostics do not invoke provider error getters or stringify hooks", () => {
    const access = vi.fn(() => { throw new Error("getter-secret"); });
    const error = Object.defineProperties({}, { code: { get: access }, message: { get: access }, cause: { get: access }, toJSON: { value: access } });
    expect(safeNativeStartupSnapshot({ state: "failed", ready: false, failure: error }, "runtime"))
      .toEqual({ state: "failed", ready: false, failure: { code: "unclassified_error", component: "runtime" } });
    expect(access).not.toHaveBeenCalled();
  });
  test("aggregate and cyclic failures are bounded and unrecognized codes are never echoed", () => {
    const cause = Object.assign(new Error("secret-url/body"), { code: "UNRECOGNIZED_SECRET" });
    Object.defineProperty(cause, "cause", { value: cause });
    const result = nativeStartupError("host", new AggregateError([cause, new Error("EVOLUTION_SCHEMA_CAPABILITY_UNAVAILABLE")], "secret-body"), {}, {});
    expect(result.message).toContain("EVOLUTION_SCHEMA_CAPABILITY_UNAVAILABLE");
    expect(result.message).not.toMatch(/secret|UNRECOGNIZED_SECRET/);
    expect(result.message.length).toBeLessThan(2000);
  });
  test("real lifecycle/host wrapper retains the original safe failure in diagnostic snapshot", async () => {
    const lifecycle = new RuntimeLifecycle([{ name: "database", start() { throw Object.assign(new Error("synthetic-connection-detail"), { code: "42P01", component: "database" }); } }]);
    const startWorker = vi.fn(() => { throw new Error("worker_must_not_start"); });
    const host = new RuntimeHost({ dependencies: [{ name: "runtime", start: () => lifecycle.start() }], startWorker,
      workerProbeTimeoutMs: 1000, workerStopTimeoutMs: 1000 });
    const assertReady = vi.fn(async () => undefined); // Offline diagnostic transport only, not native bundle readiness proof.
    try {
      await expect(startNativeHostWithDiagnostics(host, { lifecycle, durableJobV2RuntimeBundle: { assertReady } }))
        .rejects.toThrow(/"code":"HOST_START_FAILED".*"failure":\{"code":"42P01","component":"database"\}/);
      expect(assertReady).toHaveBeenCalledOnce();
      expect(startWorker).not.toHaveBeenCalled();
    } finally { await host.stop(); await lifecycle.stop(); }
  });
  test("failed real-readiness preflight is identified before host error wrapping", async () => {
    const start = vi.fn(async () => undefined);
    const assertReady = vi.fn(async () => { throw new PostgresDurableJobV2RuntimeBundleError("DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING"); });
    await expect(startNativeHostWithDiagnostics({ start, snapshot: () => ({ state: "created", ready: false }) }, {
      lifecycle: { snapshot: () => ({ state: "created", ready: false }) }, durableJobV2RuntimeBundle: { assertReady },
    })).rejects.toThrow(/"code":"DURABLE_RUNTIME_SCHEMA_CONTRACT_PENDING","component":"postgres_durable_bundle"/);
    expect(start).not.toHaveBeenCalled();
    expect(assertReady).toHaveBeenCalledOnce();
  });
  test("successful diagnostic preflight still executes host.start exactly once", async () => {
    const calls: string[] = [];
    await startNativeHostWithDiagnostics({ start: async () => { calls.push("host.start"); }, snapshot: () => ({ state: "ready", ready: true }) }, {
      lifecycle: { snapshot: () => ({ state: "ready", ready: true }) },
      durableJobV2RuntimeBundle: { assertReady: async () => { calls.push("bundle.assertReady"); } },
    });
    expect(calls).toEqual(["bundle.assertReady", "host.start"]);
  });
});
