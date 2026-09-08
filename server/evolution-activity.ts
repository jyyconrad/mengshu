import { statfs } from "node:fs/promises";

/** Host-local activity and manifest/storage filesystem, not an estimate of remote PostgreSQL free space. */
export class EvolutionActivity {
  private active = 0;
  private lastForegroundAt: number;
  private sample?: { at: number; freeBytes: number };
  private readonly now: () => number;
  constructor(private readonly home: string, private readonly options: {
    now?: () => number; statfs?: (path: string) => Promise<{ bavail: bigint; bsize: bigint }>;
  } = {}) { this.now = options.now ?? Date.now; this.lastForegroundAt = this.now(); }
  begin(): () => void {
    this.active++; this.lastForegroundAt = this.now();
    let ended = false;
    return () => { if (!ended) { ended = true; this.active--; this.lastForegroundAt = this.now(); } };
  }
  snapshot() {
    const age = this.sample ? this.now() - this.sample.at : -1;
    return { foregroundBusy: this.active > 0, lastForegroundAt: this.lastForegroundAt,
      localFreeBytes: age >= 0 && age <= 30_000 ? this.sample!.freeBytes : null };
  }
  async refreshStorage(signal: AbortSignal): Promise<void> {
    this.sample = undefined; signal.throwIfAborted();
    const sample = this.options.statfs ?? (path => statfs(path, { bigint: true }));
    try {
      const space = await sample(this.home); signal.throwIfAborted();
      const bytes = space.bavail * space.bsize;
      if (bytes < 0 || bytes > BigInt(Number.MAX_SAFE_INTEGER)) return;
      this.sample = { at: this.now(), freeBytes: Number(bytes) };
    } catch { signal.throwIfAborted(); }
  }
}
