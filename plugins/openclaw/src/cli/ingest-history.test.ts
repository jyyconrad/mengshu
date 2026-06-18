import { describe, expect, test, vi } from "vitest";
import type {
  SourceAdapter,
  SourceAdapterContext,
} from "../../ingest/agent-history/types.js";
import {
  buildHistoryDryRunReport,
  registerIngestHistoryCommand,
} from "./cli-ingest-history.js";

class FakeCommand {
  subcommands: FakeCommand[] = [];
  options: Array<[string, string, unknown?]> = [];
  actionHandler?: (...args: unknown[]) => unknown;

  constructor(public readonly name: string) {}

  command(name: string) {
    const child = new FakeCommand(name);
    this.subcommands.push(child);
    return child;
  }

  description() {
    return this;
  }

  option(flag: string, description: string, defaultValue?: unknown) {
    this.options.push([flag, description, defaultValue]);
    return this;
  }

  action(handler: (...args: unknown[]) => unknown) {
    this.actionHandler = handler;
    return this;
  }

  find(name: string): FakeCommand | undefined {
    return this.subcommands.find((command) => command.name === name || command.name.startsWith(`${name} `));
  }
}

function fakeAdapter(): SourceAdapter {
  return {
    provider: "codex",
    parserVersion: "test",
    discover: async (_ctx: SourceAdapterContext) => ({
      provider: "codex",
      rootExists: true,
      resolvedRoot: "/tmp/codex",
      files: ["/tmp/codex/session.jsonl"],
    }),
    parseFile: async () => ({
      sourcePath: "/tmp/codex/session.jsonl",
      sourceHash: "hash",
      badLines: 1,
      events: [
        {
          id: "event-1",
          provider: "codex",
          sourceKind: "session",
          sourceHash: "hash",
          sourcePath: "/tmp/codex/session.jsonl",
          sessionId: "s1",
          cwd: "/repo/project-a",
          role: "user",
          text: "I prefer concise replies",
          redactedCount: 2,
          metadata: {},
        },
      ],
    }),
  };
}

describe("ms project ingest-history", () => {
  test("builds dry-run report without writing memories", async () => {
    const report = await buildHistoryDryRunReport({
      providers: ["codex"],
      adapters: [fakeAdapter()],
      ctx: {},
    });

    expect(report).toMatchObject({
      providers: ["codex"],
      sourceFiles: 1,
      sessionsMatched: 1,
      estimatedChunks: 1,
      redactedHits: 2,
    });
    expect(report.candidateEstimates.profile).toBe(1);
    expect(report.parseErrors).toEqual([
      { sourcePath: "/tmp/codex/session.jsonl", error: "1 bad JSONL lines skipped" },
    ]);
  });

  test("registers dry-run command and rejects apply", async () => {
    const project = new FakeCommand("project");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      registerIngestHistoryCommand(project as never, { adapters: [fakeAdapter()] });
      const command = project.find("ingest-history");
      expect(command).toBeDefined();
      await command?.actionHandler?.({ from: "codex", apply: true });
      expect(logs.join("\n")).toContain("--apply 尚未支持");
    } finally {
      console.log = originalLog;
    }
  });

  test("command prints dry-run summary", async () => {
    const project = new FakeCommand("project");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message));
    };
    try {
      registerIngestHistoryCommand(project as never, { adapters: [fakeAdapter()] });
      await project.find("ingest-history")?.actionHandler?.({ from: "codex" });
      expect(logs.join("\n")).toContain("Agent history dry-run");
      expect(logs.join("\n")).toContain("source files: 1");
    } finally {
      console.log = originalLog;
    }
  });
});
