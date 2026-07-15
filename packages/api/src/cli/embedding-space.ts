import type { Command } from "commander";

import {
  evaluateEmbeddingWriteCompatibility,
  type KnownEmbeddingSpace,
} from "../../../core/src/domain/embedding-space.js";

export type EmbeddingSpaceOperatorStatus =
  | "active"
  | "missing"
  | "mismatch"
  | "unsupported"
  | "unavailable";

export interface EmbeddingSpaceOperatorDeps {
  dbType?: string;
  runtimeSpace: KnownEmbeddingSpace;
  getActive?: () => Promise<KnownEmbeddingSpace | null>;
  registerActive?: (space: KnownEmbeddingSpace) => Promise<KnownEmbeddingSpace>;
  writeLine?: (line: string) => void;
}

export interface EmbeddingSpaceStatusResult {
  status: EmbeddingSpaceOperatorStatus;
  writeMode: "enabled" | "read-only";
  runtimeSpace: KnownEmbeddingSpace;
  activeSpace?: KnownEmbeddingSpace;
}

export interface EmbeddingSpaceActivationResult {
  outcome: "activated" | "already-active";
  activeSpace: KnownEmbeddingSpace;
}

function sameDescriptor(
  left: KnownEmbeddingSpace,
  right: KnownEmbeddingSpace,
): boolean {
  return (
    left.embeddingSpaceId === right.embeddingSpaceId &&
    left.state === right.state &&
    left.fingerprint.provider === right.fingerprint.provider &&
    left.fingerprint.baseURL === right.fingerprint.baseURL &&
    left.fingerprint.model === right.fingerprint.model &&
    left.fingerprint.dim === right.fingerprint.dim &&
    left.fingerprint.normalization === right.fingerprint.normalization
  );
}

function hasReadCapability(
  deps: EmbeddingSpaceOperatorDeps,
): deps is EmbeddingSpaceOperatorDeps & {
  getActive: () => Promise<KnownEmbeddingSpace | null>;
} {
  return deps.dbType === "postgres" && typeof deps.getActive === "function";
}

function hasActivationCapability(
  deps: EmbeddingSpaceOperatorDeps,
): deps is EmbeddingSpaceOperatorDeps & {
  getActive: () => Promise<KnownEmbeddingSpace | null>;
  registerActive: (space: KnownEmbeddingSpace) => Promise<KnownEmbeddingSpace>;
} {
  return hasReadCapability(deps) && typeof deps.registerActive === "function";
}

export async function inspectEmbeddingSpace(
  deps: EmbeddingSpaceOperatorDeps,
): Promise<EmbeddingSpaceStatusResult> {
  if (!hasActivationCapability(deps)) {
    return {
      status: "unsupported",
      writeMode: "read-only",
      runtimeSpace: deps.runtimeSpace,
    };
  }

  try {
    const activeSpace = await deps.getActive();
    if (!activeSpace) {
      return {
        status: "missing",
        writeMode: "read-only",
        runtimeSpace: deps.runtimeSpace,
        activeSpace: undefined,
      };
    }
    const matches = evaluateEmbeddingWriteCompatibility(
      activeSpace,
      deps.runtimeSpace,
    ).compatible;
    return {
      status: matches ? "active" : "mismatch",
      writeMode: matches ? "enabled" : "read-only",
      runtimeSpace: deps.runtimeSpace,
      activeSpace,
    };
  } catch {
    // Provider errors may include credentials or connection strings. The operator
    // status is intentionally fail-closed and exposes only a stable state code.
    return {
      status: "unavailable",
      writeMode: "read-only",
      runtimeSpace: deps.runtimeSpace,
    };
  }
}

export async function activateEmbeddingSpace(
  deps: EmbeddingSpaceOperatorDeps,
  confirmed: boolean,
): Promise<EmbeddingSpaceActivationResult> {
  if (!confirmed) {
    throw new Error("embedding space activation requires explicit --confirm");
  }
  if (!hasActivationCapability(deps)) {
    throw new Error("embedding space activation is unsupported for this database provider");
  }

  let activeSpace: KnownEmbeddingSpace | null;
  try {
    activeSpace = await deps.getActive();
  } catch {
    throw new Error("embedding space registry unavailable; activation aborted");
  }

  if (activeSpace) {
    if (!evaluateEmbeddingWriteCompatibility(activeSpace, deps.runtimeSpace).compatible) {
      throw new Error("active embedding space mismatch; refusing to overwrite existing pointer");
    }
    return { outcome: "already-active", activeSpace };
  }

  let registered: KnownEmbeddingSpace;
  try {
    registered = await deps.registerActive(deps.runtimeSpace);
  } catch {
    // The provider enforces first-registration-wins transactionally. Keep the
    // CLI error stable and secret-free for both races and backend failures. A
    // second read classifies a concurrent winner without trusting error text.
    let concurrentWinner: KnownEmbeddingSpace | null = null;
    try {
      concurrentWinner = await deps.getActive();
    } catch {
      // Preserve the generic fail-closed result below.
    }
    if (concurrentWinner) {
      if (
        evaluateEmbeddingWriteCompatibility(concurrentWinner, deps.runtimeSpace)
          .compatible
      ) {
        return { outcome: "already-active", activeSpace: concurrentWinner };
      }
      throw new Error("active embedding space mismatch; refusing to overwrite existing pointer");
    }
    throw new Error("embedding space activation failed; registry was not changed");
  }
  if (!sameDescriptor(registered, deps.runtimeSpace)) {
    throw new Error("active embedding space mismatch; refusing to continue");
  }
  return { outcome: "activated", activeSpace: registered };
}

function writeDescriptor(
  writeLine: (line: string) => void,
  label: string,
  space: KnownEmbeddingSpace,
): void {
  writeLine(`${label} ID: ${space.embeddingSpaceId}`);
  writeLine(`${label} state: ${space.state}`);
  writeLine(
    `${label} fingerprint: provider=${space.fingerprint.provider} ` +
      `model=${space.fingerprint.model} dim=${space.fingerprint.dim} ` +
      `normalization=${space.fingerprint.normalization}`,
  );
}

function printStatus(
  result: EmbeddingSpaceStatusResult,
  writeLine: (line: string) => void,
): void {
  writeLine(`Status: ${result.status}`);
  writeLine(`Write mode: ${result.writeMode}`);
  writeDescriptor(writeLine, "Runtime", result.runtimeSpace);
  if (result.activeSpace) {
    writeDescriptor(writeLine, "Persisted active", result.activeSpace);
  }
}

export function registerEmbeddingSpaceCliCommands(
  program: Command,
  deps: EmbeddingSpaceOperatorDeps,
): void {
  const writeLine = deps.writeLine ?? ((line: string) => console.log(line));
  const embeddingSpace = program
    .command("embedding-space")
    .description("Inspect or explicitly activate the persisted embedding space");

  embeddingSpace
    .command("status")
    .description("Show active embedding space and read-only state")
    .action(async () => {
      printStatus(await inspectEmbeddingSpace(deps), writeLine);
    });

  embeddingSpace
    .command("activate")
    .description("Explicitly register the runtime embedding space if none is active")
    .option("--confirm", "Confirm the first-registration-wins transition", false)
    .action(async (options: { confirm?: boolean }) => {
      const result = await activateEmbeddingSpace(deps, options.confirm === true);
      writeLine(`Activation: ${result.outcome}`);
      writeLine("Status: active");
      writeLine("Write mode: enabled");
      writeDescriptor(writeLine, "Persisted active", result.activeSpace);
    });
}
