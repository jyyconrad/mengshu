import type { DurableJobV2Scope } from
  "../packages/core/src/storage/repositories/job-v2.js";
import type { NativeCommittedActiveDerivation } from "./native-extract-candidate-handler.js";

export interface ActiveDerivationOutboxEvent {
  readonly eventId: string;
  readonly storageKey: string;
  readonly memoryId: string;
  readonly scope: DurableJobV2Scope;
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly occurredAt: number;
  readonly derivationEligible: boolean;
}

interface QueryResultLike {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface ActiveDerivationOutboxClient {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
  release(): void;
}

export interface ActiveDerivationOutboxPool {
  connect(): Promise<ActiveDerivationOutboxClient>;
}

export interface ActiveDerivationOutboxRepository {
  claimPending(input: { readonly limit: number }): Promise<readonly ActiveDerivationOutboxEvent[]>;
  ackPublished(event: ActiveDerivationOutboxEvent, publishedAt: number): Promise<boolean>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const ROW_KEYS = Object.freeze([
  "event_id", "storage_key", "topic", "memory_id", "tenant_id", "user_id",
  "canonical_project_id", "product_id", "producer_id", "namespace", "visibility",
  "workspace_id", "session_id", "occurred_at",
  "derivation_eligible",
] as const);

function safeTime(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function exactRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted active derivation outbox event is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== ROW_KEYS.length ||
      keys.some((key) => typeof key !== "string" || !ROW_KEYS.includes(key as typeof ROW_KEYS[number]))) {
    throw new Error("Persisted active derivation outbox event is invalid");
  }
  for (const key of ROW_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Persisted active derivation outbox event is invalid");
    }
  }
  return value as Record<string, unknown>;
}

function parseEvent(value: unknown): ActiveDerivationOutboxEvent {
  const row = exactRow(value);
  const requiredIds = [
    row.memory_id, row.tenant_id, row.user_id, row.canonical_project_id, row.product_id,
    row.producer_id, row.namespace,
  ];
  const occurredAt = safeTime(row.occurred_at);
  if (row.topic !== "memory.written" || typeof row.event_id !== "string" ||
      !SHA256.test(row.event_id) || typeof row.storage_key !== "string" ||
      !SHA256.test(row.storage_key) || requiredIds.some((item) =>
        typeof item !== "string" || !SAFE_ID.test(item)) ||
      typeof row.visibility !== "string" || !VISIBILITIES.has(row.visibility) ||
      typeof row.workspace_id !== "string" || (row.workspace_id !== "" && !SAFE_ID.test(row.workspace_id)) ||
      typeof row.session_id !== "string" || (row.session_id !== "" && !SAFE_ID.test(row.session_id)) ||
      occurredAt === undefined || typeof row.derivation_eligible !== "boolean") {
    throw new Error("Persisted active derivation outbox event is invalid");
  }
  return Object.freeze({
    eventId: row.event_id,
    storageKey: row.storage_key,
    memoryId: row.memory_id as string,
    scope: Object.freeze({
      tenantId: row.tenant_id as string,
      userId: row.user_id as string,
      appId: row.product_id as string,
      projectId: row.canonical_project_id as string,
      agentId: row.producer_id as string,
      namespace: row.namespace as string,
      visibility: row.visibility as DurableJobV2Scope["visibility"],
    }),
    context: Object.freeze({
      ...(row.workspace_id === "" ? {} : { workspaceId: row.workspace_id as string }),
      ...(row.session_id === "" ? {} : { sessionId: row.session_id as string }),
    }),
    occurredAt,
    derivationEligible: row.derivation_eligible,
  });
}

function eventParams(event: ActiveDerivationOutboxEvent): readonly unknown[] {
  const scope = event.scope;
  return Object.freeze([
    event.eventId, scope.tenantId, scope.userId, scope.projectId, scope.appId, scope.agentId,
    scope.namespace, scope.visibility, event.context.workspaceId ?? "", event.context.sessionId ?? "",
  ]);
}

export class PostgresActiveDerivationOutboxRepository
implements ActiveDerivationOutboxRepository {
  constructor(private readonly pool: ActiveDerivationOutboxPool) {}

  async claimPending(input: { readonly limit: number }): Promise<readonly ActiveDerivationOutboxEvent[]> {
    if (!Number.isSafeInteger(input?.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("Active derivation outbox batch size is invalid");
    }
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      const result = await client.query(
        `SELECT outbox.event_id, outbox.storage_key, outbox.topic, outbox.memory_id,
  outbox.tenant_id, outbox.user_id,
  outbox.canonical_project_id, outbox.product_id, outbox.producer_id,
  outbox.namespace, outbox.visibility,
  COALESCE(outbox.workspace_id, '') AS workspace_id,
  COALESCE(outbox.session_id, '') AS session_id,
  floor(extract(epoch FROM outbox.occurred_at) * 1000)::text AS occurred_at,
  COALESCE((memory.data_type = 'memory'
    AND memory.lifecycle_status = 'active'
    AND memory.metadata->>'admissionRoute' = 'active'
    AND memory.metadata->>'contextEligible' = 'true'
    AND memory.metadata->>'memoryContainer' IN ('personal', 'project', 'team', 'enterprise')
    AND memory.legacy_quarantine_reason IS NULL), FALSE) AS derivation_eligible
FROM mengshu_write_outbox outbox
LEFT JOIN memories memory ON memory.id::text = outbox.memory_id
  AND memory.tenant_id = outbox.tenant_id AND memory.user_id = outbox.user_id
  AND memory.canonical_project_id = outbox.canonical_project_id
  AND memory.product_id = outbox.product_id AND memory.producer_id = outbox.producer_id
  AND memory.namespace = outbox.namespace AND memory.visibility = outbox.visibility
  AND COALESCE(memory.workspace_id, '') = COALESCE(outbox.workspace_id, '')
  AND COALESCE(
    memory.metadata->>'sessionId',
    memory.metadata #>> '{governance,provenance,sessionId}',
    ''
  ) = COALESCE(outbox.session_id, '')
  AND (
    memory.metadata->>'sessionId' IS NULL
    OR memory.metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR memory.metadata->>'sessionId' = memory.metadata #>> '{governance,provenance,sessionId}'
  )
WHERE outbox.published_at IS NULL
ORDER BY outbox.occurred_at, outbox.event_id
FOR UPDATE OF outbox SKIP LOCKED
LIMIT $1`,
        [input.limit],
      );
      const events = Object.freeze((result.rows ?? []).map(parseEvent));
      await client.query("COMMIT");
      return events;
    } catch (error) {
      if (begun) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Active derivation outbox claim failed");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async ackPublished(event: ActiveDerivationOutboxEvent, publishedAt: number): Promise<boolean> {
    const canonical = parseEvent({
      event_id: event.eventId,
      storage_key: event.storageKey,
      topic: "memory.written",
      memory_id: event.memoryId,
      tenant_id: event.scope.tenantId,
      user_id: event.scope.userId,
      canonical_project_id: event.scope.projectId,
      product_id: event.scope.appId,
      producer_id: event.scope.agentId,
      namespace: event.scope.namespace,
      visibility: event.scope.visibility,
      workspace_id: event.context.workspaceId ?? "",
      session_id: event.context.sessionId ?? "",
      occurred_at: event.occurredAt,
      derivation_eligible: event.derivationEligible,
    });
    const timestamp = safeTime(publishedAt);
    if (timestamp === undefined) throw new Error("Active derivation publishedAt is invalid");
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE mengshu_write_outbox
SET published_at = to_timestamp($11::double precision / 1000.0)
WHERE event_id = $1 AND tenant_id = $2 AND user_id = $3
  AND canonical_project_id = $4 AND product_id = $5 AND producer_id = $6
  AND namespace = $7 AND visibility = $8
  AND COALESCE(workspace_id, '') = $9 AND COALESCE(session_id, '') = $10
  AND topic = 'memory.written' AND memory_id = $12 AND storage_key = $13
  AND published_at IS NULL
RETURNING event_id`,
        [...eventParams(canonical), timestamp, canonical.memoryId, canonical.storageKey],
      );
      return result.rowCount === 1 || (result.rows?.length ?? 0) === 1;
    } finally {
      client.release();
    }
  }
}

export interface ActiveDerivationOutboxDrainResult {
  readonly read: number;
  readonly derived: number;
  readonly acknowledged: number;
  readonly failures: readonly {
    readonly eventId: string;
    readonly reason: "derivation_failed" | "ack_failed";
  }[];
}

export class ActiveDerivationOutboxConsumer {
  private readonly batchSize: number;

  constructor(private readonly options: {
    readonly repository: ActiveDerivationOutboxRepository;
    readonly deriveCommittedActive: NativeCommittedActiveDerivation;
    readonly now?: () => number;
    readonly batchSize?: number;
  }) {
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error("Active derivation outbox batch size is invalid");
    }
  }

  async drainOnce(): Promise<ActiveDerivationOutboxDrainResult> {
    const events = await this.options.repository.claimPending({ limit: this.batchSize });
    let derived = 0;
    let acknowledged = 0;
    const failures: Array<{
      eventId: string;
      reason: "derivation_failed" | "ack_failed";
    }> = [];
    for (const event of events) {
      if (event.derivationEligible) {
        try {
          await this.options.deriveCommittedActive({
            scope: event.scope,
            context: event.context,
            activeMemoryIds: Object.freeze([event.memoryId]),
            signal: new AbortController().signal,
          });
          derived += 1;
        } catch {
          failures.push({ eventId: event.eventId, reason: "derivation_failed" });
          continue;
        }
      }
      try {
        if (await this.options.repository.ackPublished(event, (this.options.now ?? Date.now)())) {
          acknowledged += 1;
        } else {
          failures.push({ eventId: event.eventId, reason: "ack_failed" });
        }
      } catch {
        failures.push({ eventId: event.eventId, reason: "ack_failed" });
      }
    }
    return Object.freeze({
      read: events.length,
      derived,
      acknowledged,
      failures: Object.freeze(failures),
    });
  }
}

export class ActiveDerivationOutboxLoop {
  private timer?: ReturnType<typeof setInterval>;
  private activeDrain?: Promise<void>;

  constructor(private readonly options: {
    readonly consumer: ActiveDerivationOutboxConsumer;
    readonly intervalMs?: number;
    readonly onError?: () => void;
  }) {
    const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) {
      throw new Error("Active derivation outbox interval is invalid");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 1_000);
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
      .catch(() => {
        try {
          this.options.onError?.();
        } catch {
          // Observability cannot stop the durable repair loop.
        }
      })
      .finally(() => {
        this.activeDrain = undefined;
      });
  }
}
