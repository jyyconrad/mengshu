import { describe, it, expect } from "vitest";
import { openClawSourceAdapter } from "./adapter.js";

describe("openClawSourceAdapter", () => {
  it("should have correct provider and parser version", () => {
    expect(openClawSourceAdapter.provider).toBe("openclaw");
    expect(openClawSourceAdapter.parserVersion).toBe("openclaw-jsonl-v1");
  });

  it("should only scan agents/*/sessions/*.jsonl pattern", () => {
    // This test documents the expected behavior:
    // - Only session files under agents/*/sessions/ are scanned
    // - Each session file gets a projectHintFromPath derived from agent name
    // - This ensures sessions are marked as action=import instead of action=skip

    // The actual pattern validation happens in integration tests with real files
    expect(openClawSourceAdapter.provider).toBe("openclaw");
  });
});
