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

try {
  console.log('Step 1: Query runs...');
  const RUNS_SQL = `SELECT run_id, scope_fingerprint, tenant_id, user_id, app_id, project_id,
    agent_id, namespace, visibility, workspace_id, session_id
  FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
  ORDER BY scope_fingerprint, run_id`;

  const runRows = await connection.client.query(RUNS_SQL, [
    loaded.manifest.migrationId, loaded.sha256,
  ]);
  console.log(`Found ${runRows.rows.length} completed runs`);

  if (runRows.rows.length === 0) {
    console.log('ERROR: No runs found');
    process.exit(1);
  }

  console.log('\nStep 2: Query active memories for first run...');
  const firstRun = runRows.rows[0];
  console.log('Run ID:', firstRun.run_id);
  console.log('Scope:', firstRun.tenant_id, firstRun.user_id, firstRun.visibility);

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

  const idRows = await connection.client.query(ACTIVE_MEMORY_IDS_SQL, [firstRun.run_id]);
  console.log(`Found ${idRows.rows.length} active memory IDs`);

  if (idRows.rows.length === 0) {
    console.log('No active memories for this run, trying next...');
    process.exit(0);
  }

  const activeMemoryIds = idRows.rows.map((row) => row.id);
  console.log('First 3 IDs:', activeMemoryIds.slice(0, 3));

  console.log('\nStep 3: Read committed active records...');
  const readPort = new PostgresActiveMemoryDerivationReadPort(connection.client);
  const scope = {
    tenantId: firstRun.tenant_id,
    userId: firstRun.user_id,
    appId: firstRun.app_id,
    projectId: firstRun.project_id,
    agentId: firstRun.agent_id,
    namespace: firstRun.namespace,
    visibility: firstRun.visibility,
    ...(firstRun.workspace_id === '' ? {} : { workspaceId: firstRun.workspace_id }),
    ...(firstRun.session_id === '' ? {} : { sessionId: firstRun.session_id }),
  };

  try {
    const signal = new AbortController().signal;
    const testIds = activeMemoryIds.slice(0, 5);
    const records = await readPort.readCommittedActiveRecords({
      activeMemoryIds: testIds,
      scope,
      signal
    });
    console.log(`Successfully read ${records.length} records`);
    console.log('First record:', {
      id: records[0]?.id,
      commandType: records[0]?.commandType,
      kind: records[0]?.kind,
      container: records[0]?.container,
    });

    console.log('\nStep 4: Read evidence facts...');
    const evidenceFacts = await readPort.readEvidenceFacts({
      memoryIds: testIds,
      records,
      signal
    });
    console.log(`Successfully read ${evidenceFacts.length} evidence facts`);

    console.log('\nStep 5: Derive active memory projections...');
    const { deriveActiveMemoryProjections } = await import('./dist/packages/core/src/graph/active-memory-derivation.js');
    const projection = deriveActiveMemoryProjections({
      records,
      activeMemoryIds: testIds,
      evidenceFacts,
      treeFacts: []
    });
    console.log(`Generated ${projection.projections.length} projections`);
    console.log('Expected:', testIds.length);

    if (projection.projections.length !== testIds.length) {
      console.error('ERROR: Projection count mismatch!');
      console.log('Missing projections:', testIds.length - projection.projections.length);
    }

    for (let i = 0; i < projection.projections.length; i++) {
      const item = projection.projections[i];
      console.log(`\nProjection ${i + 1}:`, {
        status: item.graph.status,
        nodes: item.graph.status === 'available' ? item.graph.batch.nodes.length : 'N/A',
        edges: item.graph.status === 'available' ? item.graph.batch.edges.length : 'N/A',
      });
      if (item.graph.status !== 'available') {
        console.error('  ERROR: Graph status is not available!');
        if (item.graph.status === 'quarantined') {
          console.error('  Reason:', item.graph.reason);
        }
      }
    }

  } catch (error) {
    console.error('Failed:', error.message);
    console.error('Error code:', error.code);
    console.error('Stack:', error.stack);
    throw error;
  }

} finally {
  await connection.close();
}
