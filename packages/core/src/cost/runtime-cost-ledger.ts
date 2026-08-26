import { constants } from "node:fs";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveRuntimeCostLedgerPath } from "../runtime/paths.js";
import {
  RUNTIME_COST_CATEGORIES,
  RUNTIME_COST_EVENT_VERSION,
  type RuntimeCostEvent,
  type RuntimeCostLedger,
} from "./runtime-cost.js";

const MAX_LEDGER_LINE_BYTES = 16 * 1024;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_REASON = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SCOPE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export class RuntimeCostLedgerCorruptError extends Error {
  constructor(
    public readonly lineNumber: number,
    message: string,
  ) {
    super(`Runtime cost ledger is corrupt at line ${lineNumber}: ${message}`);
    this.name = "RuntimeCostLedgerCorruptError";
  }
}

function validCount(value: unknown, nullable = true): value is number | null {
  return (nullable && value === null) ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validateEvent(value: unknown, lineNumber: number): RuntimeCostEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeCostLedgerCorruptError(lineNumber, "event must be an object");
  }
  const row = value as Record<string, unknown>;
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
  const valid = row.version === RUNTIME_COST_EVENT_VERSION &&
    Number.isFinite(timestamp) &&
    typeof row.operation === "string" && SAFE_LABEL.test(row.operation) &&
    typeof row.category === "string" &&
      (RUNTIME_COST_CATEGORIES as readonly string[]).includes(row.category) &&
    typeof row.provider === "string" && SAFE_LABEL.test(row.provider) &&
    typeof row.model === "string" && SAFE_LABEL.test(row.model) &&
    validCount(row.inputTokens) && validCount(row.outputTokens) &&
    validCount(row.embeddingUnits) &&
    (row.embeddingUnitKind === null || row.embeddingUnitKind === "tokens" || row.embeddingUnitKind === "inputs") &&
    typeof row.pricingSnapshotVersion === "string" && SAFE_LABEL.test(row.pricingSnapshotVersion) &&
    validCount(row.estimatedMinorUnits) &&
    typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) &&
    (row.status === "succeeded" || row.status === "failed" || row.status === "rejected") &&
    (row.rejectionReason === null ||
      (typeof row.rejectionReason === "string" && SAFE_REASON.test(row.rejectionReason))) &&
    typeof row.attempt === "number" && Number.isInteger(row.attempt) && row.attempt >= 1 &&
    typeof row.scopeFingerprint === "string" && SCOPE_FINGERPRINT.test(row.scopeFingerprint);
  if (!valid) throw new RuntimeCostLedgerCorruptError(lineNumber, "event schema validation failed");

  return {
    version: RUNTIME_COST_EVENT_VERSION,
    timestamp: row.timestamp as string,
    operation: row.operation as string,
    category: row.category as RuntimeCostEvent["category"],
    provider: row.provider as string,
    model: row.model as string,
    inputTokens: row.inputTokens as number | null,
    outputTokens: row.outputTokens as number | null,
    embeddingUnits: row.embeddingUnits as number | null,
    embeddingUnitKind: row.embeddingUnitKind as RuntimeCostEvent["embeddingUnitKind"],
    pricingSnapshotVersion: row.pricingSnapshotVersion as string,
    estimatedMinorUnits: row.estimatedMinorUnits as number | null,
    currency: row.currency as string,
    status: row.status as RuntimeCostEvent["status"],
    rejectionReason: row.rejectionReason as string | null,
    attempt: row.attempt as number,
    scopeFingerprint: row.scopeFingerprint as string,
  };
}

function serializeEvent(event: RuntimeCostEvent): string {
  // Rebuild from the validated fixed schema so caller-injected extra fields cannot persist.
  return `${JSON.stringify(validateEvent(event, 1))}\n`;
}

export class JsonlRuntimeCostLedger implements RuntimeCostLedger {
  constructor(public readonly path: string = resolveRuntimeCostLedgerPath()) {}

  async append(event: RuntimeCostEvent): Promise<void> {
    const line = serializeEvent(event);
    const bytes = Buffer.from(line, "utf8");
    if (bytes.byteLength > MAX_LEDGER_LINE_BYTES) {
      throw new Error(`Runtime cost ledger event exceeds ${MAX_LEDGER_LINE_BYTES} bytes`);
    }
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const handle = await open(
      this.path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      const result = await handle.write(bytes, 0, bytes.byteLength, null);
      if (result.bytesWritten !== bytes.byteLength) {
        throw new Error("Runtime cost ledger append was incomplete");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async query(): Promise<readonly RuntimeCostEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (raw.length === 0) return [];
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line, index) => {
      if (line.length === 0) {
        throw new RuntimeCostLedgerCorruptError(index + 1, "blank line");
      }
      if (Buffer.byteLength(line, "utf8") > MAX_LEDGER_LINE_BYTES) {
        throw new RuntimeCostLedgerCorruptError(index + 1, "line exceeds size limit");
      }
      try {
        return validateEvent(JSON.parse(line), index + 1);
      } catch (error) {
        if (error instanceof RuntimeCostLedgerCorruptError) throw error;
        throw new RuntimeCostLedgerCorruptError(index + 1, "invalid JSON");
      }
    });
  }
}
