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

try {
  const RUNS_SQL = `SELECT run_id, scope_fingerprint, tenant_id, user_id, app_id, project_id,
    agent_id, namespace, visibility, workspace_id, session_id
  FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
  ORDER BY scope_fingerprint, run_id`;

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

  const runRows = await connection.client.query(RUNS_SQL, [
    loaded.manifest.migrationId, loaded.sha256,
  ]);

  console.log(`Found ${runRows.rows.length} runs`);

  const readPort = new PostgresActiveMemoryDerivationReadPort(connection.client);
  let totalProjections = 0;
  let unavailableCount = 0;

  for (let i = 0; i < runRows.rows.length; i++) {
    const row = runRows.rows[i];
    const idRows = await connection.client.query(ACTIVE_MEMORY_IDS_SQL, [row.run_id]);
    const activeMemoryIds = idRows.rows.map((r) => r.id);

    if (activeMemoryIds.length === 0) continue;

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

    const signal = new AbortController().signal;
    const records = await readPort.readCommittedActiveRecords({
      activeMemoryIds, scope, signal
    });
    const evidenceFacts = await readPort.readEvidenceFacts({
      memoryIds: activeMemoryIds, records, signal
    });
    const projection = deriveActiveMemoryProjections({
      records, activeMemoryIds, evidenceFacts, treeFacts: []
    });

    totalProjections += projection.projections.length;

    for (const item of projection.projections) {
      if (item.graph.status !== 'available') {
        unavailableCount++;
        console.log(`\n=== Unavailable Projection (Run ${i + 1}) ===`);
        console.log('Run ID:', row.run_id);
        console.log('Memory count:', activeMemoryIds.length);
        console.log('Projection index:', projection.projections.indexOf(item));
        console.log('Status:', item.graph.status);
        console.log('Reason:', item.graph.reason);

        // Only print first 3 to avoid too much output
        if (unavailableCount >= 3) {
          console.log('\n... stopping after 3 unavailable projections');
          break;
        }
      }
    }

    if (unavailableCount >= 3) break;
  }

  console.log(`\n=== Summary ===`);
  console.log('Total projections:', totalProjections);
  console.log('Unavailable:', unavailableCount);
  console.log('Available:', totalProjections - unavailableCount);

} finally {
  await connection.close();
}
