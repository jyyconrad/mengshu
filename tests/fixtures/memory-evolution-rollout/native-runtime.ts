import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";
import pg from "pg";
import { memoryConfigSchema, vectorDimsForModel, type MemoryConfig } from "../../../config.js";
import { createMengshuRuntime, type MengshuRuntime } from "../../../runtime.js";
import { createServeRuntimeHost } from "../../../server/runtime-host-factory.js";
import { createRestRouter } from "../../../packages/api/src/rest/router.js";
import { EVOLUTION_OWNER_HEADER } from "../../../packages/api/src/evolution-owner-auth.js";
import { PostgresProvider } from "../../../packages/core/src/db/providers/postgres.js";
import { createEmbeddingSpace } from "../../../packages/core/src/domain/embedding-space.js";
import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import type { RuntimeCostEvent } from "../../../packages/core/src/cost/runtime-cost.js";
import type { EvolutionBatchReport } from "../../../packages/core/src/evolution/types.js";
import { LlmEvolutionProposer } from "../../../packages/core/src/evolution/proposer.js";
import { parseEvolutionProposal } from "../../../packages/core/src/evolution/schema.js";
import { Embeddings } from "../../../packages/core/src/runtime/llm/embeddings.js";
import { provisionEvolutionVerificationSchema } from "../memory-evolution/isolated-postgres.js";
import { ROLLOUT_AUTHORITY, ROLLOUT_SCOPE } from "./source-corpus.js";
import { startNativeHostWithDiagnostics } from "./startup-diagnostics.js";
import { loadGlobalEvolutionConfig } from "../../../server/evolution-config.js";
import { readUnsignedNativeSource } from "./native-attestation.js";

interface NativeRolloutOptions {
  trustedIssuers?: readonly { id: string; publicKeyPem: string }[];
  /** Test code only; never accepted from runtime config, requests or an environment model flag. */
  modelTransport?: "controlled_synthetic";
}

export const CONTROLLED_NATIVE_SOURCE = "The synthetic rollout audit retention period is 37 days.";

/** No inherited model settings or credentials. The explicit test config is used only for isolated PG. */
function controlledModelConfig(): MemoryConfig {
  return memoryConfigSchema.parse({
    embedding: { provider: "openai", apiKey: "synthetic-transport-only", baseURL: "https://controlled.invalid/v1", model: "text-embedding-3-small" },
    llm: { provider: "openai", apiKey: "synthetic-transport-only", baseURL: "https://controlled.invalid/v1", model: "controlled-synthetic-proposal" },
    batchProcessing: { retryAttempts: 0 },
  });
}

export async function installControlledNativeModelTransport() {
  // Keep the normal real-model fixture/CLI import usable outside Vitest.
  const { vi } = await import("vitest");
  const undo: Array<() => void> = [];
  const restore = () => { for (const run of undo.splice(0).reverse()) run(); };
  let proposalCalls = 0, embeddingCalls = 0, blockedNetworkCalls = 0;
  const forbidden = (): never => { blockedNetworkCalls++; throw new Error("controlled_runtime_network_forbidden"); };
  const retain = (spy: { mockRestore(): void }) => { undo.push(() => spy.mockRestore()); };
  try {
    retain(vi.spyOn(globalThis, "fetch").mockImplementation(async () => forbidden()));
    for (const transport of [http, https]) {
      retain(vi.spyOn(transport, "request").mockImplementation(forbidden));
      retain(vi.spyOn(transport, "get").mockImplementation(forbidden));
    }
    const connect = Socket.prototype.connect;
    retain(vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
      const target = args[0] && typeof args[0] === "object" ? args[0] as { host?: unknown; port?: unknown }
        : { port: args[0], host: args[1] };
      if (!["127.0.0.1", "localhost", "::1"].includes(String(target.host)) ||
          !Number.isSafeInteger(Number(target.port)) || Number(target.port) < 1 || Number(target.port) > 65535) forbidden();
      return Reflect.apply(connect, this, args) as Socket;
    }));
    retain(vi.spyOn(LlmEvolutionProposer.prototype, "propose").mockImplementation(async (unit, options) => {
      if (options.signal?.aborted) throw new Error("cancelled");
      const evidence = unit.evidence[0];
      if (unit.evidence.length !== 1 || unit.targets.length || evidence.text !== CONTROLLED_NATIVE_SOURCE ||
          evidence.origin !== "external" || evidence.trust !== "untrusted" || evidence.hostAttestation) {
        throw new Error("controlled_proposal_input_mismatch");
      }
      proposalCalls++;
      return parseEvolutionProposal({ operation: "create", claimClass: "fact", reasonCode: "new_claim", targetRefs: [],
        quotes: [{ evidenceId: evidence.id, quote: CONTROLLED_NATIVE_SOURCE, start: 0, end: CONTROLLED_NATIVE_SOURCE.length }],
        proposedText: CONTROLLED_NATIVE_SOURCE, kind: "fact" });
    }));
    retain(vi.spyOn(Embeddings.prototype, "embedBatch").mockImplementation(async texts => {
      if (texts.length > 20 || texts.some(text => Buffer.byteLength(text) > 8192)) throw new Error("controlled_embedding_input_unbounded");
      embeddingCalls++;
      return texts.map(() => Array.from({ length: vectorDimsForModel("text-embedding-3-small") }, (_, index) => index === 0 ? 1 : 0));
    }));
    return { restore, snapshot: () => ({ mode: "controlled_synthetic" as const, proposalCalls, embeddingCalls, blockedNetworkCalls }) };
  } catch (error) { restore(); throw error; }
}

/** Serialized HostAuthority excludes runtime-owned workspace/session coordinates. */
export function createNativeRolloutConfig(base: MemoryConfig, postgres: MemoryConfig["postgres"], sourceRoot: string, ownerSecret: string, options: NativeRolloutOptions = {}) {
  if (options.modelTransport === "controlled_synthetic") base = controlledModelConfig();
  const { tenantId, userId, allow } = ROLLOUT_AUTHORITY;
  return memoryConfigSchema.parse({ ...base, dbType: "postgres", postgres,
    authority: { tenantId, userId, allow }, features: { ...base.features, continuousMemoryEvolution: true, temporalMemory: true },
    server: { ...base.server, workerOwnership: "runtime-host", backgroundWork: { mode: "paused", allowedBatchIds: [] } },
    evolution: { sources: [{ sourceId: "rollout-native-source", root: sourceRoot, parser: "markdown" }],
      ...(options.trustedIssuers?.length ? { attestation: { trustedIssuers: structuredClone(options.trustedIssuers) } } : {}),
      control: { ownerSecret }, maintenance: { enabled: false, intervalMs: 60_000, quietPeriodMs: 1000,
        dailyTokens: 100_000, dailyMinorUnits: 10_000, maxStorageBytes: 1_073_741_824, minFreeBytes: 1_048_576 } },
  });
}

/** Main-agent-only fixture. Default is the real global model; controlled transport never replaces host/provider/policy. */
export async function openNativeRolloutRuntime(sourceText: string, options: NativeRolloutOptions = {}) {
  const useControlled = options.modelTransport === "controlled_synthetic";
  if (process.env.MENGSHU_RUN_LIVE_TESTS !== "1" || !useControlled && process.env.MENGSHU_EVOLUTION_REAL_MODEL !== "1") {
    throw new Error("native_rollout_requires_explicit_live_and_real_model_opt_in");
  }
  if (!sourceText.trim() || Buffer.byteLength(sourceText) > 8192) throw new Error("bounded_synthetic_source_required");
  if (useControlled && (sourceText !== CONTROLLED_NATIVE_SOURCE || options.trustedIssuers?.length ||
      process.env.MENGSHU_EVOLUTION_ISOLATED_DB !== "1")) throw new Error("controlled_native_requires_unsigned_synthetic_source_and_isolated_db");
  const controlled = useControlled ? await installControlledNativeModelTransport() : undefined;
  let isolated: Awaited<ReturnType<typeof provisionEvolutionVerificationSchema>>;
  try { isolated = await provisionEvolutionVerificationSchema(); }
  catch (error) { controlled?.restore(); throw error; }
  const previousHome = process.env.MENGSHU_HOME;
  let root: string | undefined;
  let runtime: MengshuRuntime | undefined;
  let host: ReturnType<typeof createServeRuntimeHost> | undefined;
  let queryClient: pg.Client | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let failure: unknown;
    try { await host?.stop(); } catch (error) { failure = error; }
    try { await runtime?.stop(); } catch (error) { failure ??= error; }
    try { await queryClient?.end(); } catch (error) { failure ??= error; }
    try { await isolated.dispose(); } catch (error) { failure ??= error; }
    if (previousHome === undefined) delete process.env.MENGSHU_HOME;
    else process.env.MENGSHU_HOME = previousHome;
    try { if (root) await rm(root, { recursive: true, force: true }); }
    finally { controlled?.restore(); }
    if (failure) throw new Error("native_rollout_cleanup_failed");
  };
  try {
    root = await mkdtemp(join(tmpdir(), "mengshu-native-rollout-"));
    const sourceRoot = join(root, "source");
    const stateRoot = join(root, "state");
    await mkdir(sourceRoot);
    await mkdir(stateRoot);
    const sourcePath = join(sourceRoot, "claim.md");
    await writeFile(sourcePath, sourceText.trim() + "\n");
    process.env.MENGSHU_HOME = stateRoot;
    const ownerSecret = `${randomUUID()}${randomUUID()}`;
    const config = createNativeRolloutConfig(isolated.config, isolated.postgres, sourceRoot, ownerSecret, options);
    if (!config.llm?.apiKey || !config.llm.model) throw new Error("explicit_global_model_unavailable");
    const model = config.embedding.model ?? "text-embedding-3-small";
    const prime = new PostgresProvider(isolated.postgres, model);
    try {
      await prime.initialize();
      // This freshly provisioned synthetic schema has no data or running host/writers.
      await prime.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
      await prime.registerActiveEmbeddingSpace(createEmbeddingSpace({ provider: config.embedding.provider,
        baseURL: config.embedding.baseURL ?? "", model, dim: vectorDimsForModel(model), normalization: "none" }));
    } finally { await prime.close(); }
    const events: RuntimeCostEvent[] = [];
    const provider = new PostgresProvider(isolated.postgres, model);
    runtime = createMengshuRuntime({ config, resolvedDbPath: "", appId: ROLLOUT_SCOPE.appId,
      defaultScope: ROLLOUT_SCOPE, db: provider, continuousMemoryEvolutionHost: { authority: ROLLOUT_AUTHORITY, config },
      runtimeCostLedger: { append: async event => { events.push(structuredClone(event)); }, query: async () => structuredClone(events) },
    });
    host = createServeRuntimeHost(runtime, { authority: ROLLOUT_AUTHORITY, workerId: "rollout-native-host",
      leaseMs: 60_000, heartbeatIntervalMs: 5000, intervalMs: 25, maxPerTick: 1, stopTimeoutMs: 10_000 });
    await startNativeHostWithDiagnostics(host, runtime);
    if (!host.snapshot().ready || !runtime.continuousMemoryEvolution?.review) throw new Error("native_review_runtime_unavailable");
    const background = runtime.backgroundWork;
    if (!background || background.snapshot().mode !== "paused") throw new Error("native_background_control_unavailable");
    const capability = runtime.continuousMemoryEvolution;
    const persistence = provider.createEvolutionPersistence(ROLLOUT_SCOPE);
    const scopeFingerprint = authorityScopeFingerprint(ROLLOUT_SCOPE);
    const router = createRestRouter({ service: runtime.memoryService, authority: ROLLOUT_AUTHORITY,
      continuousMemoryEvolution: capability, evolutionOwnerSecret: ownerSecret, backgroundWork: background });
    queryClient = new pg.Client(isolated.postgres);
    await queryClient.connect();
    return {
      runtime, host, provider, capability, persistence, scope: ROLLOUT_SCOPE, scopeFingerprint, sourcePath,
      schema: isolated.schema, events, close, controlledTransport: controlled ? { snapshot: controlled.snapshot } : undefined,
      async readUnsignedSource() {
        const resolved = loadGlobalEvolutionConfig({ authority: ROLLOUT_AUTHORITY, scope: ROLLOUT_SCOPE, hostConfig: config });
        return readUnsignedNativeSource(resolved, persistence.repository, join(root!, "attestation-preview"));
      },
      async current(memoryId: string) {
        const row = (await queryClient!.query<{ lineage_id: string | null }>("SELECT lineage_id FROM memories WHERE id=$1", [memoryId])).rows[0];
        if (!row?.lineage_id || !runtime!.memoryEvolution) throw new Error("native_current_lineage_unavailable");
        return runtime!.memoryEvolution.current({ scope: ROLLOUT_SCOPE, lineageId: row.lineage_id });
      },
      async control(operation: string, body: unknown, authorized = true) {
        return router.handle({ method: "POST", path: `/v1/evolution/${operation}`, remoteAddress: "127.0.0.1", protocol: "http",
          headers: authorized ? { [EVOLUTION_OWNER_HEADER]: ownerSecret } : {}, body });
      },
      async canonicalCount() {
        const result = await queryClient!.query<{ count: number }>("SELECT count(*)::int AS count FROM memories WHERE metadata->>'admissionRoute' IN ('active','lookup_only')");
        return result.rows[0].count;
      },
      async proposals(batchId: string) {
        return persistence.repository.listProposals(scopeFingerprint, { batchId, limit: 8, maxBytes: 131_072 });
      },
      async waitBatch(batchId: string, timeoutMs = 90_000): Promise<EvolutionBatchReport> {
        const prepared = await capability.status(batchId);
        if (prepared?.status === "queued") {
          const enabled = await router.handle({ method: "POST", path: "/v1/runtime/background", remoteAddress: "127.0.0.1", protocol: "http",
            headers: { [EVOLUTION_OWNER_HEADER]: ownerSecret }, body: { expectedRevision: background.snapshot().revision,
              mode: "evolution_only", allowedBatchIds: [batchId] } });
          if (enabled.status !== 200) throw new Error("native_bounded_batch_control_failed");
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const report = await capability.status(batchId);
          if (!report) throw new Error("native_batch_disappeared");
          if (!["queued", "running"].includes(report.status)) return report;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("native_batch_timeout");
      },
    };
  } catch (error) {
    try { await close(); } catch { /* Preserve the setup failure; the fixture owns all temporary resources. */ }
    throw error;
  }
}
