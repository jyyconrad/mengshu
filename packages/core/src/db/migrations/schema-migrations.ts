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

const EVIDENCE_FIRST_ACTIVE_MEMORY_DEDUPE_CONTRACT_STATEMENTS = [
  `CREATE UNIQUE INDEX memories_active_authority_content_hash_uidx ON memories (${AUTHORITY_DEDUPE_COLUMNS})
WHERE lifecycle_status = 'active'`,
  "DROP INDEX memories_authority_content_hash_uidx",
  "ALTER INDEX memories_active_authority_content_hash_uidx RENAME TO memories_authority_content_hash_uidx",
] as const;

const GOVERNED_DOCUMENT_ASSET_CONTRACT_STATEMENTS = [
  `ALTER TABLE mengshu_asset_versions
  DROP CONSTRAINT IF EXISTS mengshu_asset_versions_kind_check,
  ADD CONSTRAINT mengshu_asset_versions_kind_check CHECK (kind IN ('memory_view', 'memory_document', 'tree_document', 'index_document'))`,
  `ALTER TABLE mengshu_asset_versions
  DROP CONSTRAINT IF EXISTS mengshu_asset_versions_status_check,
  ADD CONSTRAINT mengshu_asset_versions_status_check CHECK (status IN ('draft', 'review', 'published', 'active', 'deprecated', 'revoked'))`,
] as const;

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
  [18, EVIDENCE_FIRST_ACTIVE_MEMORY_DEDUPE_CONTRACT_STATEMENTS],
  [26, GOVERNED_DOCUMENT_ASSET_CONTRACT_STATEMENTS],
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
  {
    version: 13,
    name: "add-durable-work-memory-graph",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_work_memory_nodes (
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
  node_type TEXT NOT NULL CHECK (node_type IN ('evidence', 'memory', 'summary', 'skill_candidate')),
  record_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 1000 AND btrim(label) <> ''),
  evidence_kind TEXT CHECK (evidence_kind IN ('chunk', 'observation', 'document', 'message', 'resource')),
  semantic_type TEXT CHECK (semantic_type IN ('profile', 'task_context', 'rules', 'experience', 'resource')),
  lifecycle_status TEXT CHECK (lifecycle_status IN ('active', 'archived', 'revoked', 'superseded', 'promoted')),
  tree_type TEXT CHECK (tree_type IN ('source', 'topic', 'global')),
  level INTEGER CHECK (level BETWEEN 0 AND 3),
  skill_candidate_status TEXT CHECK (skill_candidate_status IN ('pending', 'active', 'archived', 'rejected')),
  evidence_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_memory_ids) = 'array'),
  evidence_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_chunk_ids) = 'array'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT CHECK (updated_at IS NULL OR updated_at >= created_at),
  PRIMARY KEY (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, node_type, record_id),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(record_id) BETWEEN 1 AND 256 AND record_id !~ '[[:space:][:cntrl:]]'),
  CHECK (
    (node_type = 'evidence' AND evidence_kind IS NOT NULL AND semantic_type IS NULL
      AND lifecycle_status IS NULL AND tree_type IS NULL AND level IS NULL
      AND skill_candidate_status IS NULL AND jsonb_array_length(evidence_memory_ids) = 0
      AND jsonb_array_length(evidence_chunk_ids) = 0)
    OR
    (node_type = 'memory' AND evidence_kind IS NULL AND lifecycle_status IS NOT NULL
      AND tree_type IS NULL AND level IS NULL AND skill_candidate_status IS NULL
      AND jsonb_array_length(evidence_memory_ids) = 0
      AND jsonb_array_length(evidence_chunk_ids) >= 1)
    OR
    (node_type = 'summary' AND evidence_kind IS NULL AND semantic_type IS NULL
      AND lifecycle_status IS NULL AND tree_type IS NOT NULL AND level IS NOT NULL
      AND skill_candidate_status IS NULL AND jsonb_array_length(evidence_memory_ids) = 0
      AND jsonb_array_length(evidence_chunk_ids) >= 1)
    OR
    (node_type = 'skill_candidate' AND evidence_kind IS NULL AND semantic_type IS NULL
      AND lifecycle_status IS NULL AND tree_type IS NULL AND level IS NULL
      AND skill_candidate_status IS NOT NULL AND jsonb_array_length(evidence_memory_ids) >= 1
      AND jsonb_array_length(evidence_chunk_ids) >= 1)
  )
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_work_memory_nodes_scope_type_idx ON mengshu_work_memory_nodes (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, node_type, record_id, created_at DESC, id
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_work_memory_edges (
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
  edge_type TEXT NOT NULL CHECK (edge_type = 'memory_relation'),
  predicate TEXT NOT NULL CHECK (predicate IN ('grounded_by', 'derives_from', 'contradicts', 'supersedes', 'promoted_to')),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence > 0 AND confidence <= 1),
  evidence_chunk_ids JSONB NOT NULL CHECK (
    jsonb_typeof(evidence_chunk_ids) = 'array' AND jsonb_array_length(evidence_chunk_ids) >= 1
  ),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 2000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT CHECK (updated_at IS NULL OR updated_at >= created_at),
  PRIMARY KEY (scope_fingerprint, id),
  FOREIGN KEY (scope_fingerprint, source_id)
    REFERENCES mengshu_work_memory_nodes (scope_fingerprint, id),
  FOREIGN KEY (scope_fingerprint, target_id)
    REFERENCES mengshu_work_memory_nodes (scope_fingerprint, id),
  CHECK (char_length(id) BETWEEN 1 AND 256 AND id !~ '[[:space:][:cntrl:]]'),
  CHECK (source_id <> target_id)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_work_memory_edges_scope_source_idx ON mengshu_work_memory_edges (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, source_id, predicate, id
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_work_memory_edges_scope_target_idx ON mengshu_work_memory_edges (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, target_id, predicate, id
      )`,
    ],
  },
  {
    version: 14,
    name: "add-atomic-candidate-write-journal",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_candidate_write_receipts (
  storage_key TEXT PRIMARY KEY CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_id TEXT NOT NULL REFERENCES mengshu_candidates (id),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL CHECK (route IN ('candidate_low_priority', 'candidate')),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_candidate_write_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  storage_key TEXT NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_id TEXT NOT NULL REFERENCES mengshu_candidates (id),
  action TEXT NOT NULL CHECK (action = 'candidate.store'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL CHECK (route IN ('candidate_low_priority', 'candidate')),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (storage_key, candidate_id, action)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_candidate_write_outbox (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_id TEXT NOT NULL REFERENCES mengshu_candidates (id),
  topic TEXT NOT NULL CHECK (topic = 'candidate.written'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'team', 'public')),
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL CHECK (route IN ('candidate_low_priority', 'candidate')),
  occurred_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  UNIQUE (storage_key, topic, candidate_id)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_candidate_write_audit_scope_candidate_idx
ON mengshu_candidate_write_audit (
  tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
  workspace_id, session_id, candidate_id, occurred_at DESC
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_candidate_write_outbox_pending_idx
ON mengshu_candidate_write_outbox (occurred_at, event_id)
WHERE published_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS mengshu_candidate_write_receipts_created_idx
ON mengshu_candidate_write_receipts (created_at DESC, storage_key)`,
    ],
  },
  {
    version: 15,
    name: "add-authoritative-evidence-link-ledgers",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_memory_evidence_links (
  link_id TEXT PRIMARY KEY CHECK (link_id ~ '^[0-9a-f]{64}$'),
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
  target_memory_id TEXT NOT NULL,
  evidence_memory_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind IN (
    'grounded_by', 'duplicate_evidence', 'supersession_evidence', 'conflict_evidence'
  )),
  source TEXT NOT NULL CHECK (char_length(source) BETWEEN 1 AND 256 AND btrim(source) <> ''),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (
    scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source
  ),
  CHECK (char_length(target_memory_id) BETWEEN 1 AND 256 AND target_memory_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(evidence_memory_id) BETWEEN 1 AND 256 AND evidence_memory_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_memory_evidence_links_scope_target_idx
ON mengshu_memory_evidence_links (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, target_memory_id, link_kind, created_at DESC
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_entity_evidence (
  link_id TEXT PRIMARY KEY CHECK (link_id ~ '^[0-9a-f]{64}$'),
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
  entity_id TEXT NOT NULL,
  evidence_memory_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (char_length(source_kind) BETWEEN 1 AND 256 AND btrim(source_kind) <> ''),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (scope_fingerprint, entity_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, entity_id, evidence_memory_id, source_id, source_kind),
  CHECK (char_length(evidence_memory_id) BETWEEN 1 AND 256 AND evidence_memory_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(source_id) BETWEEN 1 AND 256 AND source_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entity_evidence_scope_evidence_idx
ON mengshu_graph_entity_evidence (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, evidence_memory_id, entity_id, created_at DESC
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_relation_evidence (
  link_id TEXT PRIMARY KEY CHECK (link_id ~ '^[0-9a-f]{64}$'),
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
  relation_id TEXT NOT NULL,
  evidence_memory_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (char_length(source_kind) BETWEEN 1 AND 256 AND btrim(source_kind) <> ''),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (scope_fingerprint, relation_id)
    REFERENCES mengshu_graph_relations (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, relation_id, evidence_memory_id, source_id, source_kind),
  CHECK (char_length(evidence_memory_id) BETWEEN 1 AND 256 AND evidence_memory_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(source_id) BETWEEN 1 AND 256 AND source_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_relation_evidence_scope_evidence_idx
ON mengshu_graph_relation_evidence (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, evidence_memory_id, relation_id, created_at DESC
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_entity_aliases (
  alias_id TEXT PRIMARY KEY CHECK (alias_id ~ '^[0-9a-f]{64}$'),
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
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 1000 AND btrim(alias) <> ''),
  normalized_alias TEXT NOT NULL CHECK (char_length(normalized_alias) BETWEEN 1 AND 1000 AND btrim(normalized_alias) <> ''),
  evidence_memory_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (scope_fingerprint, entity_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, entity_id, normalized_alias),
  CHECK (char_length(evidence_memory_id) BETWEEN 1 AND 256 AND evidence_memory_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(source_id) BETWEEN 1 AND 256 AND source_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entity_aliases_scope_alias_idx
ON mengshu_graph_entity_aliases (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, normalized_alias, entity_id
)`,
    ],
  },
  {
    version: 16,
    name: "add-topic-tree-alias-migration-ledger",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_topic_tree_aliases (
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
  legacy_tree_key TEXT NOT NULL,
  canonical_topic_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  merged_from JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(merged_from) = 'array'),
  sealed_node_id TEXT,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  superseded_at BIGINT,
  archived_at BIGINT,
  PRIMARY KEY (scope_fingerprint, legacy_tree_key),
  CHECK (char_length(legacy_tree_key) BETWEEN 1 AND 256 AND legacy_tree_key !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(canonical_topic_label) BETWEEN 1 AND 80 AND canonical_topic_label !~ '[[:space:][:cntrl:]]'),
  CHECK (merged_from @> jsonb_build_array(legacy_tree_key)),
  CHECK (sealed_node_id IS NULL OR (char_length(sealed_node_id) BETWEEN 1 AND 256 AND sealed_node_id !~ '[[:space:][:cntrl:]]')),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at),
  CHECK (archived_at IS NULL OR (superseded_at IS NOT NULL AND archived_at >= superseded_at)),
  CHECK (
    (status = 'active' AND superseded_at IS NULL AND archived_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL AND archived_at IS NULL)
    OR (status = 'archived' AND superseded_at IS NOT NULL AND archived_at IS NOT NULL)
  )
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_topic_tree_aliases_scope_canonical_idx
ON mengshu_topic_tree_aliases (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, canonical_topic_label, legacy_tree_key
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_topic_tree_aliases_scope_status_idx
ON mengshu_topic_tree_aliases (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, status, superseded_at, legacy_tree_key
)`,
    ],
  },
  {
    version: 17,
    name: "add-canonical-entity-resolution-journal",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_graph_entity_alias_bindings (
  alias_binding_id TEXT PRIMARY KEY,
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
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'project', 'repo', 'file', 'topic', 'tool', 'task', 'concept', 'user', 'agent', 'chunk', 'document', 'other')),
  normalized_alias TEXT NOT NULL CHECK (char_length(normalized_alias) BETWEEN 1 AND 1000 AND btrim(normalized_alias) <> ''),
  canonical_entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  retired_at BIGINT,
  FOREIGN KEY (scope_fingerprint, canonical_entity_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  CHECK (char_length(alias_binding_id) BETWEEN 1 AND 256 AND alias_binding_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(canonical_entity_id) BETWEEN 1 AND 256 AND canonical_entity_id !~ '[[:space:][:cntrl:]]'),
  CHECK (retired_at IS NULL OR retired_at >= created_at),
  CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS mengshu_graph_entity_alias_bindings_active_uidx
ON mengshu_graph_entity_alias_bindings (
  scope_fingerprint, entity_type, normalized_alias
)
WHERE status = 'active'`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entity_alias_bindings_entity_idx
ON mengshu_graph_entity_alias_bindings (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, canonical_entity_id, status, normalized_alias
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_entity_resolution_ledger (
  resolution_id TEXT PRIMARY KEY,
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
  job_id TEXT NOT NULL REFERENCES mengshu_jobs_v2 (id),
  evidence_memory_id TEXT NOT NULL,
  raw_entity_id TEXT NOT NULL,
  canonical_entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'project', 'repo', 'file', 'topic', 'tool', 'task', 'concept', 'user', 'agent', 'chunk', 'document', 'other')),
  method TEXT NOT NULL CHECK (method IN ('exact', 'alias', 'semantic', 'create')),
  similarity DOUBLE PRECISION CHECK (similarity IS NULL OR (similarity >= 0 AND similarity <= 1)),
  can_rollback BOOLEAN NOT NULL,
  raw_entity JSONB NOT NULL CHECK (jsonb_typeof(raw_entity) = 'object'),
  observed_aliases JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(observed_aliases) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  rolled_back_at BIGINT,
  FOREIGN KEY (scope_fingerprint, canonical_entity_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, job_id, evidence_memory_id, raw_entity_id),
  CHECK (char_length(resolution_id) BETWEEN 1 AND 256 AND resolution_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(evidence_memory_id) BETWEEN 1 AND 256 AND evidence_memory_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(raw_entity_id) BETWEEN 1 AND 256 AND raw_entity_id !~ '[[:space:][:cntrl:]]'),
  CHECK (
    (method = 'semantic' AND similarity IS NOT NULL AND can_rollback = TRUE)
    OR (method <> 'semantic' AND similarity IS NULL AND can_rollback = FALSE)
  ),
  CHECK (rolled_back_at IS NULL OR rolled_back_at >= created_at),
  CHECK (
    (status = 'applied' AND rolled_back_at IS NULL)
    OR (status = 'rolled_back' AND can_rollback = TRUE AND rolled_back_at IS NOT NULL)
  )
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entity_resolution_scope_evidence_idx
ON mengshu_graph_entity_resolution_ledger (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, evidence_memory_id, raw_entity_id, created_at
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entity_resolution_rollback_idx
ON mengshu_graph_entity_resolution_ledger (
  scope_fingerprint, canonical_entity_id, created_at, resolution_id
)
WHERE status = 'applied' AND can_rollback = TRUE`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_relation_resolution_ledger (
  resolution_id TEXT PRIMARY KEY,
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
  job_id TEXT NOT NULL REFERENCES mengshu_jobs_v2 (id),
  evidence_memory_id TEXT NOT NULL,
  raw_relation_id TEXT NOT NULL,
  canonical_relation_id TEXT,
  canonical_subject_id TEXT NOT NULL,
  canonical_object_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('canonicalized', 'dropped_self')),
  raw_relation JSONB NOT NULL CHECK (jsonb_typeof(raw_relation) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (scope_fingerprint, canonical_relation_id)
    REFERENCES mengshu_graph_relations (scope_fingerprint, id),
  FOREIGN KEY (scope_fingerprint, canonical_subject_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  FOREIGN KEY (scope_fingerprint, canonical_object_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, job_id, evidence_memory_id, raw_relation_id),
  CHECK (char_length(resolution_id) BETWEEN 1 AND 256 AND resolution_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(evidence_memory_id) BETWEEN 1 AND 256 AND evidence_memory_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(raw_relation_id) BETWEEN 1 AND 256 AND raw_relation_id !~ '[[:space:][:cntrl:]]'),
  CHECK (
    (outcome = 'canonicalized' AND canonical_relation_id IS NOT NULL
      AND canonical_subject_id <> canonical_object_id)
    OR
    (outcome = 'dropped_self' AND canonical_relation_id IS NULL
      AND canonical_subject_id = canonical_object_id)
  )
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_relation_resolution_scope_evidence_idx
ON mengshu_graph_relation_resolution_ledger (
  scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, evidence_memory_id, raw_relation_id, created_at
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_graph_entity_embeddings (
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
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'project', 'repo', 'file', 'topic', 'tool', 'task', 'concept', 'user', 'agent', 'chunk', 'document', 'other')),
  embedding_space_id TEXT NOT NULL,
  embedding_space_state TEXT NOT NULL CHECK (embedding_space_state IN ('known-queryable', 'unknown-unqueryable')),
  vector vector NOT NULL,
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope_fingerprint, entity_id, embedding_space_id),
  FOREIGN KEY (scope_fingerprint, entity_id)
    REFERENCES mengshu_graph_entities (scope_fingerprint, id),
  FOREIGN KEY (embedding_space_id)
    REFERENCES mengshu_embedding_spaces (embedding_space_id)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_graph_entity_embeddings_queryable_idx
ON mengshu_graph_entity_embeddings (
  scope_fingerprint, entity_type, embedding_space_id, entity_id
)
WHERE embedding_space_state = 'known-queryable'`,
    ],
  },
  {
    version: 18,
    name: "evidence-first-active-memory-dedupe",
    kind: "contract",
    statements: EVIDENCE_FIRST_ACTIVE_MEMORY_DEDUPE_CONTRACT_STATEMENTS,
  },
  {
    version: 19,
    name: "add-semantic-type-backfill-ledger",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_semantic_type_backfill_shadow (
  migration_id TEXT NOT NULL,
  record_id UUID NOT NULL,
  original_metadata JSONB NOT NULL CHECK (jsonb_typeof(original_metadata) = 'object'),
  original_value_hash TEXT NOT NULL CHECK (original_value_hash ~ '^[0-9a-f]{64}$'),
  captured_at BIGINT NOT NULL CHECK (captured_at >= 0),
  PRIMARY KEY (migration_id, record_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_semantic_type_backfill_receipts (
  receipt_id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL,
  record_id UUID NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('preserve_explicit', 'backfill', 'lookup_only', 'invalid_explicit')),
  semantic_type TEXT CHECK (semantic_type IS NULL OR semantic_type IN ('profile', 'task_context', 'rules', 'experience', 'resource')),
  original_value_hash TEXT NOT NULL CHECK (original_value_hash ~ '^[0-9a-f]{64}$'),
  resulting_value_hash TEXT CHECK (resulting_value_hash IS NULL OR resulting_value_hash ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (migration_id, record_id),
  FOREIGN KEY (migration_id, record_id)
    REFERENCES mengshu_semantic_type_backfill_shadow (migration_id, record_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_semantic_type_backfill_checkpoints (
  migration_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  after_id UUID,
  counts JSONB NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_semantic_type_backfill_receipts_disposition_idx
ON mengshu_semantic_type_backfill_receipts (migration_id, disposition, record_id)`,
    ],
  },
  {
    version: 20,
    name: "add-private-asset-loadout-overlay",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_asset_versions (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('memory_view')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'published', 'deprecated', 'revoked')),
  visibility TEXT NOT NULL CHECK (visibility = 'private'),
  owner_user_id TEXT NOT NULL,
  descriptor JSONB NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, asset_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_asset_heads (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  changed_at BIGINT NOT NULL CHECK (changed_at >= 0),
  PRIMARY KEY (scope_fingerprint, asset_id),
  FOREIGN KEY (scope_fingerprint, asset_id, latest_version)
    REFERENCES mengshu_asset_versions (scope_fingerprint, asset_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_asset_promotion_receipts (
  receipt_id TEXT PRIMARY KEY,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_fingerprint, request_key),
  FOREIGN KEY (scope_fingerprint, asset_id, asset_version)
    REFERENCES mengshu_asset_versions (scope_fingerprint, asset_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_asset_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('version_created', 'status_changed')),
  receipt_id TEXT NOT NULL REFERENCES mengshu_asset_promotion_receipts (receipt_id),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  FOREIGN KEY (scope_fingerprint, asset_id, asset_version)
    REFERENCES mengshu_asset_versions (scope_fingerprint, asset_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_asset_outbox (
  event_id TEXT PRIMARY KEY,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('asset.version.created', 'asset.status.changed')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  published_at BIGINT,
  FOREIGN KEY (scope_fingerprint, asset_id, asset_version)
    REFERENCES mengshu_asset_versions (scope_fingerprint, asset_id, version)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_asset_versions_status_idx
ON mengshu_asset_versions (scope_fingerprint, status, kind, asset_id, version DESC)`,
      `CREATE INDEX IF NOT EXISTS mengshu_asset_outbox_pending_idx
ON mengshu_asset_outbox (occurred_at, event_id) WHERE published_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS mengshu_loadout_versions (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  loadout_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  app_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility = 'private'),
  descriptor JSONB NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, loadout_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_loadout_heads (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  loadout_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  changed_at BIGINT NOT NULL CHECK (changed_at >= 0),
  PRIMARY KEY (scope_fingerprint, loadout_id),
  FOREIGN KEY (scope_fingerprint, loadout_id, latest_version)
    REFERENCES mengshu_loadout_versions (scope_fingerprint, loadout_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_loadout_receipts (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  loadout_id TEXT NOT NULL,
  loadout_version INTEGER NOT NULL CHECK (loadout_version >= 1),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, request_key),
  UNIQUE (scope_fingerprint, request_key),
  FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version)
    REFERENCES mengshu_loadout_versions (scope_fingerprint, loadout_id, version)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_loadout_identity_idx
ON mengshu_loadout_versions (scope_fingerprint, app_id, agent_id, project_id, version DESC)`,
    ],
  },
  {
    version: 21,
    name: "add-loadout-audit-invalidation-outbox",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_loadout_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  loadout_id TEXT NOT NULL,
  loadout_version INTEGER NOT NULL CHECK (loadout_version >= 1),
  event_type TEXT NOT NULL CHECK (event_type = 'version_created'),
  request_key TEXT NOT NULL,
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version)
    REFERENCES mengshu_loadout_versions (scope_fingerprint, loadout_id, version),
  FOREIGN KEY (scope_fingerprint, request_key)
    REFERENCES mengshu_loadout_receipts (scope_fingerprint, request_key)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_loadout_outbox (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  loadout_id TEXT NOT NULL,
  loadout_version INTEGER NOT NULL CHECK (loadout_version >= 1),
  event_type TEXT NOT NULL CHECK (event_type = 'loadout.version.created'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  published_at BIGINT,
  FOREIGN KEY (scope_fingerprint, loadout_id, loadout_version)
    REFERENCES mengshu_loadout_versions (scope_fingerprint, loadout_id, version)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_loadout_outbox_pending_idx
ON mengshu_loadout_outbox (occurred_at, event_id) WHERE published_at IS NULL`,
    ],
  },
  {
    version: 22,
    name: "add-context-assembly-receipts",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_context_assembly_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL,
  stable_content_hash TEXT NOT NULL CHECK (stable_content_hash ~ '^[0-9a-f]{64}$'),
  dynamic_content_hash TEXT NOT NULL CHECK (dynamic_content_hash ~ '^[0-9a-f]{64}$'),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  expires_at BIGINT NOT NULL CHECK (expires_at >= created_at),
  CHECK (char_length(session_id) BETWEEN 1 AND 256 AND session_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_context_assembly_receipts_session_idx
ON mengshu_context_assembly_receipts (scope_fingerprint, session_id, created_at DESC, receipt_id DESC)`,
    ],
  },
  {
    version: 23,
    name: "add-history-rebuild-ledger",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_runs (
  run_id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL,
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
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  model_fingerprint TEXT NOT NULL CHECK (model_fingerprint ~ '^[0-9a-f]{64}$'),
  prompt_hash TEXT NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  policy_hash TEXT NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  attempt_hash TEXT NOT NULL CHECK (attempt_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'rolled_back', 'drifted', 'failed')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (migration_id, scope_fingerprint, attempt_hash),
  CHECK (char_length(run_id) BETWEEN 1 AND 256 AND run_id !~ '[[:space:][:cntrl:]]'),
  CHECK (char_length(migration_id) BETWEEN 1 AND 256 AND migration_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_source_snapshots (
  run_id TEXT NOT NULL REFERENCES mengshu_history_rebuild_runs (run_id),
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  source_upper_bound UUID,
  source_count BIGINT NOT NULL CHECK (source_count >= 0),
  snapshot_hash TEXT NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  captured_at BIGINT NOT NULL CHECK (captured_at >= 0),
  PRIMARY KEY (run_id, source_table),
  CHECK ((source_count = 0 AND source_upper_bound IS NULL) OR
    (source_count > 0 AND source_upper_bound IS NOT NULL))
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_source_rows (
  run_id TEXT NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_row JSONB NOT NULL CHECK (jsonb_typeof(source_row) = 'object'),
  original_text TEXT NOT NULL,
  original_metadata JSONB NOT NULL CHECK (jsonb_typeof(original_metadata) = 'object'),
  original_metadata_hash TEXT NOT NULL CHECK (original_metadata_hash ~ '^[0-9a-f]{64}$'),
  original_lifecycle_status TEXT CHECK (original_lifecycle_status IS NULL OR
    original_lifecycle_status IN ('active', 'archived', 'revoked', 'superseded', 'promoted')),
  captured_at BIGINT NOT NULL CHECK (captured_at >= 0),
  PRIMARY KEY (run_id, source_table, record_id),
  UNIQUE (run_id, source_table, source_hash),
  FOREIGN KEY (run_id, source_table)
    REFERENCES mengshu_history_rebuild_source_snapshots (run_id, source_table)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_checkpoints (
  run_id TEXT NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  after_id UUID,
  checkpoint_version BIGINT NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
  counts JSONB NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'rolled_back', 'drifted', 'failed')),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (run_id, source_table),
  FOREIGN KEY (run_id, source_table)
    REFERENCES mengshu_history_rebuild_source_snapshots (run_id, source_table)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_shadow_plans (
  run_id TEXT NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN ('preserve', 'backfill', 'model_classify', 'lookup_only', 'quarantine')),
  semantic_type TEXT CHECK (semantic_type IS NULL OR semantic_type IN ('profile', 'task_context', 'rules', 'experience', 'resource')),
  topic_labels JSONB NOT NULL CHECK (jsonb_typeof(topic_labels) = 'array'),
  context_eligible BOOLEAN NOT NULL,
  tree_eligibility JSONB NOT NULL CHECK (jsonb_typeof(tree_eligibility) = 'object'),
  reason TEXT NOT NULL,
  plan_receipt_hash TEXT NOT NULL CHECK (plan_receipt_hash ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, source_table, record_id),
  UNIQUE (run_id, plan_receipt_hash),
  FOREIGN KEY (run_id, source_table)
    REFERENCES mengshu_history_rebuild_source_snapshots (run_id, source_table),
  CHECK (source_table <> 'knowledge' OR
    (semantic_type = 'resource' AND context_eligible = false))
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_model_receipts (
  receipt_hash TEXT PRIMARY KEY CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  run_id TEXT NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  model_fingerprint TEXT NOT NULL CHECK (model_fingerprint ~ '^[0-9a-f]{64}$'),
  prompt_hash TEXT NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  output_hash TEXT NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  proposal_count INTEGER NOT NULL CHECK (proposal_count >= 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (run_id, source_table, record_id),
  FOREIGN KEY (run_id, source_table, record_id)
    REFERENCES mengshu_history_rebuild_shadow_plans (run_id, source_table, record_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_operation_receipts (
  receipt_hash TEXT PRIMARY KEY CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  run_id TEXT NOT NULL REFERENCES mengshu_history_rebuild_runs (run_id),
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  operation TEXT NOT NULL CHECK (operation IN ('plan', 'apply', 'verify', 'rollback')),
  status TEXT NOT NULL CHECK (status IN ('applied', 'verified', 'rolled_back', 'drifted', 'failed')),
  counts JSONB NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  result_hash TEXT NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  drift_hash TEXT CHECK (drift_hash IS NULL OR drift_hash ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (run_id, source_table, operation, receipt_hash)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_artifacts (
  run_id TEXT NOT NULL,
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('evidence_memory', 'evidence_link', 'tree_job')),
  artifact_id TEXT NOT NULL,
  artifact_role TEXT NOT NULL CHECK (artifact_role IN ('evidence_mirror', 'grounded_by', 'source_leaf', 'source_finalize', 'topic_leaf', 'topic_finalize')),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, artifact_type, artifact_id),
  FOREIGN KEY (run_id, source_table, record_id)
    REFERENCES mengshu_history_rebuild_source_rows (run_id, source_table, record_id),
  CHECK (char_length(artifact_id) BETWEEN 1 AND 256 AND artifact_id !~ '[[:space:][:cntrl:]]')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_history_rebuild_shadow_disposition_idx
ON mengshu_history_rebuild_shadow_plans (run_id, source_table, disposition, record_id)`,
      `CREATE INDEX IF NOT EXISTS mengshu_history_rebuild_operations_idx
ON mengshu_history_rebuild_operation_receipts (run_id, source_table, operation, created_at, receipt_hash)`,
      `CREATE INDEX IF NOT EXISTS mengshu_history_rebuild_artifacts_source_idx
ON mengshu_history_rebuild_artifacts (run_id, source_table, record_id, artifact_type, artifact_role)`,
    ],
  },
  {
    version: 24,
    name: "add-history-rebuild-model-attempt-ledger",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_history_rebuild_model_attempts (
  migration_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  run_id TEXT NOT NULL REFERENCES mengshu_history_rebuild_runs (run_id),
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id UUID NOT NULL,
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  attempt INTEGER NOT NULL CHECK (attempt >= 0 AND attempt < 2),
  model_fingerprint TEXT NOT NULL CHECK (model_fingerprint ~ '^[0-9a-f]{64}$'),
  prompt_hash TEXT NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'completed')),
  reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens >= 0),
  reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
  reserved_cost_minor_units BIGINT NOT NULL CHECK (reserved_cost_minor_units >= 0),
  output JSONB,
  output_hash TEXT CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
  actual_input_tokens INTEGER,
  actual_output_tokens INTEGER,
  actual_cost_minor_units BIGINT,
  reserved_at BIGINT NOT NULL CHECK (reserved_at >= 0),
  completed_at BIGINT,
  PRIMARY KEY (run_id, source_table, record_id, attempt),
  CHECK (char_length(migration_id) BETWEEN 1 AND 256 AND migration_id !~ '[[:space:][:cntrl:]]'),
  CHECK ((state = 'reserved' AND output IS NULL AND output_hash IS NULL AND
      actual_input_tokens IS NULL AND actual_output_tokens IS NULL AND
      actual_cost_minor_units IS NULL AND completed_at IS NULL) OR
    (state = 'completed' AND jsonb_typeof(output) = 'object' AND output_hash IS NOT NULL AND
      actual_input_tokens = reserved_input_tokens AND actual_output_tokens >= 0 AND
      actual_output_tokens <= reserved_output_tokens AND actual_cost_minor_units >= 0 AND
      actual_cost_minor_units <= reserved_cost_minor_units AND completed_at >= reserved_at))
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_history_rebuild_model_attempts_budget_idx
ON mengshu_history_rebuild_model_attempts (migration_id, manifest_hash, state)`,
    ],
  },
  {
    version: 25,
    name: "add-governed-document-vault-ledger",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_vaults (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (char_length(vault_id) BETWEEN 1 AND 256 AND
    vault_id !~ '[[:space:][:cntrl:]]'),
  descriptor JSONB NOT NULL CHECK (jsonb_typeof(descriptor) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'detached')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (scope_fingerprint, vault_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_governed_document_bindings (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (char_length(vault_id) BETWEEN 1 AND 256 AND
    vault_id !~ '[[:space:][:cntrl:]]'),
  asset_id TEXT NOT NULL CHECK (char_length(asset_id) BETWEEN 1 AND 256 AND
    asset_id !~ '[[:space:][:cntrl:]]'),
  asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  kind TEXT NOT NULL CHECK (kind IN (
    'memory_document', 'tree_document', 'index_document'
  )),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'typed_memory', 'tree_summary', 'home', 'type_index', 'tree_index',
    'project_index', 'topic_index', 'source_index', 'document_index',
    'governance_catalog'
  )),
  semantic_type TEXT CHECK (semantic_type IN (
    'profile', 'task_context', 'rules', 'experience', 'resource'
  )),
  semantic_types JSONB CHECK (semantic_types IS NULL OR
    jsonb_typeof(semantic_types) = 'array'),
  tree_type TEXT CHECK (tree_type IN ('source', 'topic', 'global')),
  tree_level TEXT CHECK (tree_level IN ('L1', 'L2', 'L3')),
  tree_key TEXT CHECK (tree_key IS NULL OR
    (char_length(tree_key) BETWEEN 1 AND 256 AND tree_key !~ '[[:cntrl:]]')),
  tree_node TEXT CHECK (tree_node IS NULL OR
    (char_length(tree_node) BETWEEN 1 AND 256 AND tree_node !~ '[[:space:][:cntrl:]]')),
  seal_version INTEGER CHECK (seal_version IS NULL OR seal_version >= 1),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
    'draft', 'review', 'active', 'deprecated', 'revoked'
  )),
  governance_state TEXT NOT NULL CHECK (governance_state IN (
    'current', 'stale', 'review_required', 'conflicted'
  )),
  relative_path TEXT NOT NULL CHECK (char_length(relative_path) BETWEEN 1 AND 4096 AND
    relative_path !~ '[[:cntrl:]]'),
  normalized_path TEXT NOT NULL CHECK (char_length(normalized_path) BETWEEN 1 AND 4096 AND
    normalized_path !~ '[[:cntrl:]]' AND left(normalized_path, 1) <> '/' AND
    normalized_path !~ '(^|/)[.][.]?(/|$)'),
  governance_descriptor JSONB NOT NULL CHECK (jsonb_typeof(governance_descriptor) = 'object'),
  document_index_asset_id TEXT CHECK (document_index_asset_id IS NULL OR
    (char_length(document_index_asset_id) BETWEEN 1 AND 256 AND
      document_index_asset_id !~ '[[:space:][:cntrl:]]')),
  public_content_hash TEXT NOT NULL CHECK (public_content_hash ~ '^[0-9a-f]{64}$'),
  governance_projection_hash TEXT NOT NULL CHECK (
    governance_projection_hash ~ '^[0-9a-f]{64}$'),
  render_hash TEXT NOT NULL CHECK (render_hash ~ '^[0-9a-f]{64}$'),
  external_hash TEXT CHECK (external_hash IS NULL OR external_hash ~ '^[0-9a-f]{64}$'),
  sync_state TEXT NOT NULL CHECK (sync_state IN (
    'sync_pending', 'complete', 'repairing',
    'external_modified', 'conflict', 'removed'
  )),
  last_complete_version INTEGER CHECK (last_complete_version IS NULL OR
    (last_complete_version >= 1 AND last_complete_version <= asset_version)),
  synced_at BIGINT CHECK (synced_at IS NULL OR synced_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  CHECK (
    (kind = 'memory_document' AND purpose = 'typed_memory' AND semantic_type IS NOT NULL
      AND semantic_types IS NULL AND tree_type IS NULL AND tree_level IS NULL
      AND tree_key IS NULL AND tree_node IS NULL AND seal_version IS NULL)
    OR
    (kind = 'tree_document' AND purpose = 'tree_summary' AND semantic_type IS NULL
      AND jsonb_typeof(semantic_types) = 'array'
      AND tree_type IS NOT NULL AND tree_level IS NOT NULL AND tree_key IS NOT NULL
      AND tree_node IS NOT NULL AND seal_version IS NOT NULL)
    OR
    (kind = 'index_document' AND purpose NOT IN ('typed_memory', 'tree_summary')
      AND semantic_type IS NULL AND semantic_types IS NULL AND tree_type IS NULL
      AND tree_level IS NULL AND tree_key IS NULL AND tree_node IS NULL
      AND seal_version IS NULL)
  ),
  PRIMARY KEY (scope_fingerprint, vault_id, asset_id),
  UNIQUE (scope_fingerprint, vault_id, normalized_path),
  UNIQUE (scope_fingerprint, vault_id, asset_id, asset_version),
  FOREIGN KEY (scope_fingerprint, vault_id)
    REFERENCES mengshu_vaults(scope_fingerprint, vault_id),
  FOREIGN KEY (scope_fingerprint, asset_id, asset_version)
    REFERENCES mengshu_asset_versions(scope_fingerprint, asset_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_governed_document_sync_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (char_length(receipt_id) BETWEEN 1 AND 256 AND
    receipt_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (char_length(vault_id) BETWEEN 1 AND 256 AND
    vault_id !~ '[[:space:][:cntrl:]]'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL CHECK (char_length(asset_id) BETWEEN 1 AND 256 AND
    asset_id !~ '[[:space:][:cntrl:]]'),
  asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
  postgres_public_content_hash TEXT NOT NULL CHECK (
    postgres_public_content_hash ~ '^[0-9a-f]{64}$'),
  markdown_public_content_hash TEXT NOT NULL CHECK (
    markdown_public_content_hash ~ '^[0-9a-f]{64}$'),
  governance_projection_hash TEXT NOT NULL CHECK (
    governance_projection_hash ~ '^[0-9a-f]{64}$'),
  completion_contract_hash TEXT NOT NULL CHECK (
    completion_contract_hash ~ '^[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'complete', 'pending', 'conflict', 'aborted'
  )),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_fingerprint, vault_id, idempotency_key),
  UNIQUE (scope_fingerprint, vault_id, asset_id, asset_version, receipt_id),
  FOREIGN KEY (scope_fingerprint, vault_id, asset_id, asset_version)
    REFERENCES mengshu_governed_document_bindings(
      scope_fingerprint, vault_id, asset_id, asset_version
    )
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_governed_document_complete_heads (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  asset_id TEXT NOT NULL CHECK (char_length(asset_id) BETWEEN 1 AND 256 AND
    asset_id !~ '[[:space:][:cntrl:]]'),
  complete_version INTEGER NOT NULL CHECK (complete_version >= 1),
  vault_id TEXT NOT NULL CHECK (char_length(vault_id) BETWEEN 1 AND 256 AND
    vault_id !~ '[[:space:][:cntrl:]]'),
  completion_receipt_id TEXT NOT NULL CHECK (
    char_length(completion_receipt_id) BETWEEN 1 AND 256 AND
    completion_receipt_id !~ '[[:space:][:cntrl:]]'),
  changed_at BIGINT NOT NULL CHECK (changed_at >= 0),
  PRIMARY KEY (scope_fingerprint, asset_id),
  FOREIGN KEY (scope_fingerprint, asset_id, complete_version)
    REFERENCES mengshu_asset_versions(scope_fingerprint, asset_id, version),
  FOREIGN KEY (
    scope_fingerprint, vault_id, asset_id, complete_version, completion_receipt_id
  ) REFERENCES mengshu_governed_document_sync_receipts(
    scope_fingerprint, vault_id, asset_id, asset_version, receipt_id
  )
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_document_governance_runs (
  governance_run_id TEXT PRIMARY KEY CHECK (
    char_length(governance_run_id) BETWEEN 1 AND 256 AND
    governance_run_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  trigger_type TEXT NOT NULL CHECK (char_length(trigger_type) BETWEEN 1 AND 128 AND
    trigger_type !~ '[[:space:][:cntrl:]]'),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 256 AND
    policy_version !~ '[[:space:][:cntrl:]]'),
  model_fingerprint TEXT CHECK (model_fingerprint IS NULL OR
    model_fingerprint ~ '^[0-9a-f]{64}$'),
  resolution_hash TEXT NOT NULL CHECK (resolution_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'selecting', 'organizing', 'validating',
    'applied', 'review_required', 'failed'
  )),
  started_at BIGINT NOT NULL CHECK (started_at >= 0),
  completed_at BIGINT CHECK (completed_at IS NULL OR completed_at >= started_at),
  UNIQUE (governance_run_id, scope_fingerprint)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_information_dispositions (
  governance_run_id TEXT NOT NULL CHECK (
    char_length(governance_run_id) BETWEEN 1 AND 256 AND
    governance_run_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  information_ref TEXT NOT NULL CHECK (char_length(information_ref) BETWEEN 1 AND 1024 AND
    information_ref !~ '[[:cntrl:]]'),
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'conversation', 'file', 'knowledge', 'tool', 'system_event'
  )),
  semantic_type TEXT CHECK (semantic_type IN (
    'profile', 'task_context', 'rules', 'experience', 'resource'
  )),
  tree_routes JSONB NOT NULL CHECK (jsonb_typeof(tree_routes) = 'array'),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'attached_to_typed_document', 'attached_and_routed', 'tree_only',
    'native_only', 'lookup_only', 'rejected_below_threshold', 'deferred',
    'redundant_with_evidence', 'superseded', 'archive_stale',
    'conflict', 'quarantine'
  )),
  target_asset_ids JSONB NOT NULL CHECK (jsonb_typeof(target_asset_ids) = 'array'),
  reason_code TEXT NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 256 AND
    reason_code !~ '[[:space:][:cntrl:]]'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  CHECK (disposition <> 'attached_to_typed_document' OR
    (semantic_type IS NOT NULL AND jsonb_array_length(target_asset_ids) > 0)),
  CHECK (disposition <> 'tree_only' OR jsonb_array_length(tree_routes) > 0),
  CHECK (disposition <> 'attached_and_routed' OR
    (semantic_type IS NOT NULL AND jsonb_array_length(target_asset_ids) > 0 AND
      jsonb_array_length(tree_routes) > 0)),
  PRIMARY KEY (governance_run_id, information_ref),
  FOREIGN KEY (governance_run_id, scope_fingerprint)
    REFERENCES mengshu_document_governance_runs(governance_run_id, scope_fingerprint)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_governed_document_bindings_sync_idx
ON mengshu_governed_document_bindings (
  scope_fingerprint, vault_id, sync_state, updated_at, asset_id
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_governed_document_sync_receipts_asset_idx
ON mengshu_governed_document_sync_receipts (
  scope_fingerprint, asset_id, asset_version, created_at
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_document_governance_runs_status_idx
ON mengshu_document_governance_runs (scope_fingerprint, status, started_at, governance_run_id)`,
      `CREATE INDEX IF NOT EXISTS mengshu_information_dispositions_result_idx
ON mengshu_information_dispositions (
  scope_fingerprint, disposition, governance_run_id, information_ref
)`,
    ],
  },
  {
    version: 26,
    name: "allow-governed-document-asset-kinds",
    kind: "contract",
    statements: GOVERNED_DOCUMENT_ASSET_CONTRACT_STATEMENTS,
  },
  {
    version: 27,
    name: "add-markdown-workset-migration-ledger",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_markdown_migration_runs (
  run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 256 AND
    run_id !~ '[[:space:][:cntrl:]]'),
  source_manifest_sha256 TEXT NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_snapshot_sha256 TEXT NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  governed_manifest_sha256 TEXT CHECK (
    governed_manifest_sha256 IS NULL OR governed_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  governed_snapshot_sha256 TEXT CHECK (
    governed_snapshot_sha256 IS NULL OR governed_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  verification_sha256 TEXT CHECK (
    verification_sha256 IS NULL OR verification_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 256 AND
    policy_version !~ '[[:space:][:cntrl:]]'),
  status TEXT NOT NULL CHECK (status IN (
    'prepared', 'staging', 'verified', 'activated', 'rolled_back', 'blocked'
  )),
  source_count BIGINT NOT NULL CHECK (source_count >= 0),
  mapped_count BIGINT NOT NULL DEFAULT 0 CHECK (mapped_count >= 0 AND mapped_count <= source_count),
  staged_live_count BIGINT NOT NULL DEFAULT 0 CHECK (staged_live_count >= 0),
  prepared_at BIGINT NOT NULL CHECK (prepared_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= prepared_at),
  activated_at BIGINT CHECK (activated_at IS NULL OR activated_at >= prepared_at),
  rolled_back_at BIGINT CHECK (rolled_back_at IS NULL OR rolled_back_at >= prepared_at)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_markdown_migration_staged_rows (
  run_id TEXT NOT NULL REFERENCES mengshu_markdown_migration_runs(run_id),
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id TEXT NOT NULL CHECK (char_length(record_id) BETWEEN 1 AND 512 AND
    record_id !~ '[[:space:][:cntrl:]]'),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 1024 AND
    source_ref !~ '[[:cntrl:]]'),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  row_payload JSONB NOT NULL CHECK (jsonb_typeof(row_payload) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, source_table, record_id),
  UNIQUE (run_id, source_ref)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_markdown_migration_mappings (
  run_id TEXT NOT NULL REFERENCES mengshu_markdown_migration_runs(run_id),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 1024 AND
    source_ref !~ '[[:cntrl:]]'),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT CHECK (
    scope_fingerprint IS NULL OR scope_fingerprint ~ '^[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'canonical_keep', 'merge_exact', 'merge_semantic', 'supersede',
    'archive_stale', 'lookup_only', 'quarantine', 'distinct_keep'
  )),
  canonical_target_ref TEXT CHECK (canonical_target_ref IS NULL OR
    (char_length(canonical_target_ref) BETWEEN 1 AND 1024 AND
      canonical_target_ref !~ '[[:cntrl:]]')),
  reason_code TEXT NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 256 AND
    reason_code !~ '[[:space:][:cntrl:]]'),
  mapping_sha256 TEXT NOT NULL CHECK (mapping_sha256 ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, source_ref)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_markdown_migration_before_rows (
  run_id TEXT NOT NULL REFERENCES mengshu_markdown_migration_runs(run_id),
  source_table TEXT NOT NULL CHECK (source_table IN ('memories', 'knowledge')),
  record_id TEXT NOT NULL CHECK (char_length(record_id) BETWEEN 1 AND 512 AND
    record_id !~ '[[:space:][:cntrl:]]'),
  row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  row_payload JSONB NOT NULL CHECK (jsonb_typeof(row_payload) = 'object'),
  captured_at BIGINT NOT NULL CHECK (captured_at >= 0),
  PRIMARY KEY (run_id, source_table, record_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_markdown_migration_activation_receipts (
  activation_id TEXT PRIMARY KEY CHECK (char_length(activation_id) BETWEEN 1 AND 256 AND
    activation_id !~ '[[:space:][:cntrl:]]'),
  run_id TEXT NOT NULL REFERENCES mengshu_markdown_migration_runs(run_id),
  operation TEXT NOT NULL CHECK (operation IN ('activate', 'rollback')),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256 TEXT NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  governed_manifest_sha256 TEXT NOT NULL CHECK (governed_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  verification_sha256 TEXT NOT NULL CHECK (verification_sha256 ~ '^[0-9a-f]{64}$'),
  before_snapshot_sha256 TEXT NOT NULL CHECK (before_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  after_snapshot_sha256 TEXT NOT NULL CHECK (after_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  confirmation_hash TEXT NOT NULL CHECK (confirmation_hash ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (run_id, operation),
  UNIQUE (run_id, request_hash)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_markdown_migration_runs_status_idx
ON mengshu_markdown_migration_runs (status, updated_at, run_id)`,
      `CREATE INDEX IF NOT EXISTS mengshu_markdown_migration_mappings_result_idx
ON mengshu_markdown_migration_mappings (run_id, disposition, source_ref)`,
      `CREATE INDEX IF NOT EXISTS mengshu_markdown_migration_staged_rows_table_idx
ON mengshu_markdown_migration_staged_rows (run_id, source_table, record_id)`,
    ],
  },
  {
    version: 28,
    name: "add-temporal-memory-version-chain",
    kind: "expand",
    statements: [
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope_fingerprint TEXT",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS lineage_id TEXT",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS revision INTEGER",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS previous_version_id UUID",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS restored_from_version_id UUID",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS transition_type TEXT",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS transition_reason TEXT",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS temporal_invalidated BOOLEAN",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS temporal_purge_pending BOOLEAN",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS temporal_snapshot JSONB",
      `CREATE TABLE IF NOT EXISTS mengshu_memory_lineage_heads (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  lineage_id TEXT NOT NULL CHECK (char_length(lineage_id) BETWEEN 1 AND 256 AND
    lineage_id !~ '[[:space:][:cntrl:]]'),
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
  current_version_id UUID REFERENCES memories(id),
  current_version_revision INTEGER CHECK (
    current_version_revision IS NULL OR current_version_revision >= 1
  ),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope_fingerprint, lineage_id),
  UNIQUE (scope_fingerprint, lineage_id, latest_revision),
  CHECK ((current_version_id IS NULL AND current_version_revision IS NULL) OR
    (current_version_id IS NOT NULL AND current_version_revision IS NOT NULL AND
      current_version_revision <= latest_revision))
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_version_transition_receipts (
  receipt_id TEXT NOT NULL CHECK (char_length(receipt_id) BETWEEN 1 AND 256 AND
    receipt_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  lineage_id TEXT NOT NULL CHECK (char_length(lineage_id) BETWEEN 1 AND 256 AND
    lineage_id !~ '[[:space:][:cntrl:]]'),
  transition_type TEXT NOT NULL CHECK (transition_type IN (
    'created', 'evolved', 'corrected', 'expired', 'restored', 'revoked'
  )),
  previous_version_id UUID,
  version_id UUID,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  PRIMARY KEY (scope_fingerprint, idempotency_key),
  UNIQUE (receipt_id),
  UNIQUE (scope_fingerprint, lineage_id, revision, transition_type, request_hash)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_purge_receipts (
  operation_id TEXT NOT NULL CHECK (char_length(operation_id) BETWEEN 1 AND 256 AND
    operation_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  lineage_hash TEXT NOT NULL CHECK (lineage_hash ~ '^[0-9a-f]{64}$'),
  purged_versions INTEGER NOT NULL CHECK (purged_versions >= 1),
  derived_artifacts_purged INTEGER NOT NULL CHECK (derived_artifacts_purged >= 0),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  PRIMARY KEY (scope_fingerprint, idempotency_key),
  UNIQUE (operation_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_version_outbox (
  event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  lineage_id TEXT NOT NULL CHECK (char_length(lineage_id) BETWEEN 1 AND 256 AND
    lineage_id !~ '[[:space:][:cntrl:]]'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'memory.version.created', 'memory.version.closed', 'memory.version.corrected',
    'memory.version.restored', 'memory.version.purge_pending', 'memory.version.purged'
  )),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  published_at BIGINT CHECK (published_at IS NULL OR published_at >= occurred_at)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_temporal_migration_runs (
  run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 256 AND
    run_id !~ '[[:space:][:cntrl:]]'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  before_hash TEXT NOT NULL CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash TEXT CHECK (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'review_required', 'applied', 'verified', 'rolled_back', 'failed'
  )),
  scanned_count BIGINT NOT NULL CHECK (scanned_count >= 0),
  applied_count BIGINT NOT NULL CHECK (applied_count >= 0 AND applied_count <= scanned_count),
  ambiguous_count BIGINT NOT NULL CHECK (
    ambiguous_count >= 0 AND ambiguous_count <= scanned_count
  ),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_temporal_migration_rows (
  run_id TEXT NOT NULL REFERENCES mengshu_memory_temporal_migration_runs(run_id),
  memory_id UUID NOT NULL REFERENCES memories(id),
  scope_fingerprint TEXT CHECK (
    scope_fingerprint IS NULL OR scope_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  disposition TEXT NOT NULL CHECK (disposition IN (
    'bootstrap_single', 'reuse_supersedes_chain', 'independent_lineage',
    'review_multiple_heads', 'review_time_conflict', 'quarantine_invalid'
  )),
  lineage_id TEXT CHECK (lineage_id IS NULL OR
    (char_length(lineage_id) BETWEEN 1 AND 256 AND lineage_id !~ '[[:space:][:cntrl:]]')),
  revision INTEGER CHECK (revision IS NULL OR revision >= 1),
  before_hash TEXT NOT NULL CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash TEXT CHECK (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$'),
  before_row JSONB NOT NULL CHECK (jsonb_typeof(before_row) = 'object'),
  after_row JSONB CHECK (after_row IS NULL OR jsonb_typeof(after_row) = 'object'),
  reason_code TEXT NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 256 AND
    reason_code !~ '[[:space:][:cntrl:]]'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, memory_id)
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memories_temporal_lineage_revision_uidx
ON memories (scope_fingerprint, lineage_id, revision)
WHERE lineage_id IS NOT NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memories_temporal_current_head_uidx
ON memories (scope_fingerprint, lineage_id)
WHERE lineage_id IS NOT NULL AND valid_to IS NULL AND lifecycle_status = 'active'
  AND temporal_invalidated IS NOT TRUE AND temporal_purge_pending IS NOT TRUE`,
      `CREATE INDEX IF NOT EXISTS memories_temporal_valid_time_idx
ON memories (scope_fingerprint, lineage_id, valid_from, valid_to, revision)
WHERE lineage_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS mengshu_memory_version_outbox_pending_idx
ON mengshu_memory_version_outbox (occurred_at, event_id)
WHERE published_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS mengshu_memory_temporal_migration_rows_disposition_idx
ON mengshu_memory_temporal_migration_rows (run_id, disposition, memory_id)`,
    ],
  },
  {
    version: 29,
    name: "add-session-working-set",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_session_working_set_entries (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 256 AND
    session_id !~ '[[:space:][:cntrl:]]'),
  entry_id TEXT NOT NULL CHECK (char_length(entry_id) BETWEEN 1 AND 256 AND
    entry_id !~ '[[:space:][:cntrl:]]'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility = 'private'),
  workspace_id TEXT,
  task_boundary_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'user_message_ref', 'assistant_message_ref', 'tool_pair',
    'tool_result_ref', 'task_boundary'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'active', 'summarized', 'replaced', 'expired', 'revoked'
  )),
  source_message_ids JSONB NOT NULL CHECK (jsonb_typeof(source_message_ids) = 'array'),
  tool_call_id TEXT,
  tool_name TEXT,
  payload_ref JSONB CHECK (payload_ref IS NULL OR jsonb_typeof(payload_ref) = 'object'),
  summary TEXT,
  replaceability DOUBLE PRECISION NOT NULL CHECK (replaceability BETWEEN 0 AND 1),
  evidence_refs JSONB NOT NULL CHECK (jsonb_typeof(evidence_refs) = 'array'),
  risk_flags JSONB NOT NULL CHECK (jsonb_typeof(risk_flags) = 'array'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (scope_fingerprint, session_id, entry_id),
  CHECK (kind <> 'tool_pair' OR (
    tool_call_id IS NOT NULL AND tool_name IS NOT NULL AND payload_ref IS NOT NULL AND
    jsonb_array_length(source_message_ids) = 2
  ))
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_session_working_set_idempotency_receipts (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  entry_id TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, session_id, idempotency_key),
  FOREIGN KEY (scope_fingerprint, session_id, entry_id)
    REFERENCES mengshu_session_working_set_entries (scope_fingerprint, session_id, entry_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_session_task_outline_versions (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL,
  task_boundary_id TEXT NOT NULL CHECK (char_length(task_boundary_id) BETWEEN 1 AND 256 AND
    task_boundary_id !~ '[[:space:][:cntrl:]]'),
  outline_id TEXT NOT NULL CHECK (char_length(outline_id) BETWEEN 1 AND 256 AND
    outline_id !~ '[[:space:][:cntrl:]]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  policy_version TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  outline JSONB NOT NULL CHECK (jsonb_typeof(outline) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, session_id, task_boundary_id, version),
  UNIQUE (outline_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_session_task_outline_heads (
  scope_fingerprint TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_boundary_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope_fingerprint, session_id, task_boundary_id),
  FOREIGN KEY (scope_fingerprint, session_id, task_boundary_id, latest_version)
    REFERENCES mengshu_session_task_outline_versions (
      scope_fingerprint, session_id, task_boundary_id, version
    )
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_context_rewrite_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (char_length(receipt_id) BETWEEN 1 AND 256 AND
    receipt_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL,
  task_boundary_id TEXT,
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  output_hash TEXT NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  policy_version TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('normal', 'mild', 'aggressive', 'emergency')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  UNIQUE (scope_fingerprint, session_id, input_hash, policy_version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_session_close_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL,
  expired_entries INTEGER NOT NULL CHECK (expired_entries >= 0),
  reason TEXT NOT NULL,
  closed_at BIGINT NOT NULL CHECK (closed_at >= 0),
  UNIQUE (scope_fingerprint, session_id)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_session_working_set_entries_active_idx
ON mengshu_session_working_set_entries (
  scope_fingerprint, session_id, task_boundary_id, created_at, entry_id
) WHERE status IN ('active', 'summarized')`,
      `CREATE INDEX IF NOT EXISTS mengshu_context_rewrite_receipts_session_idx
ON mengshu_context_rewrite_receipts (scope_fingerprint, session_id, created_at DESC, receipt_id)`,
    ],
  },
  {
    version: 30,
    name: "add-reviewed-skill-artifacts",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_skill_candidates (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_id TEXT NOT NULL CHECK (char_length(candidate_id) BETWEEN 1 AND 256 AND
    candidate_id !~ '[[:space:][:cntrl:]]'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility = 'private'),
  topic_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'archived', 'rejected')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  candidate JSONB NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT CHECK (updated_at IS NULL OR updated_at >= created_at),
  PRIMARY KEY (scope_fingerprint, candidate_id),
  UNIQUE (candidate_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_skill_asset_versions (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  skill_id TEXT NOT NULL CHECK (char_length(skill_id) BETWEEN 1 AND 256 AND
    skill_id !~ '[[:space:][:cntrl:]]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility = 'private'),
  workspace_id TEXT,
  source_candidate_id TEXT,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'published', 'deprecated', 'revoked')),
  execution_mode TEXT NOT NULL CHECK (execution_mode = 'suggest_only'),
  resource_state TEXT NOT NULL CHECK (resource_state IN ('prepared', 'complete', 'failed')),
  expected_outcome_policy_version TEXT NOT NULL,
  artifact JSONB NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, skill_id, version),
  UNIQUE (scope_fingerprint, skill_id, version, content_hash)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_skill_asset_resources (
  scope_fingerprint TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1024 AND
    path !~ '[[:cntrl:]]' AND path !~ '(^|/)\.\.(/|$)' AND path !~ '^/'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  executable BOOLEAN NOT NULL CHECK (executable = FALSE),
  provenance_ref TEXT,
  PRIMARY KEY (scope_fingerprint, skill_id, version, path),
  FOREIGN KEY (scope_fingerprint, skill_id, version)
    REFERENCES mengshu_skill_asset_versions (scope_fingerprint, skill_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_skill_asset_heads (
  scope_fingerprint TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  latest_complete_version INTEGER NOT NULL CHECK (
    latest_complete_version >= 1 AND latest_complete_version <= latest_version
  ),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope_fingerprint, skill_id),
  FOREIGN KEY (scope_fingerprint, skill_id, latest_complete_version)
    REFERENCES mengshu_skill_asset_versions (scope_fingerprint, skill_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_skill_promotion_receipts (
  receipt_id TEXT NOT NULL UNIQUE CHECK (char_length(receipt_id) BETWEEN 1 AND 256 AND
    receipt_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  skill_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1),
  operation TEXT NOT NULL CHECK (operation IN ('propose', 'review', 'publish', 'append', 'revoke')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  PRIMARY KEY (scope_fingerprint, idempotency_key),
  FOREIGN KEY (scope_fingerprint, skill_id, artifact_version)
    REFERENCES mengshu_skill_asset_versions (scope_fingerprint, skill_id, version)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_skill_asset_versions_search_idx
ON mengshu_skill_asset_versions USING GIN (
  to_tsvector('simple', title || ' ' || description)
) WHERE status = 'published' AND resource_state = 'complete'`,
      `CREATE INDEX IF NOT EXISTS mengshu_skill_asset_versions_scope_status_idx
ON mengshu_skill_asset_versions (
  scope_fingerprint, status, resource_state, skill_id, version DESC
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_skill_candidates_scope_status_idx
ON mengshu_skill_candidates (scope_fingerprint, status, topic_label, created_at DESC, candidate_id)`,
    ],
  },
  {
    version: 31,
    name: "add-scoped-memory-policy-overlays",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_memory_policy_overlay_versions (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  overlay_id TEXT NOT NULL CHECK (char_length(overlay_id) BETWEEN 1 AND 256 AND
    overlay_id !~ '[[:space:][:cntrl:]]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  owner_user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility = 'private'),
  target_app_id TEXT,
  target_project_id TEXT,
  target_agent_id TEXT,
  layer TEXT NOT NULL CHECK (layer IN (
    'candidate_extraction', 'tree_summary', 'skill_review', 'document_organization'
  )),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'revoked')),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  guard_version TEXT NOT NULL CHECK (guard_version = 'memory-policy-guard-v1'),
  overlay JSONB NOT NULL CHECK (jsonb_typeof(overlay) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, overlay_id, version),
  CHECK (target_app_id IS NOT NULL OR target_project_id IS NOT NULL OR
    target_agent_id IS NOT NULL OR (
      target_app_id IS NULL AND target_project_id IS NULL AND target_agent_id IS NULL
    ))
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_policy_overlay_heads (
  scope_fingerprint TEXT NOT NULL,
  overlay_id TEXT NOT NULL,
  latest_version INTEGER NOT NULL CHECK (latest_version >= 1),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (scope_fingerprint, overlay_id),
  FOREIGN KEY (scope_fingerprint, overlay_id, latest_version)
    REFERENCES mengshu_memory_policy_overlay_versions (scope_fingerprint, overlay_id, version)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_memory_policy_overlay_receipts (
  receipt_id TEXT NOT NULL UNIQUE CHECK (char_length(receipt_id) BETWEEN 1 AND 256 AND
    receipt_id !~ '[[:space:][:cntrl:]]'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  overlay_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
  PRIMARY KEY (scope_fingerprint, idempotency_key),
  FOREIGN KEY (scope_fingerprint, overlay_id, version)
    REFERENCES mengshu_memory_policy_overlay_versions (scope_fingerprint, overlay_id, version)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_memory_policy_overlay_active_idx
ON mengshu_memory_policy_overlay_versions (
  scope_fingerprint, layer, status, target_project_id, target_agent_id,
  target_app_id, overlay_id, version DESC
)`,
    ],
  },
  {
    version: 32,
    name: "add-temporal-prerequisite-repair-audit",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_temporal_prerequisite_repair_runs (
  run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 256 AND
    run_id !~ '[[:space:][:cntrl:]]'),
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  before_hash TEXT NOT NULL CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash TEXT CHECK (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('planned', 'applied', 'verified', 'rolled_back', 'failed')),
  scanned_count INTEGER NOT NULL CHECK (scanned_count >= 0),
  repaired_count INTEGER NOT NULL CHECK (repaired_count >= 0),
  review_count INTEGER NOT NULL CHECK (review_count >= 0),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_temporal_prerequisite_repair_rows (
  run_id TEXT NOT NULL REFERENCES mengshu_temporal_prerequisite_repair_runs(run_id),
  memory_id UUID NOT NULL REFERENCES memories(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('migrate_candidate', 'quarantine_duplicate', 'review_invalid_hash')),
  duplicate_of UUID,
  candidate_id TEXT,
  candidate_inserted BOOLEAN,
  before_hash TEXT NOT NULL CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  after_hash TEXT CHECK (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$'),
  before_row JSONB NOT NULL CHECK (jsonb_typeof(before_row) = 'object'),
  after_row JSONB CHECK (after_row IS NULL OR jsonb_typeof(after_row) = 'object'),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, memory_id),
  CHECK ((disposition = 'migrate_candidate' AND candidate_id IS NOT NULL) OR
    (disposition = 'quarantine_duplicate' AND duplicate_of IS NOT NULL) OR
    disposition = 'review_invalid_hash')
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_temporal_prerequisite_repair_rows_disposition_idx
ON mengshu_temporal_prerequisite_repair_rows (run_id, disposition, memory_id)`,
    ],
  },
  {
    version: 33,
    name: "add-session-working-set-cleanup-receipts",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_session_cleanup_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 256 AND
    session_id !~ '[[:space:][:cntrl:]]'),
  reason TEXT NOT NULL CHECK (reason IN ('session_closed', 'retention_expired')),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  closed_at BIGINT NOT NULL CHECK (closed_at >= 0),
  UNIQUE (scope_fingerprint, session_id, reason)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_session_cleanup_receipts_closed_idx
ON mengshu_session_cleanup_receipts (closed_at, receipt_id)`,
    ],
  },
  {
    version: 34,
    name: "add-temporal-future-activation-state",
    kind: "expand",
    statements: [
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS temporal_activation_state TEXT NOT NULL DEFAULT 'active' CHECK (temporal_activation_state IN ('active', 'staged'))",
      `CREATE INDEX IF NOT EXISTS memories_temporal_staged_activation_idx
ON memories (valid_from, scope_fingerprint, lineage_id, revision)
WHERE temporal_activation_state = 'staged' AND temporal_purge_pending IS NOT TRUE`,
    ],
  },
  {
    version: 35,
    name: "add-temporal-purge-retry-requests",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_memory_purge_retry_requests (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  lineage_id TEXT NOT NULL CHECK (char_length(lineage_id) BETWEEN 1 AND 256 AND
    lineage_id !~ '[[:space:][:cntrl:]]'),
  operation_id TEXT NOT NULL UNIQUE CHECK (char_length(operation_id) BETWEEN 1 AND 256 AND
    operation_id !~ '[[:space:][:cntrl:]]'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256 AND
    idempotency_key !~ '[[:space:][:cntrl:]]'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  version_ids JSONB NOT NULL CHECK (jsonb_typeof(version_ids) = 'array'),
  derived_artifacts_purged INTEGER NOT NULL DEFAULT 0 CHECK (derived_artifacts_purged >= 0),
  derived_complete BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at BIGINT NOT NULL CHECK (next_attempt_at >= 0),
  last_error_code TEXT,
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (scope_fingerprint, idempotency_key),
  UNIQUE (scope_fingerprint, lineage_id)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_memory_purge_retry_due_idx
ON mengshu_memory_purge_retry_requests (next_attempt_at, scope_fingerprint, lineage_id)`,
    ],
  },
  {
    version: 36,
    name: "add-memory-evolution-batches",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_batches (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  id TEXT NOT NULL CHECK (char_length(id) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 262144),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  lease_owner TEXT,
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at BIGINT NOT NULL DEFAULT 0 CHECK (lease_expires_at >= 0),
  PRIMARY KEY (scope_fingerprint, id),
  UNIQUE (scope_fingerprint, idempotency_key)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_apply_receipts (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  proposal_id TEXT NOT NULL CHECK (char_length(proposal_id) BETWEEN 1 AND 256),
  batch_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 16384),
  PRIMARY KEY (scope_fingerprint, proposal_id),
  FOREIGN KEY (scope_fingerprint, batch_id) REFERENCES mengshu_evolution_batches (scope_fingerprint, id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_processed_inputs (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  action TEXT NOT NULL CHECK (action IN ('propose', 'apply_allowed')),
  proposal_id TEXT NOT NULL CHECK (char_length(proposal_id) BETWEEN 1 AND 256),
  processed_at BIGINT NOT NULL CHECK (processed_at >= 0),
  PRIMARY KEY (scope_fingerprint, input_fingerprint, action)
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_evolution_candidates_batch_idx
ON mengshu_candidates ((metadata->'evolution'->'proposal'->>'batchId'), created_at, id)
WHERE metadata ? 'evolution'`,
      `CREATE INDEX IF NOT EXISTS memories_evolution_inventory_keyset_idx
ON memories (tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, created_at, id)`,
    ],
  },
  {
    version: 37,
    name: "add-evolution-governance-and-maintenance",
    kind: "expand",
    statements: [
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_reviews (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  review_id TEXT NOT NULL CHECK (char_length(review_id) BETWEEN 1 AND 256),
  proposal_id TEXT NOT NULL CHECK (char_length(proposal_id) BETWEEN 1 AND 256),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  review JSONB NOT NULL CHECK (jsonb_typeof(review) = 'object' AND octet_length(review::text) <= 196608),
  reviewer_id TEXT CHECK (reviewer_id IS NULL OR char_length(reviewer_id) BETWEEN 1 AND 256),
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  receipt_id TEXT,
  receipt JSONB CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 32768),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at),
  revoked_at BIGINT,
  consumed_at BIGINT,
  consumed_by_proposal_id TEXT,
  PRIMARY KEY (scope_fingerprint, review_id),
  UNIQUE (scope_fingerprint, receipt_id),
  CHECK ((decision IS NULL AND receipt IS NULL AND receipt_id IS NULL AND reviewer_id IS NULL)
    OR (decision IS NOT NULL AND receipt IS NOT NULL AND receipt_id IS NOT NULL AND reviewer_id IS NOT NULL))
)`,
      `CREATE INDEX IF NOT EXISTS mengshu_evolution_reviews_proposal_idx
ON mengshu_evolution_reviews (scope_fingerprint, proposal_id, created_at DESC, review_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS mengshu_evolution_reviews_one_decision_idx
ON mengshu_evolution_reviews (scope_fingerprint, proposal_id) WHERE receipt IS NOT NULL AND revoked_at IS NULL`,
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS evolution_review_due_at BIGINT NOT NULL DEFAULT 0 CHECK (evolution_review_due_at >= 0)",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS evolution_disputed BOOLEAN NOT NULL DEFAULT FALSE",
      "ALTER TABLE memories ADD COLUMN IF NOT EXISTS evolution_alias_of UUID REFERENCES memories(id)",
      `CREATE INDEX IF NOT EXISTS memories_evolution_due_idx
ON memories (tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, evolution_review_due_at, id)
WHERE evolution_alias_of IS NULL AND temporal_purge_pending IS NOT TRUE`,
      "ALTER TABLE mengshu_write_outbox ADD COLUMN IF NOT EXISTS evolution_consumed_at BIGINT",
      "ALTER TABLE mengshu_write_outbox ADD COLUMN IF NOT EXISTS evolution_origin BOOLEAN NOT NULL DEFAULT FALSE",
      `CREATE INDEX IF NOT EXISTS mengshu_write_outbox_evolution_pending_idx
ON mengshu_write_outbox (tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, occurred_at, event_id)
WHERE evolution_consumed_at IS NULL AND evolution_origin IS FALSE`,
      "ALTER TABLE mengshu_memory_version_outbox ADD COLUMN IF NOT EXISTS evolution_consumed_at BIGINT",
      "ALTER TABLE mengshu_memory_version_outbox ADD COLUMN IF NOT EXISTS evolution_origin BOOLEAN NOT NULL DEFAULT FALSE",
      `CREATE INDEX IF NOT EXISTS mengshu_memory_version_outbox_evolution_pending_idx
ON mengshu_memory_version_outbox (scope_fingerprint, occurred_at, event_id)
WHERE evolution_consumed_at IS NULL AND evolution_origin IS FALSE`,
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS relation_state TEXT NOT NULL DEFAULT 'effective' CHECK (relation_state IN ('staged', 'effective', 'reviewed_reference', 'contradicting', 'superseded', 'revoked'))",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS root_evidence_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_revision TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_current_revision TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_hash TEXT CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$')",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_kind TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_record_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_path_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_span_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS source_logical_file_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS continuity_key TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS independence_group_id TEXT",
      "ALTER TABLE mengshu_memory_evidence_links ADD COLUMN IF NOT EXISTS retired_at BIGINT",
      `CREATE INDEX IF NOT EXISTS mengshu_memory_evidence_links_source_state_idx
ON mengshu_memory_evidence_links (scope_fingerprint, source_id, source_revision, relation_state, target_memory_id)`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_source_dispositions (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  source_id TEXT NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 256),
  logical_file_id TEXT NOT NULL DEFAULT '' CHECK (char_length(logical_file_id) <= 256),
  revision TEXT NOT NULL CHECK (char_length(revision) BETWEEN 1 AND 256),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  disposition TEXT NOT NULL CHECK (disposition IN ('current', 'unavailable', 'superseded', 'revoked')),
  receipt_id TEXT NOT NULL,
  changed_at BIGINT NOT NULL CHECK (changed_at >= 0),
  PRIMARY KEY (scope_fingerprint, source_id, logical_file_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_operation_receipts (
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 64),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 32768),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (scope_fingerprint, idempotency_key)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_budget_reservations (
  owner_key TEXT NOT NULL CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  day_key TEXT NOT NULL CHECK (day_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  reservation_id TEXT NOT NULL CHECK (char_length(reservation_id) BETWEEN 1 AND 256),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens >= 0),
  reserved_cost_micros BIGINT NOT NULL CHECK (reserved_cost_micros >= 0),
  actual_tokens BIGINT CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
  actual_cost_micros BIGINT CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  expires_at BIGINT NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (owner_key, day_key, reservation_id)
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS mengshu_evolution_operation_receipt_id_idx
ON mengshu_evolution_operation_receipts (scope_fingerprint, (receipt->>'id')) WHERE receipt ? 'id'`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_host_state (
  owner_key TEXT NOT NULL CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  entry_id TEXT NOT NULL CHECK (entry_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  value JSONB NOT NULL CHECK (octet_length(value::text) <= 32768),
  value_hash TEXT NOT NULL CHECK (value_hash ~ '^[0-9a-f]{64}$'),
  updated_at BIGINT NOT NULL CHECK (updated_at >= 0),
  expires_at BIGINT CHECK (expires_at IS NULL OR expires_at > updated_at),
  revoked_at BIGINT CHECK (revoked_at IS NULL OR revoked_at >= 0),
  PRIMARY KEY (owner_key, scope_fingerprint, kind, entry_id)
)`,
      `CREATE TABLE IF NOT EXISTS mengshu_evolution_host_receipts (
  owner_key TEXT NOT NULL CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  scope_fingerprint TEXT NOT NULL CHECK (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  receipt_id TEXT NOT NULL CHECK (receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$'),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 32768),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  consumed_by TEXT CHECK (consumed_by IS NULL OR consumed_by ~ '^[0-9a-f]{64}$'),
  consumed_at BIGINT CHECK (consumed_at IS NULL OR consumed_at >= 0),
  PRIMARY KEY (owner_key, scope_fingerprint, kind, idempotency_key),
  UNIQUE (owner_key, scope_fingerprint, receipt_id),
  CHECK ((consumed_by IS NULL) = (consumed_at IS NULL))
)`,
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
