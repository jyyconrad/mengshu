import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const RUNTIME_HOST_PROTOCOL_VERSION = 1 as const;

export type RuntimeHostControlState =
  | "created"
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "failed";

export interface RuntimeHostControlSnapshot {
  readonly protocolVersion: typeof RUNTIME_HOST_PROTOCOL_VERSION;
  readonly ownerId: string;
  readonly homeFingerprint: string;
  readonly generation: number;
  readonly state: RuntimeHostControlState;
  readonly ready: boolean;
  readonly accepting: boolean;
  readonly workerOwner: boolean;
}

export interface RuntimeHostControlPlane {
  snapshot(): RuntimeHostControlSnapshot;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATES = new Set<RuntimeHostControlState>([
  "created", "starting", "ready", "degraded", "stopping", "stopped", "failed",
]);
const KEYS = [
  "protocolVersion", "ownerId", "homeFingerprint", "generation", "state", "ready",
  "accepting", "workerOwner",
] as const;

/** Runtime home never crosses the control boundary; only this stable digest does. */
export function fingerprintRuntimeHome(runtimeHome: string): string {
  if (typeof runtimeHome !== "string" || runtimeHome.trim().length === 0 ||
      /[\u0000-\u001f\u007f]/.test(runtimeHome)) {
    throw new Error("Runtime home is invalid");
  }
  const canonical = resolve(runtimeHome.trim()).normalize("NFC");
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseRuntimeHostControlSnapshot(value: unknown): RuntimeHostControlSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime host control snapshot is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.length !== KEYS.length || keys.some((key) =>
        typeof key !== "string" || !KEYS.includes(key as typeof KEYS[number]))) {
    throw new Error("Runtime host control snapshot is invalid");
  }
  for (const key of KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new Error("Runtime host control snapshot is invalid");
    }
  }
  if (record.protocolVersion !== RUNTIME_HOST_PROTOCOL_VERSION ||
      typeof record.ownerId !== "string" || !SAFE_ID.test(record.ownerId) ||
      typeof record.homeFingerprint !== "string" || !SHA256.test(record.homeFingerprint) ||
      !Number.isSafeInteger(record.generation) || Number(record.generation) <= 0 ||
      typeof record.state !== "string" || !STATES.has(record.state as RuntimeHostControlState) ||
      typeof record.ready !== "boolean" || typeof record.accepting !== "boolean" ||
      typeof record.workerOwner !== "boolean" ||
      (record.ready && record.state !== "ready") ||
      (record.accepting && !record.ready)) {
    throw new Error("Runtime host control snapshot is invalid");
  }
  return Object.freeze({
    protocolVersion: RUNTIME_HOST_PROTOCOL_VERSION,
    ownerId: record.ownerId,
    homeFingerprint: record.homeFingerprint,
    generation: record.generation as number,
    state: record.state as RuntimeHostControlState,
    ready: record.ready,
    accepting: record.accepting,
    workerOwner: record.workerOwner,
  });
}
