import { describe, expect, test, vi } from "vitest";
import {
  MemoryWriteKernel,
  WriteKernelError,
  type MemoryWriteCommand,
  type MemoryWriteKernelDependencies,
} from "./write-kernel.js";
import type {
  MemoryWriteReceipt,
  WriteIdempotencyIdentity,
} from "./write-kernel-transaction.js";
import {
  createMemoryWriteReceipt,
  createWriteCommandFingerprint,
  createWriteIdempotencyIdentity,
} from "./write-kernel-transaction.js";

const scope = {
  tenantId: "server-tenant",
  userId: "server-user",
  appId: "mengshu",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private" as const,
};

const baseCommand = {
  idempotencyKey: "write-default",
  serverAuthority: { tenantId: "server-tenant", userId: "server-user" },
  clientScope: {
    appId: "mengshu",
    projectId: "project-1",
    agentId: "agent-1",
    namespace: "memories",
    visibility: "private",
  },
  text: "User explicitly prefers concise answers",
  kind: "preference" as const,
  metadata: { source: "user" },
} as const;

function saveCommand(overrides: Partial<MemoryWriteCommand> = {}): MemoryWriteCommand {
  return { type: "saveExplicit", ...baseCommand, ...overrides } as MemoryWriteCommand;
}

function harness(
  overrides: Partial<MemoryWriteKernelDependencies> = {},
  transactionFaults: {
    receipt?: Error;
    commit?: Error;
    winnerOnSecond?: MemoryWriteReceipt;
  } = {},
) {
  const calls: string[] = [];
  let inTransaction = false;
  const receipts = new Map<string, MemoryWriteReceipt>();
  const durableMutations: string[] = [];
  const writtenRecords: unknown[] = [];
  let transactionCount = 0;
  const deps: MemoryWriteKernelDependencies = {
    resolveAuthority: async () => {
      calls.push("resolveAuthority");
      return scope;
    },
    normalize: async ({ command }) => {
      calls.push("normalize");
      return {
        text: "text" in command ? command.text.trim() : "",
        metadata: { ...(command.metadata ?? {}), redacted: true },
        promptRisk: false,
      };
    },
    embeddingGuard: async () => {
      calls.push("embeddingGuard");
      return { ok: true };
    },
    embed: async () => {
      calls.push("embed");
      return [0.1, 0.2, 0.3];
    },
    validate: async ({ normalized }) => {
      calls.push("validator");
      return { accepted: true, candidate: { text: normalized.text } };
    },
    scoreAdmission: async () => {
      calls.push("scoreAdmission");
      return { route: "active", valueScore: 0.95 };
    },
    scoreImportance: async () => {
      calls.push("scoreImportance");
      return 0.73;
    },
    exactDedup: async () => {
      calls.push("exactDedup");
      return { duplicate: false };
    },
    semanticDedup: async () => {
      calls.push("semanticDedup");
      return { duplicate: false };
    },
    transaction: async (work) => {
      transactionCount += 1;
      const currentTransaction = transactionCount;
      calls.push("transaction:start");
      inTransaction = true;
      const stagedMutations: string[] = [];
      let stagedReceipt: MemoryWriteReceipt | undefined;
      try {
        const result = await work({
          getReceipt: async (identity: WriteIdempotencyIdentity) => {
            expect(inTransaction).toBe(true);
            calls.push("receipt:get");
            if (currentTransaction === 2 && transactionFaults.winnerOnSecond) {
              receipts.set(identity.storageKey, transactionFaults.winnerOnSecond);
              return transactionFaults.winnerOnSecond;
            }
            return receipts.get(identity.storageKey);
          },
          saveReceipt: async (receipt: MemoryWriteReceipt) => {
            expect(inTransaction).toBe(true);
            calls.push("receipt:save");
            if (transactionFaults.receipt) throw transactionFaults.receipt;
            stagedReceipt = receipt;
          },
          writeMemory: async (memory: { id: string }) => {
            expect(inTransaction).toBe(true);
            calls.push("memory");
            stagedMutations.push("memory");
            writtenRecords.push(structuredClone(memory));
            return { memoryId: memory.id, stored: true };
          },
          appendAudit: async () => {
            expect(inTransaction).toBe(true);
            calls.push("audit");
          },
          appendOutbox: async () => {
            expect(inTransaction).toBe(true);
            calls.push("outbox");
          },
        } as never);
        if (transactionFaults.commit && currentTransaction === 2) throw transactionFaults.commit;
        durableMutations.push(...stagedMutations);
        if (stagedReceipt) receipts.set(stagedReceipt.identity.storageKey, stagedReceipt);
        return result;
      } finally {
        inTransaction = false;
        calls.push("transaction:end");
      }
    },
    ack: async ({ committedReceipt }) => {
      calls.push("ack");
      expect(receipts.get(committedReceipt.identity.storageKey)).toEqual(committedReceipt);
    },
    createId: () => "memory-1",
    now: () => 1_720_000_000_000,
    ...overrides,
  };
  return {
    kernel: new MemoryWriteKernel(deps),
    calls,
    deps,
    receipts,
    durableMutations,
    writtenRecords,
    isInTransaction: () => inTransaction,
  };
}

describe("MemoryWriteKernel", () => {
  test("executes the successful write pipeline in strict order", async () => {
    const { kernel, calls } = harness();

    await expect(kernel.execute(saveCommand())).resolves.toMatchObject({
      status: "persisted",
      route: "active",
      memoryId: "memory-1",
    });
    expect(calls).toEqual([
      "resolveAuthority",
      "transaction:start",
      "receipt:get",
      "transaction:end",
      "normalize",
      "embeddingGuard",
      "embed",
      "validator",
      "scoreAdmission",
      "scoreImportance",
      "exactDedup",
      "semanticDedup",
      "transaction:start",
      "receipt:get",
      "memory",
      "audit",
      "outbox",
      "receipt:save",
      "transaction:end",
      "ack",
    ]);
  });

  test("computes importance independently from valueScore and persists both scores", async () => {
    const writeMemory = vi.fn(async (memory: { id: string }) => ({
      memoryId: memory.id,
      stored: true,
    }));
    const { kernel } = harness({
      scoreAdmission: async () => ({ route: "active", valueScore: 0.91 }),
      scoreImportance: async () => 0.37,
      transaction: async (work) => work({
        getReceipt: async () => undefined,
        saveReceipt: async () => undefined,
        writeMemory,
        appendAudit: async () => undefined,
        appendOutbox: async () => undefined,
      }),
      ack: async () => undefined,
    });

    await kernel.execute(saveCommand());

    expect(writeMemory).toHaveBeenCalledWith(expect.objectContaining({
      valueScore: 0.91,
      importance: 0.37,
    }));
  });

  test("candidate persistence returns candidateId while preserving memoryId compatibility", async () => {
    const appendAudit = vi.fn(async () => undefined);
    const appendOutbox = vi.fn(async () => undefined);
    const { kernel } = harness({
      scoreAdmission: async () => ({ route: "candidate", valueScore: 0.71 }),
      transaction: async (work) => work({
        getReceipt: async () => undefined,
        saveReceipt: async () => undefined,
        writeMemory: async (memory) => ({
          recordType: "candidate",
          candidateId: memory.id,
          memoryId: memory.id,
          stored: true,
        }),
        appendAudit,
        appendOutbox,
      }),
      ack: async () => undefined,
    });

    await expect(kernel.execute(saveCommand())).resolves.toMatchObject({
      status: "persisted",
      route: "candidate",
      recordType: "candidate",
      candidateId: "memory-1",
      memoryId: "memory-1",
    });
    expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "candidate.write",
      recordType: "candidate",
      memoryId: "memory-1",
    }));
    expect(appendOutbox).toHaveBeenCalledWith(expect.objectContaining({
      topic: "candidate.written",
      recordType: "candidate",
      memoryId: "memory-1",
    }));
  });

  test.each(["lookup_only", "evidence_only"] as const)(
    "%s persists as recordType memory",
    async (route) => {
      const { kernel } = harness({
        scoreAdmission: async () => ({ route, valueScore: 0.6 }),
      });
      await expect(kernel.execute(saveCommand())).resolves.toMatchObject({
        status: "persisted",
        route,
        recordType: "memory",
        memoryId: "memory-1",
      });
    },
  );

  test("persists the validated governance snapshot instead of discarding native memory semantics", async () => {
    const writeMemory = vi.fn(async (memory: { id: string }) => ({
      memoryId: memory.id,
      stored: true,
    }));
    const governance = Object.freeze({
      text: baseCommand.text,
      semanticType: "rules",
      kind: "preference",
      confidence: 0.91,
      evidenceIds: Object.freeze(["event-1"]),
      riskFlags: Object.freeze(["sensitive"]),
      profileDimension: undefined,
      targetScope: "project",
    });
    const { kernel } = harness({
      validate: async () => ({ accepted: true, candidate: governance }),
      scoreAdmission: async () => ({
        route: "candidate",
        valueScore: 0.72,
        reason: "medium_value_score",
        breakdown: Object.freeze({ explicitness: 0.8, durability: 0.7 }),
      }),
      transaction: async (work) => work({
        getReceipt: async () => undefined,
        saveReceipt: async () => undefined,
        writeMemory,
        appendAudit: async () => undefined,
        appendOutbox: async () => undefined,
      }),
      ack: async () => undefined,
    });

    await kernel.execute(saveCommand());

    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(writeMemory).toHaveBeenCalledWith(expect.objectContaining({
      governance: {
        candidate: governance,
        admissionReason: "medium_value_score",
        admissionBreakdown: { explicitness: 0.8, durability: 0.7 },
      },
    }));
  });

  test("uses the provider-resolved duplicate id and does not fabricate a second audit/outbox event", async () => {
    const appendAudit = vi.fn(async () => undefined);
    const appendOutbox = vi.fn(async () => undefined);
    let committedReceipt: MemoryWriteReceipt | undefined;
    const { kernel } = harness({
      transaction: async (work) => work({
        getReceipt: async () => undefined,
        saveReceipt: async (receipt) => {
          committedReceipt = receipt;
        },
        writeMemory: async () => ({ memoryId: "existing-memory", stored: false }),
        appendAudit,
        appendOutbox,
      }),
      ack: async () => undefined,
    });

    await expect(kernel.execute(saveCommand())).resolves.toMatchObject({
      status: "persisted",
      route: "active",
      memoryId: "existing-memory",
      stored: false,
    });
    expect(committedReceipt?.result).toMatchObject({
      memoryId: "existing-memory",
      stored: false,
    });
    expect(appendAudit).not.toHaveBeenCalled();
    expect(appendOutbox).not.toHaveBeenCalled();
  });

  test("rejects attacker tenant/user before embedding or persistence", async () => {
    const { kernel, calls } = harness({
      resolveAuthority: async () => {
        calls.push("resolveAuthority");
        throw new WriteKernelError("AUTHORITY_REJECTED", "attacker identity rejected");
      },
    });

    await expect(kernel.execute(saveCommand({
      clientScope: { ...baseCommand.clientScope, tenantId: "attacker", userId: "attacker" },
    }))).rejects.toMatchObject({ code: "AUTHORITY_REJECTED" });
    expect(calls).toEqual(["resolveAuthority"]);
  });

  test("runs embedding guard before accepting a pre-supplied vector", async () => {
    const { kernel, calls } = harness();
    await kernel.execute(saveCommand({ vector: [9, 9, 9] }));
    expect(calls).toContain("embeddingGuard");
    expect(calls).not.toContain("embed");
    expect(calls.indexOf("embeddingGuard")).toBeLessThan(calls.indexOf("validator"));
  });

  test("registry mismatch performs zero embedding and no final mutation transaction", async () => {
    const { kernel, calls } = harness({
      embeddingGuard: async () => {
        calls.push("embeddingGuard");
        return { ok: false, reason: "registry_mismatch" };
      },
    });
    await expect(kernel.execute(saveCommand())).resolves.toEqual({
      status: "rejected",
      reason: "registry_mismatch",
    });
    expect(calls).toEqual([
      "resolveAuthority", "transaction:start", "receipt:get", "transaction:end",
      "normalize", "embeddingGuard",
    ]);
  });

  test("validator rejection never invokes scoring", async () => {
    const { kernel, calls } = harness({
      validate: async () => {
        calls.push("validator");
        return { accepted: false, reason: "unsafe_candidate" };
      },
    });
    await expect(kernel.execute(saveCommand())).resolves.toEqual({
      status: "rejected",
      reason: "unsafe_candidate",
    });
    expect(calls).not.toContain("scoreAdmission");
    expect(calls.filter((call) => call === "transaction:start")).toHaveLength(1);
    expect(calls).not.toContain("memory");
  });

  test("admission drop performs zero dedup and no final mutation transaction", async () => {
    const { kernel, calls } = harness({
      scoreAdmission: async () => {
        calls.push("scoreAdmission");
        return { route: "drop", valueScore: 0.1, reason: "below_threshold" };
      },
    });
    await expect(kernel.execute(saveCommand())).resolves.toEqual({
      status: "rejected",
      reason: "below_threshold",
    });
    expect(calls).not.toContain("exactDedup");
    expect(calls.filter((call) => call === "transaction:start")).toHaveLength(1);
    expect(calls).not.toContain("memory");
  });

  test("exact duplicate performs zero semantic lookup and no final mutation transaction", async () => {
    const { kernel, calls } = harness({
      exactDedup: async () => {
        calls.push("exactDedup");
        return { duplicate: true, duplicateOf: "existing-1" };
      },
    });
    await expect(kernel.execute(saveCommand())).resolves.toEqual({
      status: "duplicate",
      kind: "exact",
      duplicateOf: "existing-1",
    });
    expect(calls).not.toContain("semanticDedup");
    expect(calls.filter((call) => call === "transaction:start")).toHaveLength(1);
    expect(calls).not.toContain("memory");
  });

  test("dedup result preserves a lexical layer instead of reporting it as exact", async () => {
    const { kernel, calls } = harness({
      exactDedup: async () => {
        calls.push("exactDedup");
        return { duplicate: true, duplicateOf: "existing-lexical", layer: "lexical" };
      },
    });

    await expect(kernel.execute(saveCommand())).resolves.toEqual({
      status: "duplicate",
      kind: "lexical",
      duplicateOf: "existing-lexical",
    });
    expect(calls).not.toContain("semanticDedup");
    expect(calls).not.toContain("memory");
  });

  test("semantic duplicate performs no final mutation transaction", async () => {
    const { kernel, calls } = harness({
      semanticDedup: async () => {
        calls.push("semanticDedup");
        return { duplicate: true, duplicateOf: "existing-2" };
      },
    });
    await expect(kernel.execute(saveCommand())).resolves.toEqual({
      status: "duplicate",
      kind: "semantic",
      duplicateOf: "existing-2",
    });
    expect(calls.filter((call) => call === "transaction:start")).toHaveLength(1);
    expect(calls).not.toContain("memory");
  });

  test("observeAuto can never persist active even when admission says active", async () => {
    const { kernel } = harness();
    await expect(kernel.execute({
      type: "observeAuto",
      intent: "remember",
      ...baseCommand,
    })).resolves.toMatchObject({ status: "persisted", route: "candidate" });
  });

  test("observeAuto ignore performs zero durable or model work", async () => {
    const { kernel, calls } = harness();
    await expect(kernel.execute({
      type: "observeAuto",
      intent: "ignore",
      ...baseCommand,
    })).resolves.toEqual({ status: "ignored", durable: false });
    expect(calls).toEqual([
      "resolveAuthority", "transaction:start", "receipt:get", "transaction:end", "normalize",
    ]);
  });

  test("transaction failure never acknowledges", async () => {
    const ack = vi.fn();
    const { kernel } = harness({
      transaction: async () => {
        throw new Error("transaction failed");
      },
      ack,
    });
    await expect(kernel.execute(saveCommand())).rejects.toThrow("transaction failed");
    expect(ack).not.toHaveBeenCalled();
  });

  test.each(["revoke", "archive", "delete"] as const)(
    "correctMemory %s is lifecycle-only and executes despite embedding mismatch",
    async (correctionKind) => {
      const embeddingGuard = vi.fn(async () => ({ ok: false as const, reason: "registry_mismatch" }));
      const embed = vi.fn(async () => [0.1]);
      const semanticDedup = vi.fn(async () => ({ duplicate: false }));
      const { kernel, calls } = harness({ embeddingGuard, embed, semanticDedup });

      await expect(kernel.execute({
        type: "correctMemory",
        idempotencyKey: `write-lifecycle-${correctionKind}`,
        correctionKind,
        targetId: "memory-old",
        serverAuthority: baseCommand.serverAuthority,
        clientScope: baseCommand.clientScope,
        metadata: { reason: "user correction" },
      })).resolves.toMatchObject({
        status: "persisted",
        correctionKind,
        memoryId: "memory-old",
      });
      expect(embeddingGuard).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(semanticDedup).not.toHaveBeenCalled();
      expect(calls).toEqual([
        "resolveAuthority",
        "transaction:start",
        "receipt:get",
        "transaction:end",
        "normalize",
        "validator",
        "transaction:start",
        "receipt:get",
        "memory",
        "audit",
        "outbox",
        "receipt:save",
        "transaction:end",
        "ack",
      ]);
    },
  );

  test("correctMemory replaceText is blocked by embedding registry mismatch", async () => {
    const { kernel, calls } = harness({
      embeddingGuard: async () => {
        calls.push("embeddingGuard");
        return { ok: false, reason: "registry_mismatch" };
      },
    });
    await expect(kernel.execute({
      type: "correctMemory",
      correctionKind: "replaceText",
      targetId: "memory-old",
      ...baseCommand,
      vector: [9, 9, 9],
    })).resolves.toEqual({ status: "rejected", reason: "registry_mismatch" });
    expect(calls).toEqual([
      "resolveAuthority", "transaction:start", "receipt:get", "transaction:end",
      "normalize", "embeddingGuard",
    ]);
  });

  test("correctMemory replaceText always re-embeds and runs both dedup stages", async () => {
    const { kernel, calls } = harness();
    await kernel.execute({
      type: "correctMemory",
      correctionKind: "replaceText",
      targetId: "memory-old",
      ...baseCommand,
      vector: [9, 9, 9],
    });
    expect(calls).toContain("embed");
    expect(calls).toContain("exactDedup");
    expect(calls).toContain("semanticDedup");
  });

  test("temporal replaceText carries a server-derived transition receipt into the final transaction", async () => {
    const { kernel, writtenRecords } = harness();
    const command = {
      type: "correctMemory",
      correctionKind: "replaceText",
      targetId: "memory-old",
      ...baseCommand,
      idempotencyKey: "temporal-evolve-1",
      temporal: {
        lineageId: "release-process",
        expectedHeadRevision: 1,
        validFrom: 1_720_000_000_000,
        transitionType: "evolved",
        reason: "workflow upgraded",
      },
    } as MemoryWriteCommand;

    await expect(kernel.execute(command)).resolves.toMatchObject({ status: "persisted" });
    expect(writtenRecords).toHaveLength(1);
    expect(writtenRecords[0]).toMatchObject({
      temporal: {
        lineageId: "release-process",
        expectedHeadRevision: 1,
        validFrom: 1_720_000_000_000,
        transitionType: "evolved",
        receipt: {
          idempotencyKey: "temporal-evolve-1",
          requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          scopeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          lineageId: "release-process",
          transitionType: "evolved",
          revision: 2,
        },
      },
    });
  });

  test("temporal feature bootstraps every newly active canonical memory as revision 1", async () => {
    const { kernel, writtenRecords } = harness({ temporalMemoryEnabled: true });

    await expect(kernel.execute(saveCommand({
      idempotencyKey: "temporal-bootstrap-1",
      evidenceIds: ["evidence-1"],
    }))).resolves.toMatchObject({ status: "persisted", route: "active" });
    expect(writtenRecords[0]).toMatchObject({
      id: "memory-1",
      temporal: {
        lineageId: "memory-1",
        expectedHeadRevision: 0,
        validFrom: 1_720_000_000_000,
        transitionType: "created",
        receipt: {
          idempotencyKey: "temporal-bootstrap-1",
          lineageId: "memory-1",
          transitionType: "created",
          revision: 1,
        },
      },
    });
  });

  test("lifecycle transaction failure never acknowledges", async () => {
    const ack = vi.fn();
    const { kernel } = harness({
      transaction: async () => {
        throw new Error("lifecycle transaction failed");
      },
      ack,
    });
    await expect(kernel.execute({
      type: "correctMemory",
      idempotencyKey: "write-lifecycle-failure",
      correctionKind: "revoke",
      targetId: "memory-old",
      serverAuthority: baseCommand.serverAuthority,
      clientScope: baseCommand.clientScope,
    })).rejects.toThrow("lifecycle transaction failed");
    expect(ack).not.toHaveBeenCalled();
  });

  test("lifecycle validator rejection performs no final mutation transaction", async () => {
    const { kernel, calls } = harness({
      validate: async () => {
        calls.push("validator");
        return { accepted: false, reason: "lifecycle_not_allowed" };
      },
    });
    await expect(kernel.execute({
      type: "correctMemory",
      idempotencyKey: "write-lifecycle-reject",
      correctionKind: "archive",
      targetId: "memory-old",
      serverAuthority: baseCommand.serverAuthority,
      clientScope: baseCommand.clientScope,
    })).resolves.toEqual({ status: "rejected", reason: "lifecycle_not_allowed" });
    expect(calls).toEqual([
      "resolveAuthority", "transaction:start", "receipt:get", "transaction:end",
      "normalize", "validator",
    ]);
  });

  test.each([
    { type: "saveExplicit" as const },
    { type: "importEvidence" as const, sourceId: "doc-1" },
    { type: "correctMemory" as const, correctionKind: "replaceText" as const, targetId: "memory-old" },
  ])("supports $type through the same write kernel", async (variant) => {
    const { kernel } = harness();
    await expect(kernel.execute({ ...variant, ...baseCommand })).resolves.toMatchObject({
      status: "persisted",
    });
  });

  test("same owner/key/fingerprint replay returns committed receipt ack with zero pipeline/mutation work", async () => {
    const ack = vi.fn(async ({ committedReceipt }: Parameters<MemoryWriteKernelDependencies["ack"]>[0]) => {
      expect(committedReceipt.result.status).toBe("persisted");
    });
    const { kernel, calls, receipts, durableMutations } = harness({ ack });
    const command = saveCommand({ idempotencyKey: "write-replay" });

    const first = await kernel.execute(command);
    const countsAfterFirst = {
      embed: calls.filter((call) => call === "embed").length,
      validator: calls.filter((call) => call === "validator").length,
      exact: calls.filter((call) => call === "exactDedup").length,
      semantic: calls.filter((call) => call === "semanticDedup").length,
      memory: calls.filter((call) => call === "memory").length,
    };
    const replay = await kernel.execute(command);

    expect(replay).toEqual(first);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(receipts.size).toBe(1);
    expect(durableMutations).toEqual(["memory"]);
    expect({
      embed: calls.filter((call) => call === "embed").length,
      validator: calls.filter((call) => call === "validator").length,
      exact: calls.filter((call) => call === "exactDedup").length,
      semantic: calls.filter((call) => call === "semanticDedup").length,
      memory: calls.filter((call) => call === "memory").length,
    }).toEqual(countsAfterFirst);
  });

  test("same owner/key with a different fingerprint conflicts before embed/validator/dedup/mutation", async () => {
    const { kernel, calls, durableMutations } = harness();
    await kernel.execute(saveCommand({ idempotencyKey: "write-conflict" }));
    const pipelineCalls = calls.length;

    await expect(kernel.execute(saveCommand({
      idempotencyKey: "write-conflict",
      text: "different payload",
    }))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(calls.slice(pipelineCalls)).toEqual([
      "resolveAuthority",
      "transaction:start",
      "receipt:get",
      "transaction:end",
    ]);
    expect(durableMutations).toEqual(["memory"]);
  });

  test("invalid idempotency key fails before transaction or pipeline work", async () => {
    const { kernel, calls } = harness();
    await expect(kernel.execute(saveCommand({ idempotencyKey: "bad key" }))).rejects.toMatchObject({
      code: "IDEMPOTENCY_REQUIRED",
    });
    expect(calls).toEqual(["resolveAuthority"]);
  });

  test("corrupted receipt owner identity fails closed before pipeline work", async () => {
    const state = harness();
    const command = saveCommand({ idempotencyKey: "write-corrupt-receipt" });
    await state.kernel.execute(command);
    const identity = createWriteIdempotencyIdentity(scope, command.idempotencyKey);
    const receipt = state.receipts.get(identity.storageKey)!;
    state.receipts.set(identity.storageKey, {
      ...receipt,
      identity: { ...receipt.identity, storageKey: "0".repeat(64) },
    });
    const callCount = state.calls.length;

    await expect(state.kernel.execute(command)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(state.calls.slice(callCount)).toEqual([
      "resolveAuthority", "transaction:start", "receipt:get", "transaction:end",
    ]);
  });

  test("same client key is isolated across server tenant/user owners", async () => {
    const { kernel, receipts, durableMutations } = harness({
      resolveAuthority: async ({ command }) => ({
        ...scope,
        tenantId: (command.serverAuthority as { tenantId: string }).tenantId,
        userId: (command.serverAuthority as { userId: string }).userId,
      }),
    });

    await kernel.execute(saveCommand({ idempotencyKey: "shared-key" }));
    await kernel.execute(saveCommand({
      idempotencyKey: "shared-key",
      serverAuthority: { tenantId: "tenant-b", userId: "user-b" },
    }));

    expect(receipts.size).toBe(2);
    expect(new Set([...receipts.values()].map((receipt) => receipt.identity.storageKey)).size).toBe(2);
    expect(durableMutations).toEqual(["memory", "memory"]);
  });

  test("slow embedding and policy pipeline run outside both short transactions", async () => {
    const state = harness();
    state.deps.embed = vi.fn(async () => {
      expect(state.isInTransaction()).toBe(false);
      state.calls.push("slow-embed");
      return [0.1, 0.2, 0.3];
    });

    await state.kernel.execute(saveCommand({ idempotencyKey: "write-slow-embed" }));

    expect(state.calls.indexOf("slow-embed")).toBeGreaterThan(
      state.calls.indexOf("transaction:end"),
    );
    expect(state.calls.filter((call) => call === "transaction:start")).toHaveLength(2);
  });

  test("concurrent second-check winner returns committed winner receipt with zero local mutation", async () => {
    const command = saveCommand({ idempotencyKey: "write-race" });
    const identity = createWriteIdempotencyIdentity(scope, command.idempotencyKey);
    const winner = createMemoryWriteReceipt(
      identity,
      createWriteCommandFingerprint(scope, command),
      { status: "persisted", route: "active", memoryId: "winner-memory" },
    );
    const { kernel, durableMutations, receipts } = harness({}, { winnerOnSecond: winner });

    await expect(kernel.execute(command)).resolves.toEqual(winner.result);
    expect(durableMutations).toHaveLength(0);
    expect(receipts.get(identity.storageKey)).toEqual(winner);
  });

  test.each([
    { name: "ack", ack: new Error("ack failed") },
    { name: "receipt", receipt: new Error("receipt failed") },
    { name: "commit", commit: new Error("commit failed") },
  ])("$name failure never returns a fake durable ack", async (fault) => {
    const ack = fault.ack
      ? vi.fn(async () => { throw fault.ack; })
      : vi.fn(async () => undefined);
    const { kernel, receipts, durableMutations } = harness(
      { ack },
      { receipt: fault.receipt, commit: fault.commit },
    );

    await expect(kernel.execute(saveCommand({
      idempotencyKey: `write-fault-${fault.name}`,
    }))).rejects.toThrow(`${fault.name} failed`);
    if (fault.name === "ack") {
      // Ack is post-commit presentation: retry can recover from the committed receipt.
      expect(receipts.size).toBe(1);
      expect(durableMutations).toEqual(["memory"]);
    } else {
      expect(ack).not.toHaveBeenCalled();
      expect(receipts.size).toBe(0);
      expect(durableMutations).toHaveLength(0);
    }
  });

  test("post-commit ack failure is recoverable from receipt without duplicate mutation", async () => {
    let attempts = 0;
    const ack = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary ack failure");
    });
    const { kernel, receipts, durableMutations } = harness({ ack });
    const command = saveCommand({ idempotencyKey: "write-ack-retry" });

    await expect(kernel.execute(command)).rejects.toThrow("temporary ack failure");
    await expect(kernel.execute(command)).resolves.toEqual([...receipts.values()][0]!.result);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(durableMutations).toEqual(["memory"]);
  });

  test.each([
    { type: "saveExplicit" as const, text: "save" },
    { type: "observeAuto" as const, intent: "remember" as const, text: "observe" },
    { type: "importEvidence" as const, sourceId: "source-a", text: "import" },
    { type: "correctMemory" as const, correctionKind: "revoke" as const, targetId: "memory-old" },
  ])("$type persists a server-scoped transactional receipt", async (variant) => {
    const { kernel, receipts } = harness();
    await kernel.execute({
      ...variant,
      idempotencyKey: `write-${variant.type}`,
      serverAuthority: baseCommand.serverAuthority,
      clientScope: baseCommand.clientScope,
      metadata: {},
    } as MemoryWriteCommand);

    expect(receipts.size).toBe(1);
    const [receipt] = receipts.values();
    expect(receipt?.identity).toMatchObject({
      tenantId: scope.tenantId,
      userId: scope.userId,
      clientKey: `write-${variant.type}`,
    });
    expect(receipt?.result.status).toBe("persisted");
  });
});
