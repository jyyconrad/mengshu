import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
} from "../../../packages/core/src/service/write-kernel.js";

/** OpenClaw only depends on the Runtime's provider-agnostic write seam. */
export interface MemoryWriteCommandExecutor {
  executeMemoryWrite(command: MemoryWriteCommand): Promise<MemoryWriteKernelResult>;
}

export function runtimeMemoryWriteCapability(
  runtime: unknown,
): MemoryWriteCommandExecutor | undefined {
  if (!runtime || typeof runtime !== "object") return undefined;
  const executeMemoryWrite = (runtime as { executeMemoryWrite?: unknown }).executeMemoryWrite;
  return typeof executeMemoryWrite === "function"
    ? { executeMemoryWrite: executeMemoryWrite.bind(runtime) }
    : undefined;
}
