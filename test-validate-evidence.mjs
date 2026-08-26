import { readFileSync } from 'fs';
import {
  createHistoryWorkMemoryProjectionDependencies
} from './dist/scripts/operator-history-work-memory-projection.js';
import { loadHistoryRebuildManifest } from './dist/scripts/operator-history-rebuild.js';
import { PostgresActiveMemoryDerivationReadPort } from './dist/packages/core/src/graph/postgres-active-derivation-read-port.js';

const configPath = process.env.HOME + '/.mengshu/config.json';
const manifestPath = process.env.HOME + '/.mengshu/migrations/2026-08-16-history-rebuild-prod-02/history-rebuild-manifest.json';

const deps = createHistoryWorkMemoryProjectionDependencies();
const manifestText = readFileSync(manifestPath, 'utf8');
const loaded = loadHistoryRebuildManifest(manifestText);
const configText = readFileSync(configPath, 'utf8');
const config = deps.parseConfig(configText);
const connection = await deps.connect(config);

const runId = '51af33db-028a-44cb-b486-cc247b3482a4';

try {
  const ACTIVE_MEMORY_IDS_SQL = `SELECT memory.id::text AS id
  FROM memories memory
  WHERE memory.metadata#>>'{historyRebuild,runId}' = $1
    AND memory.metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
    AND memory.data_type = 'memory'
    AND memory.lifecycle_status = 'active'
    AND memory.metadata->>'admissionRoute' = 'active'
    AND memory.metadata->>'contextEligible' = 'true'
    AND memory.legacy_quarantine_reason IS NULL
  ORDER BY memory.created_at, memory.id
  LIMIT 1`;

  const idRows = await connection.client.query(ACTIVE_MEMORY_IDS_SQL, [runId]);
  const activeMemoryIds = idRows.rows.map((r) => r.id);

  // Get scope
  const runRow = await connection.client.query(
    `SELECT tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id
     FROM mengshu_history_rebuild_runs WHERE run_id = $1`,
    [runId]
  );

  const row = runRow.rows[0];
  const scope = {
    tenantId: row.tenant_id,
    userId: row.user_id,
    appId: row.app_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    namespace: row.namespace,
    visibility: row.visibility,
    ...(row.workspace_id && row.workspace_id !== '' ? { workspaceId: row.workspace_id } : {}),
    ...(row.session_id && row.session_id !== '' ? { sessionId: row.session_id } : {}),
  };

  const readPort = new PostgresActiveMemoryDerivationReadPort(connection.client);
  const signal = new AbortController().signal;

  const records = await readPort.readCommittedActiveRecords({
    activeMemoryIds, scope, signal
  });

  const evidenceFacts = await readPort.readEvidenceFacts({
    memoryIds: activeMemoryIds, records, signal
  });

  console.log('Testing first evidence fact validation...');
  const fact = evidenceFacts[0];

  console.log('\nFact:', {
    evidenceId: fact.evidenceId,
    evidenceKind: fact.evidenceKind,
    label: fact.label.substring(0, 50) + '...',
    createdAt: fact.createdAt,
    scope: fact.scope,
    metadata: typeof fact.metadata
  });

  // Manual validation
  const EVIDENCE_KINDS = new Set(['chunk', 'observation', 'document', 'message', 'resource']);

  function safeId(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  }

  function nonEmpty(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function isValidScope(scope) {
    return Boolean(scope) && typeof scope === 'object' &&
      typeof scope.tenantId === 'string' && scope.tenantId.length > 0 &&
      typeof scope.userId === 'string' && scope.userId.length > 0 &&
      typeof scope.appId === 'string' && scope.appId.length > 0 &&
      typeof scope.projectId === 'string' && scope.projectId.length > 0 &&
      typeof scope.agentId === 'string' && scope.agentId.length > 0 &&
      typeof scope.namespace === 'string' && scope.namespace.length > 0 &&
      typeof scope.visibility === 'string' && scope.visibility.length > 0;
  }

  console.log('\n=== Validation Checks ===');
  console.log('Boolean(fact):', Boolean(fact));
  console.log('typeof fact === "object":', typeof fact === 'object');
  console.log('safeId(fact.evidenceId):', safeId(fact.evidenceId));
  console.log('isValidScope(fact.scope):', isValidScope(fact.scope));
  console.log('EVIDENCE_KINDS.has(fact.evidenceKind):', EVIDENCE_KINDS.has(fact.evidenceKind));
  console.log('nonEmpty(fact.label):', nonEmpty(fact.label));
  console.log('Number.isSafeInteger(fact.createdAt):', Number.isSafeInteger(fact.createdAt));
  console.log('fact.createdAt >= 0:', fact.createdAt >= 0);
  console.log('Boolean(fact.metadata):', Boolean(fact.metadata));
  console.log('typeof fact.metadata === "object":', typeof fact.metadata === 'object');
  console.log('!Array.isArray(fact.metadata):', !Array.isArray(fact.metadata));

  const allPass = Boolean(fact) && typeof fact === 'object' &&
    safeId(fact.evidenceId) && isValidScope(fact.scope) &&
    EVIDENCE_KINDS.has(fact.evidenceKind) &&
    nonEmpty(fact.label) && Number.isSafeInteger(fact.createdAt) && fact.createdAt >= 0 &&
    Boolean(fact.metadata) && typeof fact.metadata === 'object' && !Array.isArray(fact.metadata);

  console.log('\n=== Overall ===');
  console.log('Valid?:', allPass);

  if (!allPass) {
    console.log('\nDetailed scope check:');
    console.log('  scope:', JSON.stringify(fact.scope, null, 2));
  }

} finally {
  await connection.close();
}
