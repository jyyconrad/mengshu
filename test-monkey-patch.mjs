import { readFileSync } from 'fs';
import {
  createHistoryWorkMemoryProjectionDependencies
} from './dist/scripts/operator-history-work-memory-projection.js';
import { loadHistoryRebuildManifest } from './dist/scripts/operator-history-rebuild.js';
import { PostgresActiveMemoryDerivationReadPort } from './dist/packages/core/src/graph/postgres-active-derivation-read-port.js';

// Monkey-patch to debug
const Module = await import('./dist/packages/core/src/graph/active-memory-derivation.js');
const originalDerive = Module.deriveActiveMemoryProjections;

Module.deriveActiveMemoryProjections = function(input) {
  console.log('\n=== Inside deriveActiveMemoryProjections ===');
  console.log('records:', input.records.length);
  console.log('activeMemoryIds:', input.activeMemoryIds.length);
  console.log('evidenceFacts:', input.evidenceFacts.length);

  // Build evidenceById map
  const evidenceById = new Map();
  for (const fact of input.evidenceFacts) {
    evidenceById.set(fact.evidenceId, fact);
  }

  console.log('\nChecking first record manually...');
  const record = input.records[0];
  console.log('Record evidenceIds:', record.evidenceIds);

  for (const evidenceId of record.evidenceIds) {
    const fact = evidenceById.get(evidenceId);
    console.log(`\nEvidence ${evidenceId}:`);
    console.log('  found in map?:', !!fact);
    if (fact) {
      console.log('  Boolean(fact):', Boolean(fact));
      console.log('  typeof fact:', typeof fact);
      console.log('  fact.evidenceId:', fact.evidenceId);
      console.log('  fact.evidenceKind:', fact.evidenceKind);
      console.log('  fact.label type:', typeof fact.label);
      console.log('  fact.label empty?:', !fact.label || fact.label.trim().length === 0);
      console.log('  fact.createdAt:', fact.createdAt);
      console.log('  Number.isSafeInteger(fact.createdAt):', Number.isSafeInteger(fact.createdAt));
      console.log('  fact.metadata:', typeof fact.metadata);
      console.log('  fact.scope:', fact.scope);
    }
  }

  return originalDerive(input);
};

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

  console.log('Calling deriveActiveMemoryProjections...');
  const projection = Module.deriveActiveMemoryProjections({
    records,
    activeMemoryIds,
    evidenceFacts,
    treeFacts: []
  });

  console.log('\nResult:', projection.projections[0].graph.status, projection.projections[0].graph.reason);

} finally {
  await connection.close();
}
