import { createHash } from "node:crypto";

export type MigrationKind = "expand" | "contract";

export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly kind: MigrationKind;
  readonly statements: readonly string[];
  readonly checksum?: string;
}

export interface AppliedSchemaMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface SchemaMigrationPlan {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly currentSchemaVersion: number;
  readonly pending: readonly SchemaMigration[];
}

export interface SchemaMigrationPlanOptions {
  readonly migrations?: readonly SchemaMigration[];
  readonly currentSchemaVersion?: number;
}

const EXPAND_ONLY_SQL = /^(?:CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|EXTENSION)\b|ALTER\s+TABLE\b[\s\S]*\bADD\s+(?:COLUMN|CONSTRAINT)\b)/i;
const DESTRUCTIVE_OR_MULTIPLE_SQL = /\b(?:DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b|;\s*\S/i;
const AUTHORITY_DEDUPE_TABLES = ["memories", "knowledge"] as const;
const AUTHORITY_DEDUPE_COLUMNS =
  "tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, content_hash";

const AUTHORITY_DEDUPE_CONTRACT_STATEMENTS = AUTHORITY_DEDUPE_TABLES.flatMap((table) => [
    `CREATE UNIQUE INDEX ${table}_authority_content_hash_uidx ON ${table} (${AUTHORITY_DEDUPE_COLUMNS})`,
    `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_content_hash_key`,
    `DROP INDEX IF EXISTS ${table}_content_hash_idx`,
  ]);

export const DURABLE_JOB_STATE_CONSTRAINT_NAME = "mengshu_jobs_v2_state_check";

/**
 * PostgreSQL ARE rejects repetition upper bounds above 255 at row-validation
 * time. The immutable v5 schema used `{32,256}` for lease_token, so a queued
 * job could be inserted but its first lease UPDATE failed. v10 replaces only
 * that generated state constraint and keeps the 32..256 contract via explicit
 * char_length checks plus an unbounded character-class regex.
 */
const DURABLE_JOB_STATE_CONTRACT_STATEMENTS = [
  "ALTER TABLE mengshu_jobs_v2 DROP CONSTRAINT IF EXISTS mengshu_jobs_v2_check4",
  `ALTER TABLE mengshu_jobs_v2 ADD CONSTRAINT ${DURABLE_JOB_STATE_CONSTRAINT_NAME} CHECK (
    (status = 'queued'
      AND attempts = 0
      AND next_attempt_at IS NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL
      AND last_error_code IS NULL)
    OR
    (status = 'running'
      AND attempts >= 1
      AND next_attempt_at IS NULL
      AND lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
      AND char_length(lease_token) BETWEEN 32 AND 256
      AND lease_token ~ '^[A-Za-z0-9._~-]+$'
      AND heartbeat_at >= created_at
      AND heartbeat_at <= updated_at
      AND lease_until > heartbeat_at
      AND lease_until > updated_at)
    OR
    (status = 'retry_wait'
      AND attempts >= 1
      AND attempts < max_attempts
      AND next_attempt_at >= updated_at
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL
      AND last_error_code IS NOT NULL)
    OR
    (status = 'completed'
      AND attempts >= 1
      AND next_attempt_at IS NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL)
    OR
    (status = 'dead_letter'
      AND attempts >= 1
      AND next_attempt_at IS NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL
      AND last_error_code IS NOT NULL)
  )`,
] as const;

const CONTRACT_STATEMENTS_BY_VERSION = new Map<number, readonly string[]>([
  [6, AUTHORITY_DEDUPE_CONTRACT_STATEMENTS],
  [10, DURABLE_JOB_STATE_CONTRACT_STATEMENTS],
]);

export function schemaMigrationChecksum(migration: SchemaMigration): string {
  const input = JSON.stringify({
    version: migration.version,
    name: migration.name,
    kind: migration.kind,
    statements: migration.statements,
  });
  return createHash("sha256").update(input).digest("hex");
}

function withChecksum(migration: SchemaMigration): SchemaMigration {
  return Object.freeze({
    version: migration.version,
    name: migration.name,
    kind: migration.kind,
    statements: Object.freeze([...migration.statements]),
    checksum: schemaMigrationChecksum(migration),
  });
}

const P0_B_SCOPE_COLUMNS = [
  "tenant_id",
  "canonical_project_id",
  "product_id",
  "producer_id",
  "namespace",
  "visibility",
  "lifecycle_status",
  "embedding_space_id",
  "embedding_space_state",
  "legacy_quarantine_reason",
  "scope_key",
] as const;

const P0_B_SCOPE_TABLES = ["memories", "knowledge"] as const;

const P0_B_SCOPE_COLUMN_STATEMENTS = P0_B_SCOPE_TABLES.flatMap((table) =>
  P0_B_SCOPE_COLUMNS.map(
    (column) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT`,
  ));

const P0_B_SCOPE_INDEX_STATEMENTS = P0_B_SCOPE_TABLES.flatMap((table) => [
  `CREATE INDEX IF NOT EXISTS ${table}_scope_key_idx ON ${table} (scope_key)`,
  `CREATE INDEX IF NOT EXISTS ${table}_canonical_scope_idx ON ${table} (tenant_id, user_id, canonical_project_id, product_id, namespace, visibility)`,
  `CREATE INDEX IF NOT EXISTS ${table}_producer_id_idx ON ${table} (producer_id)`,
  `CREATE INDEX IF NOT EXISTS ${table}_embedding_space_idx ON ${table} (embedding_space_id, embedding_space_state)`,
  `CREATE INDEX IF NOT EXISTS ${table}_lifecycle_status_idx ON ${table} (lifecycle_status)`,
  `CREATE INDEX IF NOT EXISTS ${table}_legacy_quarantine_reason_idx ON ${table} (legacy_quarantine_reason) WHERE legacy_quarantine_reason IS NOT NULL`,
]);

const MIGRATION_DEFINITIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: "add-schema-ledger-applied-at-index",
    kind: "expand",
    statements: [
      "CREATE INDEX IF NOT EXISTS mengshu_schema_migrations_applied_at_idx ON mengshu_schema_migrations (applied_at)",
    ],
  },
  {
    version: 2,
    name: "add-scope-producer-embedding-lifecycle-columns",
    kind: "expand",
    statements: [
      ...P0_B_SCOPE_COLUMN_STATEMENTS,
      ...P0_B_SCOPE_INDEX_STATEMENTS,
    ],
  },
  {
    version: 3,
    name: "add-active-embedding-space-registry",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_embedding_spaces (
  embedding_space_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  normalization TEXT NOT NULL CHECK (normalization IN ('none', 'l2')),
  state TEXT NOT NULL CHECK (state IN ('known-queryable', 'reembedded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_active_embedding_space (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'active'),
  embedding_space_id TEXT NOT NULL REFERENCES mengshu_embedding_spaces (embedding_space_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
  },
  {
    version: 4,
    name: "add-transactional-forget-journal",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_forget_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_project_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  before_state JSONB,
  after_state JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (idempotency_key, target_id, action)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_forget_outbox (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (topic IN ('memory.lifecycle.changed', 'memory.deleted')),
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_project_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_forget_receipts (
  idempotency_key TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
      "CREATE INDEX IF NOT EXISTS mengshu_forget_audit_target_idx ON mengshu_forget_audit (tenant_id, user_id, target_id, occurred_at DESC)",
      "CREATE INDEX IF NOT EXISTS mengshu_forget_outbox_pending_idx ON mengshu_forget_outbox (occurred_at, event_id) WHERE published_at IS NULL",
      "CREATE INDEX IF NOT EXISTS mengshu_forget_receipts_created_idx ON mengshu_forget_receipts (created_at DESC)",
    ],
  },
  {
    version: 5,
    name: "add-durable-job-v2-queue",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_jobs_v2 (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  dedupe_key TEXT NOT NULL,
  scoped_dedupe_key TEXT NOT NULL CHECK (scoped_dedupe_key ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'retry_wait', 'running', 'completed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  next_attempt_at BIGINT CHECK (next_attempt_at IS NULL OR next_attempt_at >= 0),
  lease_owner TEXT,
  lease_token TEXT,
  lease_until BIGINT CHECK (lease_until IS NULL OR lease_until >= 0),
  heartbeat_at BIGINT CHECK (heartbeat_at IS NULL OR heartbeat_at >= 0),
  last_error_code TEXT,
  last_error_retryable BOOLEAN,
  last_error_fingerprint TEXT,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (type ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  CHECK (char_length(dedupe_key) BETWEEN 1 AND 256 AND dedupe_key !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 256 AND tenant_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(user_id) BETWEEN 1 AND 256 AND user_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(app_id) BETWEEN 1 AND 256 AND app_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(project_id) BETWEEN 1 AND 256 AND project_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(agent_id) BETWEEN 1 AND 256 AND agent_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(namespace) BETWEEN 1 AND 256 AND namespace !~ '[[:space:][:cntrl:]]'),
  CHECK (attempts <= max_attempts),
  CHECK (lease_generation = attempts),
  CHECK (
    (last_error_code IS NULL AND last_error_retryable IS NULL AND last_error_fingerprint IS NULL)
    OR
    (last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
      AND last_error_retryable IS NOT NULL
      AND last_error_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  CHECK (
    (status = 'queued'
      AND attempts = 0
      AND next_attempt_at IS NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL
      AND last_error_code IS NULL)
    OR
    (status = 'running'
      AND attempts >= 1
      AND next_attempt_at IS NULL
      AND lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
      AND lease_token ~ '^[A-Za-z0-9._~-]{32,256}$'
      AND heartbeat_at >= created_at
      AND heartbeat_at <= updated_at
      AND lease_until > heartbeat_at
      AND lease_until > updated_at)
    OR
    (status = 'retry_wait'
      AND attempts >= 1
      AND attempts < max_attempts
      AND next_attempt_at >= updated_at
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL
      AND last_error_code IS NOT NULL)
    OR
    (status = 'completed'
      AND attempts >= 1
      AND next_attempt_at IS NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL)
    OR
    (status = 'dead_letter'
      AND attempts >= 1
      AND next_attempt_at IS NULL
      AND lease_owner IS NULL AND lease_token IS NULL
      AND lease_until IS NULL AND heartbeat_at IS NULL
      AND last_error_code IS NOT NULL)
  )
)`,
      "CREATE UNIQUE INDEX IF NOT EXISTS mengshu_jobs_v2_scoped_dedupe_uidx ON mengshu_jobs_v2 (scoped_dedupe_key)",
      `CREATE INDEX IF NOT EXISTS mengshu_jobs_v2_queued_idx ON mengshu_jobs_v2 (
  tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, created_at, id
) WHERE status = 'queued'`,
      `CREATE INDEX IF NOT EXISTS mengshu_jobs_v2_retry_idx ON mengshu_jobs_v2 (
  tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, next_attempt_at, created_at, id
) WHERE status = 'retry_wait'`,
      `CREATE INDEX IF NOT EXISTS mengshu_jobs_v2_expired_lease_idx ON mengshu_jobs_v2 (
  tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, lease_until, created_at, id
) WHERE status = 'running'`,
      `CREATE INDEX IF NOT EXISTS mengshu_jobs_v2_status_updated_idx ON mengshu_jobs_v2 (
  tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, status, updated_at DESC, id
) WHERE status IN ('completed', 'dead_letter')`,
      `CREATE TABLE IF NOT EXISTS mengshu_jobs_v2_legacy_quarantine (
  legacy_table_name TEXT NOT NULL DEFAULT 'mengshu_jobs',
  legacy_job_id TEXT NOT NULL,
  legacy_status TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  error_fingerprint TEXT CHECK (error_fingerprint IS NULL OR error_fingerprint ~ '^[0-9a-f]{64}$'),
  sanitized_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sanitized_metadata) = 'object'),
  observed_at BIGINT NOT NULL CHECK (observed_at >= 0),
  resolution TEXT,
  resolved_at BIGINT CHECK (resolved_at IS NULL OR resolved_at >= observed_at),
  PRIMARY KEY (legacy_table_name, legacy_job_id),
  CHECK ((resolution IS NULL AND resolved_at IS NULL) OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_jobs_v2_legacy_quarantine_reason_idx
ON mengshu_jobs_v2_legacy_quarantine (reason_code, observed_at, legacy_job_id)
WHERE resolved_at IS NULL`,
    ],
  },
  {
    version: 6,
    name: "scope-content-hash-dedupe",
    kind: "contract",
    statements: AUTHORITY_DEDUPE_CONTRACT_STATEMENTS,
  },
  {
    version: 7,
    name: "add-durable-job-v2-effect-receipts",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_job_v2_effect_receipts (
  job_id TEXT NOT NULL REFERENCES mengshu_jobs_v2 (id),
  effect_key TEXT NOT NULL CHECK (effect_key ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  committed_at BIGINT NOT NULL CHECK (committed_at >= 0),
  PRIMARY KEY (job_id, effect_key)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_job_v2_effect_receipts_committed_idx
ON mengshu_job_v2_effect_receipts (committed_at, job_id, effect_key)`,
    ],
  },
  {
    version: 8,
    name: "add-durable-candidate-zone",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  source_job_id TEXT REFERENCES mengshu_jobs_v2 (id),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  active_content_hash TEXT CHECK (active_content_hash IS NULL OR active_content_hash ~ '^[0-9a-f]{64}$'),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 100000),
  semantic_type TEXT CHECK (semantic_type IS NULL OR semantic_type IN ('profile', 'task_context', 'rules', 'experience', 'resource')),
  kind TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT,
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_ids) = 'array'),
  extractor TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'archived', 'expired')),
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT CHECK (updated_at IS NULL OR updated_at >= created_at),
  last_hit_at BIGINT CHECK (last_hit_at IS NULL OR last_hit_at >= created_at),
  promoted_to_memory_id TEXT,
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 256 AND tenant_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(user_id) BETWEEN 1 AND 256 AND user_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(app_id) BETWEEN 1 AND 256 AND app_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(project_id) BETWEEN 1 AND 256 AND project_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(agent_id) BETWEEN 1 AND 256 AND agent_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(namespace) BETWEEN 1 AND 256 AND namespace !~ '[[:space:][:cntrl:]]'),
  CHECK (workspace_id = '' OR (char_length(workspace_id) BETWEEN 1 AND 256 AND workspace_id !~ '[[:space:][:cntrl:]]')),
  CHECK (session_id = '' OR (char_length(session_id) BETWEEN 1 AND 256 AND session_id !~ '[[:space:][:cntrl:]]')),
  CHECK (char_length(kind) BETWEEN 1 AND 256 AND kind !~ '[[:space:][:cntrl:]]'),
  CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CHECK (extractor IS NULL OR (char_length(extractor) BETWEEN 1 AND 256 AND extractor !~ '[[:space:][:cntrl:]]')),
  CHECK (promoted_to_memory_id IS NULL OR (char_length(promoted_to_memory_id) BETWEEN 1 AND 256 AND promoted_to_memory_id !~ '[[:space:][:cntrl:]]')),
  CHECK (btrim(text) <> ''),
  CHECK (
    (status = 'pending' AND active_content_hash = content_hash)
    OR
    (status <> 'pending' AND active_content_hash IS NULL)
  ),
  UNIQUE (tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, active_content_hash)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_candidates_scope_status_created_idx ON mengshu_candidates (
  tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, status, created_at DESC, id
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_candidates_source_job_idx
ON mengshu_candidates (source_job_id, created_at, id)
WHERE source_job_id IS NOT NULL`,
    ],
  },
  {
    version: 9,
    name: "add-durable-tree-and-graph",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_tree_leaves (
  id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  source_job_id TEXT NOT NULL REFERENCES mengshu_jobs_v2 (id),
  chunk_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entity_ids) = 'array'),
  importance DOUBLE PRECISION NOT NULL CHECK (importance >= 0 AND importance <= 1),
  event_at BIGINT NOT NULL CHECK (event_at >= 0),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 100000 AND btrim(text) <> ''),
  token_count INTEGER NOT NULL CHECK (token_count >= 1),
  PRIMARY KEY (scope_fingerprint, id),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(chunk_id) BETWEEN 1 AND 256 AND chunk_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(source_id) BETWEEN 1 AND 256 AND source_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_tree_leaves_scope_event_idx ON mengshu_tree_leaves (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, event_at, id
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_tree_buffers (
  id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  tree_type TEXT NOT NULL CHECK (tree_type IN ('source', 'topic', 'global')),
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  leaf_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(leaf_ids) = 'array'),
  child_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(child_node_ids) = 'array'),
  token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  opened_at BIGINT NOT NULL CHECK (opened_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= opened_at),
  seal_after_at BIGINT CHECK (seal_after_at IS NULL OR seal_after_at >= opened_at),
  PRIMARY KEY (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, tree_type, tree_key, level),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(tree_key) BETWEEN 1 AND 256 AND tree_key !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_tree_summary_nodes (
  id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  sealed_by_job_id TEXT NOT NULL REFERENCES mengshu_jobs_v2 (id),
  tree_type TEXT NOT NULL CHECK (tree_type IN ('source', 'topic', 'global')),
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 1000),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 100000),
  child_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(child_node_ids) = 'array'),
  leaf_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(leaf_ids) = 'array'),
  evidence_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_chunk_ids) = 'array'),
  entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entity_ids) = 'array'),
  relation_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(relation_ids) = 'array'),
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  start_at BIGINT NOT NULL CHECK (start_at >= 0),
  end_at BIGINT NOT NULL CHECK (end_at >= start_at),
  status TEXT NOT NULL CHECK (status IN ('open', 'sealed', 'stale', 'archived')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  sealed_at BIGINT CHECK (sealed_at IS NULL OR sealed_at >= created_at),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (scope_fingerprint, id),
  CHECK ((status = 'sealed' AND sealed_at IS NOT NULL) OR status <> 'sealed'),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(tree_key) BETWEEN 1 AND 256 AND tree_key !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_tree_summary_scope_idx ON mengshu_tree_summary_nodes (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, tree_type, tree_key, level, sealed_at, id
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_entities (
  id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  canonical_name TEXT NOT NULL CHECK (char_length(canonical_name) BETWEEN 1 AND 1000),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 1000),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'project', 'repo', 'file', 'topic', 'tool', 'task', 'concept', 'user', 'agent', 'chunk', 'document', 'other')),
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(aliases) = 'array'),
  mention_count INTEGER NOT NULL CHECK (mention_count >= 0),
  mention_count_30d INTEGER NOT NULL CHECK (mention_count_30d >= 0),
  distinct_source_count INTEGER NOT NULL CHECK (distinct_source_count >= 0),
  last_seen_at BIGINT CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
  hotness DOUBLE PRECISION NOT NULL CHECK (hotness >= 0),
  graph_centrality DOUBLE PRECISION CHECK (graph_centrality IS NULL OR graph_centrality >= 0),
  query_hits_30d INTEGER NOT NULL CHECK (query_hits_30d >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'merged')),
  merged_into TEXT,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, entity_type, canonical_name),
  FOREIGN KEY (scope_fingerprint, merged_into)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (merged_into IS NULL OR (char_length(merged_into) BETWEEN 1 AND 256 AND merged_into !~ '[[:space:][:cntrl:]]'))
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entities_scope_name_idx ON mengshu_graph_entities (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, canonical_name, entity_type, id
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_relations (
  id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL CHECK (predicate IN ('mentions', 'works_on', 'uses', 'owns', 'depends_on', 'decided', 'prefers', 'blocked_by', 'fixed_by', 'supersedes', 'related_to', 'belongs_to', 'precedes', 'conflicts_with')),
  object_id TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  evidence_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_chunk_ids) = 'array'),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 1),
  first_seen_at BIGINT NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at BIGINT NOT NULL CHECK (last_seen_at >= first_seen_at),
  status TEXT NOT NULL CHECK (status IN ('active', 'weak', 'contradicted', 'archived')),
  source_kinds JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_kinds) = 'array'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (scope_fingerprint, id),
  FOREIGN KEY (scope_fingerprint, subject_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  FOREIGN KEY (scope_fingerprint, object_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (subject_id <> object_id),
  CHECK (evidence_count = jsonb_array_length(evidence_chunk_ids))
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_relations_scope_subject_idx ON mengshu_graph_relations (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, subject_id, predicate, id
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_relations_scope_object_idx ON mengshu_graph_relations (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, object_id, predicate, id
)`,
    ],
  },
  {
    version: 10,
    name: "repair-durable-job-lease-token-check",
    kind: "contract",
    statements: DURABLE_JOB_STATE_CONTRACT_STATEMENTS,
  },
  {
    version: 11,
    name: "add-atomic-memory-write-journal",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_write_receipts (
  storage_key TEXT PRIMARY KEY CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_write_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  storage_key TEXT NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'memory.store'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_project_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (storage_key, memory_id, action)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_write_outbox (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  topic TEXT NOT NULL CHECK (topic = 'memory.written'),
  memory_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  canonical_project_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  UNIQUE (storage_key, topic, memory_id)
)`,
      "CREATE INDEX IF NOT EXISTS mengshu_write_audit_scope_memory_idx ON mengshu_write_audit (tenant_id, user_id, canonical_project_id, product_id, memory_id, occurred_at DESC)",
      "CREATE INDEX IF NOT EXISTS mengshu_write_outbox_pending_idx ON mengshu_write_outbox (occurred_at, event_id) WHERE published_at IS NULL",
      "CREATE INDEX IF NOT EXISTS mengshu_write_receipts_created_idx ON mengshu_write_receipts (created_at DESC, storage_key)",
    ],
  },
  {
    version: 12,
    name: "add-embedding-reembed-shadow-journal",
    kind: "expand",
    statements: [
      `ALTER TABLE mengshu_embedding_spaces ADD COLUMN IF NOT EXISTS queryability_state TEXT
CHECK (queryability_state IS NULL OR queryability_state IN ('known-queryable', 'unknown-unqueryable'))`,
      `CREATE INDEX IF NOT EXISTS mengshu_embedding_spaces_queryability_idx
ON mengshu_embedding_spaces (queryability_state, embedding_space_id)`,
      `CREATE TABLE IF NOT EXISTS mengshu_embedding_reembed_shadow (
  migration_id TEXT NOT NULL CHECK (migration_id ~ '^[0-9a-f]{64}$'),
  table_name TEXT NOT NULL CHECK (table_name IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  source_content_hash TEXT NOT NULL,
  old_vector vector NOT NULL,
  old_embedding_space_id TEXT,
  old_embedding_space_state TEXT,
  old_metadata JSONB NOT NULL CHECK (jsonb_typeof(old_metadata) = 'object'),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (migration_id, table_name, record_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_embedding_reembed_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
  migration_id TEXT NOT NULL CHECK (migration_id ~ '^[0-9a-f]{64}$'),
  table_name TEXT NOT NULL CHECK (table_name IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('validated', 'applied', 'rolled-back')),
  target_embedding_space_id TEXT NOT NULL REFERENCES mengshu_embedding_spaces (embedding_space_id),
  target_vector_sha256 TEXT NOT NULL CHECK (target_vector_sha256 ~ '^[0-9a-f]{64}$'),
  source_snapshot_sha256 TEXT NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (migration_id, table_name, record_id, operation)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_embedding_reembed_shadow_record_idx
ON mengshu_embedding_reembed_shadow (table_name, record_id, captured_at DESC)`,
      `CREATE INDEX IF NOT EXISTS mengshu_embedding_reembed_receipts_migration_idx
ON mengshu_embedding_reembed_receipts (migration_id, operation, table_name, record_id)`,
    ],
  },
];

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = Object.freeze(
  MIGRATION_DEFINITIONS.map(withChecksum),
);

export const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.length;

function assertMigrationSqlSafety(migration: SchemaMigration): void {
  if (migration.statements.length === 0) {
    throw new Error(`Migration ${migration.version} must contain at least one SQL statement`);
  }
  if (migration.kind !== "expand" && migration.kind !== "contract") {
    throw new Error(`Migration ${migration.version} has an invalid kind`);
  }
  if (migration.kind === "contract") {
    const allowedStatements = CONTRACT_STATEMENTS_BY_VERSION.get(migration.version);
    if (!allowedStatements || migration.statements.length !== allowedStatements.length) {
      throw new Error(`Migration ${migration.version} contract SQL must be complete and ordered`);
    }
    for (const [index, statement] of migration.statements.entries()) {
      const normalized = statement.trim().replace(/;+$/, "").trim();
      const expected = allowedStatements[index]?.trim().replace(/;+$/, "").trim();
      if (expected === undefined || normalized !== expected) {
        throw new Error(`Migration ${migration.version} contract SQL is not allowlisted`);
      }
    }
    return;
  }
  for (const statement of migration.statements) {
    const normalized = statement.trim().replace(/;+$/, "").trim();
    if (!EXPAND_ONLY_SQL.test(normalized) || DESTRUCTIVE_OR_MULTIPLE_SQL.test(normalized)) {
      throw new Error(
        `Migration ${migration.version} contains non expand-only SQL: ${normalized.split(/\s+/).slice(0, 3).join(" ")}`,
      );
    }
  }
}

/** Fail-closed validation for the immutable, ordered migration registry. */
export function validateMigrationRegistry(
  migrations: readonly SchemaMigration[],
  currentSchemaVersion: number,
): void {
  if (!Number.isInteger(currentSchemaVersion) || currentSchemaVersion < 0) {
    throw new Error("Current schema version must be a non-negative integer");
  }
  if (migrations.length !== currentSchemaVersion) {
    throw new Error(
      `Migration registry is missing versions: expected ${currentSchemaVersion}, found ${migrations.length}`,
    );
  }

  const seen = new Set<number>();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`Migration version must be a positive integer: ${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    seen.add(migration.version);

    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration registry is out of order or missing version ${expectedVersion}; found ${migration.version}`,
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(migration.name)) {
      throw new Error(`Migration ${migration.version} has an invalid name: ${migration.name}`);
    }
    assertMigrationSqlSafety(migration);

    const expectedChecksum = schemaMigrationChecksum(migration);
    if (migration.checksum !== undefined && migration.checksum !== expectedChecksum) {
      throw new Error(`Migration ${migration.version} registry checksum mismatch`);
    }
  }
}

function normalizeRegistry(
  migrations: readonly SchemaMigration[],
  currentSchemaVersion: number,
): readonly SchemaMigration[] {
  validateMigrationRegistry(migrations, currentSchemaVersion);
  return migrations.map(withChecksum);
}

/**
 * Pure dry-run planner. It performs no I/O and rejects any ledger that is not an
 * exact, ordered prefix of the local registry.
 */
export function planSchemaMigrations(
  applied: readonly AppliedSchemaMigration[],
  options: SchemaMigrationPlanOptions = {},
): SchemaMigrationPlan {
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  const currentSchemaVersion = options.currentSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  const registry = normalizeRegistry(migrations, currentSchemaVersion);

  const seen = new Set<number>();
  let previousVersion = 0;
  for (const entry of applied) {
    if (seen.has(entry.version)) {
      throw new Error(`Duplicate applied migration version: ${entry.version}`);
    }
    seen.add(entry.version);
    if (entry.version <= previousVersion) {
      throw new Error(`Applied migration ledger is out of order at version ${entry.version}`);
    }
    previousVersion = entry.version;
  }

  for (let index = 0; index < applied.length; index += 1) {
    const entry = applied[index]!;
    if (entry.version > currentSchemaVersion || !registry[entry.version - 1]) {
      throw new Error(
        `Database schema version ${entry.version} is newer or unknown; current runtime supports ${currentSchemaVersion}`,
      );
    }
    const expectedVersion = index + 1;
    if (entry.version !== expectedVersion) {
      throw new Error(
        `Applied migration ledger is missing prefix version ${expectedVersion}; found ${entry.version}`,
      );
    }

    const expected = registry[entry.version - 1]!;
    if (entry.name !== expected.name) {
      throw new Error(`Migration ${entry.version} name mismatch`);
    }
    if (entry.checksum !== expected.checksum) {
      throw new Error(`Migration ${entry.version} checksum mismatch`);
    }
  }

  const fromVersion = applied.length;
  return {
    fromVersion,
    toVersion: currentSchemaVersion,
    currentSchemaVersion,
    pending: registry.slice(fromVersion),
  };
}

validateMigrationRegistry(SCHEMA_MIGRATIONS, CURRENT_SCHEMA_VERSION);
