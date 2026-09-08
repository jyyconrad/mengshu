import { parseArgs } from "node:util";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { parseCanonicalProjectionBundle } from "../packages/core/src/db/migrations/canonical-postgres-rehydration.js";
import { auditHistory } from "../packages/core/src/evolution/history/audit.js";
import { planHistory } from "../packages/core/src/evolution/history/plan.js";
import { applyHistory, archiveHistory, rollbackHistory, validateHistoryPlan, verifyHistory, type HistoryExecutionPage } from "../packages/core/src/evolution/history/execution.js";
import { PostgresHistoryReadPort, type HistoryPgPool } from "../packages/core/src/evolution/history/postgres-read.js";
import { createPostgresHistoryNativePort } from "../packages/core/src/evolution/history/postgres-native.js";
import { HistoryArtifactReader, writeHistoryArtifactExclusive, type HistoryArtifactRef } from "../packages/core/src/evolution/history/operator-files.js";
import { exactObject, historyHash, parseHistoryInput, rejectHistory, verifyHistoryHash } from "../packages/core/src/evolution/history/schema.js";
import { attachLegacyKnowledgeResolution, parseLegacyKnowledgeResolution } from "../packages/core/src/evolution/history/knowledge-resolution.js";
import type { HistoryApprovedOperation } from "../packages/core/src/evolution/history/postgres-store.js";
import type { HistoryNativeMaterials } from "../packages/core/src/evolution/history/native-materials.js";
import type { HistoryAudit, HistoryNativePort, HistoryPlan } from "../packages/core/src/evolution/history/types.js";

const projectionNames = ["projectionManifest", "canonicalMemoryRows", "governedDocumentRows", "claimEvidenceRows", "sourceMappingRows", "embeddingJobs"] as const;
const actions = ["inspect", "audit", "plan", "verify", "apply", "archive", "rollback", "rehearse"] as const;
export type HistoryOperatorAction = typeof actions[number];
interface Spec {
  schema: "mengshu.history-p16-operator/v1";
  dataClass: "synthetic";
  root: string;
  input: HistoryArtifactRef;
  projection: Record<typeof projectionNames[number], HistoryArtifactRef>;
  database?: { urlEnvironment: string; expectedDatabaseName: string };
  audit?: HistoryArtifactRef;
  plan?: HistoryArtifactRef;
  nativeMaterials?: HistoryArtifactRef;
  approvals?: HistoryArtifactRef;
  vaultRoots?: Record<string, string>;
  knowledgeResolution?: { plan: HistoryArtifactRef; receipt: HistoryArtifactRef; bindings: HistoryArtifactRef; dispositions: HistoryArtifactRef; unitDecisions: HistoryArtifactRef; summary: HistoryArtifactRef };
}
export function parseHistoryOperatorSpec(value: unknown): Spec {
  const spec = exactObject(value, ["schema", "dataClass", "root", "input", "projection"], ["database", "audit", "plan", "nativeMaterials", "approvals", "vaultRoots", "knowledgeResolution"]);
  if (spec.schema !== "mengshu.history-p16-operator/v1" || spec.dataClass !== "synthetic" || typeof spec.root !== "string" || !isAbsolute(spec.root)) rejectHistory("HISTORY_SYNTHETIC_SPEC_REQUIRED");
  exactObject(spec.projection, projectionNames);
  return structuredClone(spec) as unknown as Spec;
}
export function historySyntheticConnection(spec: NonNullable<Spec["database"]>, environment: NodeJS.ProcessEnv): string {
  exactObject(spec, ["urlEnvironment", "expectedDatabaseName"]);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(spec.urlEnvironment) || !/^mengshu_history_fixture_[a-z0-9_]+$/.test(spec.expectedDatabaseName)) rejectHistory("HISTORY_SYNTHETIC_DATABASE_REQUIRED");
  let url: URL;
  try { url = new URL(environment[spec.urlEnvironment] ?? ""); } catch { return rejectHistory("HISTORY_DATABASE_URL_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || decodeURIComponent(url.pathname.slice(1)) !== spec.expectedDatabaseName || url.search) rejectHistory("HISTORY_SYNTHETIC_DATABASE_REQUIRED");
  return url.toString();
}
export async function rehearseHistorySynthetic(plan: HistoryPlan, port: HistoryNativePort, approvals: readonly HistoryApprovedOperation[]): Promise<unknown> {
  const summaries: { phase: string; visited: number; hash: string }[] = [];
  for (const action of ["apply", "verify", "archive", "verify", "rollback"] as const) {
    let afterUnitId: string | undefined, complete = false;
    for (let page = 0; !complete; page++) {
      if (page > plan.units.length + 1) rejectHistory("HISTORY_REHEARSAL_CURSOR_INVALID");
      const authorization = approvals.find(receipt => receipt.planHash === plan.hash && receipt.action === action)?.authorization;
      if (action !== "verify" && !authorization) rejectHistory("HISTORY_APPROVED_OPERATION_REQUIRED");
      const options = { afterUnitId, includeArchive: action === "verify" && summaries.some(item => item.phase === "archive") };
      const result: HistoryExecutionPage = action === "apply" ? await applyHistory(plan, port, authorization!, options) : action === "archive" ? await archiveHistory(plan, port, authorization!, options) : action === "rollback" ? await rollbackHistory(plan, port, authorization!, options) : await verifyHistory(plan, port, options);
      summaries.push({ phase: action, visited: result.visited, hash: result.hash }); complete = result.complete; afterUnitId = result.next;
    }
  }
  const body = { schema: "mengshu.history-p16-synthetic-rehearsal/v1", planHash: plan.hash, phases: summaries, productionTouched: false };
  return { ...body, hash: historyHash(body) };
}
export async function runHistoryOperator(action: HistoryOperatorAction, specValue: unknown, options: { afterUnitId?: string; includeArchive?: boolean; environment?: NodeJS.ProcessEnv } = {}): Promise<unknown> {
  if (!actions.includes(action)) rejectHistory("HISTORY_COMMAND_INVALID");
  const spec = parseHistoryOperatorSpec(specValue), files = new HistoryArtifactReader(spec.root);
  const input = parseHistoryInput(JSON.parse(await files.read(spec.input)));
  const texts = {} as Record<typeof projectionNames[number], string>;
  for (const name of projectionNames) texts[name] = await files.read(spec.projection[name]);
  const bundle = parseCanonicalProjectionBundle(texts);
  if (action === "plan") {
    if (!spec.audit) rejectHistory("HISTORY_AUDIT_REQUIRED");
    return planHistory(input, JSON.parse(await files.read(spec.audit)) as HistoryAudit);
  }
  if (!spec.database) rejectHistory("HISTORY_SYNTHETIC_DATABASE_REQUIRED");
  const connectionString = historySyntheticConnection(spec.database, options.environment ?? process.env);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000, application_name: "mengshu-history-p16-synthetic", options: ["inspect", "audit", "verify"].includes(action) ? "-c default_transaction_read_only=on" : undefined });
  try {
    const identity = await pool.query("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== spec.database.expectedDatabaseName) rejectHistory("HISTORY_SYNTHETIC_DATABASE_REQUIRED");
    const query = { query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => { const result = await pool.query(sql, [...values]); return { rows: result.rows as Row[], rowCount: result.rowCount }; } };
    const read = new PostgresHistoryReadPort(query, bundle, input);
    if (action === "inspect") return read.readParent(input);
    if (action === "audit") {
      let audit = await auditHistory(input, read);
      if (spec.knowledgeResolution) {
        const refs = spec.knowledgeResolution, resolution = {} as Record<keyof typeof refs, string>;
        for (const key of Object.keys(refs) as (keyof typeof refs)[]) resolution[key] = await files.read(refs[key]);
        audit = attachLegacyKnowledgeResolution(audit, parseLegacyKnowledgeResolution({ ...resolution, planSha256: refs.plan.sha256, receiptSha256: refs.receipt.sha256 }));
      }
      return audit;
    }
    if (!spec.plan || !spec.nativeMaterials || !spec.approvals || !spec.vaultRoots) rejectHistory("HISTORY_NATIVE_ARTIFACTS_REQUIRED");
    const plan = JSON.parse(await files.read(spec.plan)) as HistoryPlan; validateHistoryPlan(plan);
    if (historyHash(plan.input) !== historyHash(input)) rejectHistory("HISTORY_NATIVE_PLAN_MISMATCH");
    const materials = JSON.parse(await files.read(spec.nativeMaterials)) as HistoryNativeMaterials;
    const approvalArtifact = JSON.parse(await files.read(spec.approvals)) as { schema: string; approvals: HistoryApprovedOperation[]; hash: string };
    exactObject(approvalArtifact, ["schema", "approvals", "hash"]); verifyHistoryHash(approvalArtifact);
    if (approvalArtifact.schema !== "mengshu.history-p16-approvals/v1" || !Array.isArray(approvalArtifact.approvals) || approvalArtifact.approvals.length > 3) rejectHistory("HISTORY_APPROVED_OPERATION_REQUIRED");
    const adaptedPool: HistoryPgPool = { connect: async () => {
      const client = await pool.connect(); return { query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => { const result = await client.query(sql, [...values]); return { rows: result.rows as Row[], rowCount: result.rowCount }; }, release: () => client.release() };
    } };
    const native = createPostgresHistoryNativePort({ pool: adaptedPool, read, plan, materials, approvedOperations: approvalArtifact.approvals, vaultRoots: spec.vaultRoots });
    if (action === "rehearse") return rehearseHistorySynthetic(plan, native, approvalArtifact.approvals);
    if (action === "verify") return verifyHistory(plan, native, options);
    const authorization = approvalArtifact.approvals.find(item => item.planHash === plan.hash && item.action === action)?.authorization;
    if (!authorization) rejectHistory("HISTORY_APPROVED_OPERATION_REQUIRED");
    return action === "apply" ? applyHistory(plan, native, authorization, options) : action === "archive" ? archiveHistory(plan, native, authorization, options) : rollbackHistory(plan, native, authorization, options);
  } finally { await pool.end(); }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { help: { type: "boolean" }, spec: { type: "string" }, "spec-sha256": { type: "string" }, out: { type: "string" }, after: { type: "string" }, "include-archive": { type: "boolean" } } });
  if (values.help) { console.log("operator-evolution-history <inspect|audit|plan|verify|apply|archive|rollback|rehearse> --spec ABS --spec-sha256 SHA256 --out ABS [--after UNIT] [--include-archive]\nSynthetic loopback databases only; no production/config discovery, migrations, models, deployment, or physical purge."); return; }
  if (positionals.length !== 1 || !actions.includes(positionals[0] as HistoryOperatorAction) || !values.spec || !isAbsolute(values.spec) || !values["spec-sha256"] || !values.out) rejectHistory("HISTORY_COMMAND_INVALID");
  const file = resolve(values.spec), reader = new HistoryArtifactReader(dirname(file), 1024 * 1024, 1024 * 1024);
  const spec = JSON.parse(await reader.read({ path: file, sha256: values["spec-sha256"] }));
  const result = await runHistoryOperator(positionals[0] as HistoryOperatorAction, spec, { afterUnitId: values.after, includeArchive: values["include-archive"] });
  await writeHistoryArtifactExclusive(values.out, result);
  console.log(JSON.stringify({ action: positionals[0], output: resolve(values.out), hash: historyHash(result), dataClass: "synthetic" }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "HISTORY_OPERATOR_FAILED" })); process.exitCode = 1; });
}
