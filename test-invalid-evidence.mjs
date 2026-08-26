import { readFileSync } from 'fs';
import {
  createHistoryWorkMemoryProjectionDependencies
} from './dist/scripts/operator-history-work-memory-projection.js';
import { loadHistoryRebuildManifest } from './dist/scripts/operator-history-rebuild.js';
import { PostgresActiveMemoryDerivationReadPort } from './dist/packages/core/src/graph/postgres-active-derivation-read-port.js';
import { deriveActiveMemoryProjections } from './dist/packages/core/src/graph/active-memory-derivation.js';

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
  ORDER BY memory.created_at, memory.id`;

  const idRows = await connection.client.query(ACTIVE_MEMORY_IDS_SQL, [runId]);
  const activeMemoryIds = idRows.rows.map((r) => r.id);

  console.log(`Run ${runId} has ${activeMemoryIds.length} active memories`);

  // Get scope from run
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

  console.log(`Read ${records.length} records`);

  const evidenceFacts = await readPort.readEvidenceFacts({
    memoryIds: activeMemoryIds, records, signal
  });

  console.log(`Read ${evidenceFacts.length} evidence facts`);

  // Check each record's evidence
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    console.log(`\n=== Memory ${i + 1}: ${record.id} ===`);
    console.log('Evidence IDs:', record.evidenceIds);

    for (const evidenceId of record.evidenceIds) {
      const fact = evidenceFacts.find(f => f.evidenceId === evidenceId);
      if (!fact) {
        console.log(`  ✗ Evidence ${evidenceId}: MISSING`);
      } else {
        console.log(`  ✓ Evidence ${evidenceId}:`);
        console.log('    kind:', fact.evidenceKind);
        console.log('    label:', JSON.stringify(fact.label), 'length:', fact.label?.length);
        console.log('    createdAt:', fact.createdAt, 'type:', typeof fact.createdAt, 'safe int?:', Number.isSafeInteger(fact.createdAt));
        console.log('    metadata:', typeof fact.metadata, 'isObject?:', fact.metadata && typeof fact.metadata === 'object', 'isArray?:', Array.isArray(fact.metadata));
        console.log('    scope:', fact.scope);
      }
    }
  }

  const projection = deriveActiveMemoryProjections({
    records, activeMemoryIds, evidenceFacts, treeFacts: []
  });

  console.log(`\n=== Projection Results ===`);
  for (let i = 0; i < projection.projections.length; i++) {
    const item = projection.projections[i];
    console.log(`Projection ${i + 1}: ${item.graph.status}${item.graph.status !== 'available' ? ` (${item.graph.reason})` : ''}`);
  }

} finally {
  await connection.close();
}
