import { describe, expect, it } from "vitest";
import { parseEvolutionProposal, parseEvolutionRunRequest } from "./schema.js";
import { draft, unit } from "./test-fixtures.js";

const request = { input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "request-1" };
describe("evolution closed schemas", () => {
  it("defaults bounded limits without mutating input", () => {
    expect(parseEvolutionRunRequest(request).limits.maxRecords).toBeGreaterThan(0);
    expect(request).not.toHaveProperty("limits");
  });
  it.each(["authority", "scope", "path", "model", "configFingerprint", "apiKey"])("forbids client %s", field => {
    expect(() => parseEvolutionRunRequest({ ...request, [field]: "injected" })).toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1.5, 10000001])("rejects invalid maxBytes %s", maxBytes => {
    expect(() => parseEvolutionRunRequest({ ...request, limits: { maxBytes } })).toThrow();
  });
  it("rejects path escapes and unknown nested limits", () => {
    expect(() => parseEvolutionRunRequest({ ...request, input: { mode: "directory", sourceId: "../private" } })).toThrow();
    expect(() => parseEvolutionRunRequest({ ...request, limits: { tools: ["execute"] } })).toThrow();
  });
  it("accepts zero model calls only as a bounded allowance", () => {
    expect(parseEvolutionRunRequest({ ...request, limits: { maxLlmCalls: 0 } }).limits.maxLlmCalls).toBe(0);
  });
  it.each(["scope", "confidence", "reviewRequirement", "approvedBy", "tools", "__proto__"])("rejects model field %s", field => {
    expect(() => parseEvolutionProposal({ ...draft(unit()), [field]: "owner" })).toThrow();
  });
  it("checks operation combinations and bounds", () => {
    expect(() => parseEvolutionProposal({ ...draft(unit()), operation: "execute_script" })).toThrow();
    expect(() => parseEvolutionProposal({ ...draft(unit()), operation: "correct" })).toThrow();
    expect(() => parseEvolutionProposal({ ...draft(unit()), quotes: [{ evidenceId: "e", quote: "a", start: 2, end: 1 }] })).toThrow();
    expect(() => parseEvolutionProposal({ ...draft(unit()), proposedText: "a".repeat(8193) })).toThrow();
  });
});
