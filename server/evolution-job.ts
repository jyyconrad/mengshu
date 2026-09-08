import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { deterministicUuid } from "../packages/core/src/scoring/hash-utils.js";

export function evolutionJobIdentity(scope: MemoryScope, batchId: string, segmentAttempt: number): { id: string; dedupeKey: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId) || !Number.isSafeInteger(segmentAttempt) || segmentAttempt < 1) {
    throw new Error("EVOLUTION_SEGMENT_INVALID");
  }
  const dedupeKey = `evolve_memory_batch:${batchId}:${segmentAttempt}`;
  return { id: deterministicUuid(`${authorityScopeFingerprint(scope)}:${dedupeKey}`), dedupeKey };
}
