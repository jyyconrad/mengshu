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

  const record = records[0];
  const fact = evidenceFacts[0];

  console.log('Memory scope:');
  console.log(JSON.stringify(record.scope, null, 2));

  console.log('\nEvidence scope:');
  console.log(JSON.stringify(fact.scope, null, 2));

  console.log('\nJSON match?:', JSON.stringify(record.scope) === JSON.stringify(fact.scope));

  console.log('\nField-by-field comparison:');
  const keys = new Set([...Object.keys(record.scope), ...Object.keys(fact.scope)]);
  for (const key of keys) {
    const match = record.scope[key] === fact.scope[key];
    console.log(`  ${key}: ${match ? '✓' : '✗'} (memory: ${JSON.stringify(record.scope[key])}, evidence: ${JSON.stringify(fact.scope[key])})`);
  }

} finally {
  await connection.close();
}
