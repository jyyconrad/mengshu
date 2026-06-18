import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { codexSourceAdapter } from "./codex/adapter.js";
import { claudeCodeSourceAdapter } from "./claude-code/adapter.js";
import { openClawSourceAdapter } from "./openclaw/adapter.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mengshu-sources-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("source adapters", () => {
  test("codex adapter discovers JSONL files, skips bad lines and redacts secrets", async () => {
    const sessions = join(dir, "sessions", "2026");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "session-1.jsonl");
    writeFileSync(file, [
      JSON.stringify({
        role: "user",
        content: "Remember my token sk-123456789012345678901234567890 and prefer concise replies",
        cwd: "/repo/project-a",
        timestamp: "2026-06-17T10:00:00.000Z",
      }),
      "{not-json",
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Done" }] }),
    ].join("\n"));

    const discovered = await codexSourceAdapter.discover({ sourceRoot: dir });
    expect(discovered.files).toEqual([file]);

    const parsed = await codexSourceAdapter.parseFile(file, {});
    expect(parsed.badLines).toBe(1);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]).toMatchObject({
      provider: "codex",
      sourceKind: "session",
      role: "user",
      cwd: "/repo/project-a",
      redactedCount: 1,
    });
    expect(parsed.events[0].text).toContain("[REDACTED:api_key]");
    expect(parsed.events[0].metadata.redactionCategories).toEqual(["api_key"]);
  });

  test("claude-code adapter derives project hints from project path", async () => {
    const projectDir = join(dir, "projects", "-Users-me-work-demo");
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", message: { content: "We decided to use React" } }));

    const discovered = await claudeCodeSourceAdapter.discover({ sourceRoot: dir });
    expect(discovered.files).toEqual([file]);
    const parsed = await claudeCodeSourceAdapter.parseFile(file, {});
    expect(parsed.events[0].provider).toBe("claude-code");
    expect(parsed.events[0].projectRootHint).toContain("Users");
  });

  test("openclaw adapter parses content arrays without writing data", async () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.jsonl");
    writeFileSync(file, JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "My email is user@example.com" }],
      sessionId: "session-1",
    }));

    const parsed = await openClawSourceAdapter.parseFile(file, {});
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      provider: "openclaw",
      sessionId: "session-1",
      text: "My email is user@example.com",
    });
  });
});
