export type SlotInvalidationOutboxSource = "asset" | "loadout";

export type SlotInvalidationEventType =
  | "asset.version.created"
  | "asset.status.changed"
  | "loadout.version.created";

export interface SlotInvalidationOutboxEvent {
  readonly source: SlotInvalidationOutboxSource;
  readonly eventId: string;
  readonly scopeFingerprint: string;
  readonly eventType: SlotInvalidationEventType;
  readonly occurredAt: number;
}

interface QueryResultLike {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface PostgresSlotInvalidationOutboxQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
}

export interface SlotInvalidationOutboxRepository {
  readPending(limit: number): Promise<readonly SlotInvalidationOutboxEvent[]>;
  ackPublished(event: SlotInvalidationOutboxEvent, publishedAt: number): Promise<boolean>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const ASSET_EVENTS = new Set<SlotInvalidationEventType>([
  "asset.version.created",
  "asset.status.changed",
]);

function safeInteger(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

function parseEvent(row: Record<string, unknown>): SlotInvalidationOutboxEvent {
  const source = row.source_kind;
  const eventId = row.event_id;
  const scopeFingerprint = row.scope_fingerprint;
  const eventType = row.event_type;
  const occurredAt = safeInteger(row.occurred_at);
  const eventMatchesSource = source === "asset"
    ? ASSET_EVENTS.has(eventType as SlotInvalidationEventType)
    : source === "loadout" && eventType === "loadout.version.created";
  if ((source !== "asset" && source !== "loadout") ||
      typeof eventId !== "string" || !SHA256.test(eventId) ||
      typeof scopeFingerprint !== "string" || !SHA256.test(scopeFingerprint) ||
      typeof eventType !== "string" || !eventMatchesSource || occurredAt === undefined) {
    throw new Error("Persisted slot invalidation outbox event is invalid");
  }
  return Object.freeze({
    source,
    eventId,
    scopeFingerprint,
    eventType: eventType as SlotInvalidationEventType,
    occurredAt,
  });
}

export class PostgresSlotInvalidationOutboxRepository
implements SlotInvalidationOutboxRepository {
  constructor(private readonly client: PostgresSlotInvalidationOutboxQueryClient) {}

  async readPending(limit: number): Promise<readonly SlotInvalidationOutboxEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Slot invalidation outbox batch size is invalid");
    }
    const result = await this.client.query(
      `/* slot-invalidation-outbox:read-pending */
SELECT source_kind, event_id, scope_fingerprint, event_type, occurred_at
FROM (
  SELECT 'asset'::text AS source_kind, event_id, scope_fingerprint, event_type, occurred_at
  FROM mengshu_asset_outbox
  WHERE published_at IS NULL
  UNION ALL
  SELECT 'loadout'::text AS source_kind, event_id, scope_fingerprint, event_type, occurred_at
  FROM mengshu_loadout_outbox
  WHERE published_at IS NULL
) AS pending
ORDER BY occurred_at, event_id
LIMIT $1`,
      [limit],
    );
    return Object.freeze((result.rows ?? []).map(parseEvent));
  }

  async ackPublished(event: SlotInvalidationOutboxEvent, publishedAt: number): Promise<boolean> {
    const persisted = parseEvent({
      source_kind: event.source,
      event_id: event.eventId,
      scope_fingerprint: event.scopeFingerprint,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
    });
    const timestamp = safeInteger(publishedAt);
    if (timestamp === undefined) throw new Error("Slot invalidation publishedAt is invalid");
    const table = persisted.source === "asset"
      ? "mengshu_asset_outbox"
      : "mengshu_loadout_outbox";
    const result = await this.client.query(
      `/* slot-invalidation-outbox:ack-${persisted.source} */
UPDATE ${table}
SET published_at = $2
WHERE event_id = $1 AND published_at IS NULL
RETURNING event_id`,
      [persisted.eventId, timestamp],
    );
    return result.rowCount === 1 || (result.rows?.length ?? 0) === 1;
  }
}

export interface SlotInvalidationDrainResult {
  readonly read: number;
  readonly invalidated: number;
  readonly acknowledged: number;
  readonly failures: readonly {
    readonly eventId: string;
    readonly reason: "invalidation_failed" | "ack_failed";
  }[];
}

export class SlotInvalidationOutboxConsumer {
  private readonly batchSize: number;

  constructor(private readonly options: {
    readonly repository: SlotInvalidationOutboxRepository;
    readonly invalidateScopeFingerprint: (scopeFingerprint: string) => void;
    readonly now?: () => number;
    readonly batchSize?: number;
  }) {
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error("Slot invalidation outbox batch size is invalid");
    }
  }

  async drainOnce(): Promise<SlotInvalidationDrainResult> {
    const events = await this.options.repository.readPending(this.batchSize);
    let invalidated = 0;
    let acknowledged = 0;
    const failures: Array<{ eventId: string; reason: "invalidation_failed" | "ack_failed" }> = [];
    for (const event of events) {
      try {
        this.options.invalidateScopeFingerprint(event.scopeFingerprint);
        invalidated += 1;
      } catch {
        failures.push({ eventId: event.eventId, reason: "invalidation_failed" });
        continue;
      }
      try {
        if (await this.options.repository.ackPublished(event, (this.options.now ?? Date.now)())) {
          acknowledged += 1;
        }
      } catch {
        failures.push({ eventId: event.eventId, reason: "ack_failed" });
      }
    }
    return Object.freeze({
      read: events.length,
      invalidated,
      acknowledged,
      failures: Object.freeze(failures),
    });
  }
}

export class SlotInvalidationOutboxLoop {
  private timer?: ReturnType<typeof setInterval>;
  private activeDrain?: Promise<void>;

  constructor(private readonly options: {
    readonly consumer: SlotInvalidationOutboxConsumer;
    readonly intervalMs?: number;
    readonly onError?: (error: unknown) => void;
  }) {
    const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) {
      throw new Error("Slot invalidation outbox interval is invalid");
    }
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 1_000;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeDrain;
  }

  private tick(): void {
    if (this.activeDrain) return;
    this.activeDrain = this.options.consumer.drainOnce()
      .then(() => undefined)
      .catch((error) => {
        try {
          this.options.onError?.(error);
        } catch {
          // Observability cannot stop the durable invalidation loop.
        }
      })
      .finally(() => {
        this.activeDrain = undefined;
      });
  }
}
