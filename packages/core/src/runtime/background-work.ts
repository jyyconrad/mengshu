export interface RuntimeBackgroundWorkConfig {
  readonly mode: "all" | "paused" | "evolution_only";
  readonly allowedBatchIds: readonly string[];
}

export interface RuntimeBackgroundWorkUpdate extends RuntimeBackgroundWorkConfig {
  readonly expectedRevision: string;
}

export interface RuntimeBackgroundWorkSnapshot extends RuntimeBackgroundWorkConfig {
  readonly revision: string;
  readonly active: number;
  readonly state: "enabled" | "paused" | "controlled" | "draining";
}

export interface RuntimeBackgroundWorkCapability {
  snapshot(): RuntimeBackgroundWorkSnapshot;
  update(request: unknown): Promise<RuntimeBackgroundWorkSnapshot>;
}

export class RuntimeBackgroundWorkError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RuntimeBackgroundWorkError"; }
}

export function parseRuntimeBackgroundWork(raw: unknown): RuntimeBackgroundWorkConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeBackgroundWorkError("BACKGROUND_CONFIG_INVALID");
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "mode" && key !== "allowedBatchIds") ||
      !["all", "paused", "evolution_only"].includes(value.mode as string)) {
    throw new RuntimeBackgroundWorkError("BACKGROUND_CONFIG_INVALID");
  }
  const ids = value.allowedBatchIds ?? [];
  if (!Array.isArray(ids) || ids.length > 100 ||
      ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) ||
      new Set(ids).size !== ids.length || (value.mode === "evolution_only" ? ids.length === 0 : ids.length > 0)) {
    throw new RuntimeBackgroundWorkError("BACKGROUND_CONFIG_INVALID");
  }
  return Object.freeze({ mode: value.mode as RuntimeBackgroundWorkConfig["mode"], allowedBatchIds: Object.freeze([...ids].sort()) });
}

export function parseRuntimeBackgroundWorkUpdate(raw: unknown): RuntimeBackgroundWorkUpdate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeBackgroundWorkError("BACKGROUND_CONFIG_INVALID");
  }
  const { expectedRevision, ...config } = raw as Record<string, unknown>;
  if (typeof expectedRevision !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expectedRevision)) {
    throw new RuntimeBackgroundWorkError("BACKGROUND_REVISION_INVALID");
  }
  return { ...parseRuntimeBackgroundWork(config), expectedRevision };
}
