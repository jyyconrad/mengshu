import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";

import { createEmbeddingSpace } from "../../../core/src/domain/embedding-space.js";
import {
  activateEmbeddingSpace,
  inspectEmbeddingSpace,
  registerEmbeddingSpaceCliCommands,
  type EmbeddingSpaceOperatorDeps,
} from "./embedding-space.js";

const runtimeSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  dim: 1536,
  normalization: "none",
});

const otherSpace = createEmbeddingSpace({
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  model: "text-embedding-3-large",
  dim: 3072,
  normalization: "none",
});

const reembeddedSpace = createEmbeddingSpace(runtimeSpace.fingerprint, "reembedded");

function deps(
  overrides: Partial<EmbeddingSpaceOperatorDeps> = {},
): EmbeddingSpaceOperatorDeps {
  return {
    dbType: "postgres",
    runtimeSpace,
    getActive: vi.fn(async () => runtimeSpace),
    registerActive: vi.fn(async () => runtimeSpace),
    ...overrides,
  };
}

describe("embedding space operator", () => {
  test("status reports an exact active descriptor as write-enabled", async () => {
    await expect(inspectEmbeddingSpace(deps())).resolves.toMatchObject({
      status: "active",
      writeMode: "enabled",
      runtimeSpace,
      activeSpace: runtimeSpace,
    });
  });

  test("status reports an empty registry as missing and read-only", async () => {
    await expect(inspectEmbeddingSpace(deps({
      getActive: vi.fn(async () => null),
    }))).resolves.toMatchObject({
      status: "missing",
      writeMode: "read-only",
      activeSpace: undefined,
    });
  });

  test("status reports a different descriptor as mismatch and read-only", async () => {
    await expect(inspectEmbeddingSpace(deps({
      getActive: vi.fn(async () => otherSpace),
    }))).resolves.toMatchObject({
      status: "mismatch",
      writeMode: "read-only",
      activeSpace: otherSpace,
    });
  });

  test("status follows runtime write compatibility for a reembedded active space", async () => {
    await expect(inspectEmbeddingSpace(deps({
      getActive: vi.fn(async () => reembeddedSpace),
    }))).resolves.toMatchObject({
      status: "active",
      writeMode: "enabled",
      activeSpace: reembeddedSpace,
    });
  });

  test("status reports non-Postgres and missing capabilities as unsupported", async () => {
    await expect(inspectEmbeddingSpace(deps({ dbType: "lancedb" }))).resolves.toMatchObject({
      status: "unsupported",
      writeMode: "read-only",
    });
    await expect(inspectEmbeddingSpace(deps({ getActive: undefined }))).resolves.toMatchObject({
      status: "unsupported",
      writeMode: "read-only",
    });
    await expect(inspectEmbeddingSpace(deps({ registerActive: undefined }))).resolves.toMatchObject({
      status: "unsupported",
      writeMode: "read-only",
    });
  });

  test("status fails closed without exposing a provider error", async () => {
    const result = await inspectEmbeddingSpace(deps({
      getActive: vi.fn(async () => {
        throw new Error("password=secret-do-not-print");
      }),
    }));

    expect(result).toMatchObject({ status: "unavailable", writeMode: "read-only" });
    expect(JSON.stringify(result)).not.toContain("secret-do-not-print");
  });

  test("activation requires explicit confirmation before reading or writing", async () => {
    const getActive = vi.fn(async () => null);
    const registerActive = vi.fn(async () => runtimeSpace);

    await expect(activateEmbeddingSpace(deps({ getActive, registerActive }), false))
      .rejects.toThrow(/--confirm/);
    expect(getActive).not.toHaveBeenCalled();
    expect(registerActive).not.toHaveBeenCalled();
  });

  test("activation registers an empty registry with the runtime descriptor", async () => {
    const registerActive = vi.fn(async () => runtimeSpace);

    await expect(activateEmbeddingSpace(deps({
      getActive: vi.fn(async () => null),
      registerActive,
    }), true)).resolves.toMatchObject({
      outcome: "activated",
      activeSpace: runtimeSpace,
    });
    expect(registerActive).toHaveBeenCalledWith(runtimeSpace);
  });

  test("activation is idempotent when the exact descriptor is already active", async () => {
    const registerActive = vi.fn(async () => runtimeSpace);

    await expect(activateEmbeddingSpace(deps({ registerActive }), true)).resolves.toMatchObject({
      outcome: "already-active",
      activeSpace: runtimeSpace,
    });
    expect(registerActive).not.toHaveBeenCalled();
  });

  test("activation treats a compatible reembedded descriptor as already active", async () => {
    const registerActive = vi.fn(async () => runtimeSpace);

    await expect(activateEmbeddingSpace(deps({
      getActive: vi.fn(async () => reembeddedSpace),
      registerActive,
    }), true)).resolves.toMatchObject({
      outcome: "already-active",
      activeSpace: reembeddedSpace,
    });
    expect(registerActive).not.toHaveBeenCalled();
  });

  test("activation refuses mismatch without attempting an overwrite", async () => {
    const registerActive = vi.fn(async () => runtimeSpace);

    await expect(activateEmbeddingSpace(deps({
      getActive: vi.fn(async () => otherSpace),
      registerActive,
    }), true)).rejects.toThrow(/mismatch|refusing/i);
    expect(registerActive).not.toHaveBeenCalled();
  });

  test("activation is unsupported outside Postgres or without registry capabilities", async () => {
    await expect(activateEmbeddingSpace(deps({ dbType: "lancedb" }), true))
      .rejects.toThrow(/unsupported/i);
    await expect(activateEmbeddingSpace(deps({ registerActive: undefined }), true))
      .rejects.toThrow(/unsupported/i);
  });

  test("activation verifies the descriptor returned by the first-registration transaction", async () => {
    await expect(activateEmbeddingSpace(deps({
      getActive: vi.fn(async () => null),
      registerActive: vi.fn(async () => otherSpace),
    }), true)).rejects.toThrow(/mismatch|refusing/i);
  });

  test("activation sanitizes registry read and registration failures", async () => {
    const readFailure = activateEmbeddingSpace(deps({
      getActive: vi.fn(async () => {
        throw new Error("password=read-secret");
      }),
    }), true);
    await expect(readFailure).rejects.toThrow(/registry unavailable/i);
    await expect(readFailure).rejects.not.toThrow(/read-secret/i);

    const registrationFailure = activateEmbeddingSpace(deps({
      getActive: vi.fn(async () => null),
      registerActive: vi.fn(async () => {
        throw new Error("password=write-secret");
      }),
    }), true);
    await expect(registrationFailure).rejects.toThrow(/registry was not changed/i);
    await expect(registrationFailure).rejects.not.toThrow(/write-secret/i);
  });

  test("activation reports a concurrent first-registration winner without exposing provider errors", async () => {
    const getOtherWinner = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(otherSpace);
    const mismatchRace = activateEmbeddingSpace(deps({
      getActive: getOtherWinner,
      registerActive: vi.fn(async () => {
        throw new Error("password=race-secret");
      }),
    }), true);

    await expect(mismatchRace).rejects.toThrow(/mismatch|refusing/i);
    await expect(mismatchRace).rejects.not.toThrow(/race-secret/i);

    const getSameWinner = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(runtimeSpace);
    await expect(activateEmbeddingSpace(deps({
      getActive: getSameWinner,
      registerActive: vi.fn(async () => {
        throw new Error("commit result unknown");
      }),
    }), true)).resolves.toMatchObject({
      outcome: "already-active",
      activeSpace: runtimeSpace,
    });
  });

  test("CLI status and activation output is useful but excludes secret-bearing fields", async () => {
    const lines: string[] = [];
    const operatorDeps = deps({
      runtimeSpace: {
        ...runtimeSpace,
        apiKey: "sk-secret-do-not-print",
      } as typeof runtimeSpace,
      getActive: vi.fn(async () => null),
      writeLine: (line) => lines.push(line),
    });
    const program = new Command().exitOverride();
    registerEmbeddingSpaceCliCommands(program, operatorDeps);

    await program.parseAsync(["node", "ms", "embedding-space", "status"]);

    const output = lines.join("\n");
    expect(output).toContain("Status: missing");
    expect(output).toContain("Write mode: read-only");
    expect(output).toContain(runtimeSpace.embeddingSpaceId);
    expect(output).toContain("text-embedding-3-small");
    expect(output).not.toContain("sk-secret-do-not-print");
    expect(output).not.toContain("apiKey");
  });

  test("CLI activate forwards --confirm and prints an idempotent result", async () => {
    const lines: string[] = [];
    const registerActive = vi.fn(async () => runtimeSpace);
    const program = new Command().exitOverride();
    registerEmbeddingSpaceCliCommands(program, deps({
      registerActive,
      writeLine: (line) => lines.push(line),
    }));

    await program.parseAsync([
      "node",
      "ms",
      "embedding-space",
      "activate",
      "--confirm",
    ]);

    expect(registerActive).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("already-active");
  });
});
