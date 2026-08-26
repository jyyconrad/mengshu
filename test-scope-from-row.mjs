import { readFileSync } from 'fs';
import {
  createHistoryWorkMemoryProjectionDependencies
} from './dist/scripts/operator-history-work-memory-projection.js';
import { loadHistoryRebuildManifest } from './dist/scripts/operator-history-rebuild.js';

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
  ORDER BY scope_fingerprint, run_id
  LIMIT 5`;

  const runRows = await connection.client.query(RUNS_SQL, [
    loaded.manifest.migrationId, loaded.sha256,
  ]);

  console.log(`Found ${runRows.rows.length} runs`);

  for (let i = 0; i < runRows.rows.length; i++) {
    const row = runRows.rows[i];
    console.log(`\n=== Run ${i + 1} ===`);
    console.log('run_id:', row.run_id);
    console.log('workspace_id:', JSON.stringify(row.workspace_id), 'type:', typeof row.workspace_id);
    console.log('session_id:', JSON.stringify(row.session_id), 'type:', typeof row.session_id);
    console.log('scope_fingerprint:', row.scope_fingerprint);

    // Simulate scopeFromRow logic
    try {
      const workspaceId = typeof row.workspace_id === "string" && row.workspace_id !== ""
        ? row.workspace_id : undefined;
      const sessionId = typeof row.session_id === "string" && row.session_id !== ""
        ? row.session_id : undefined;

      console.log('Parsed workspaceId:', JSON.stringify(workspaceId));
      console.log('Parsed sessionId:', JSON.stringify(sessionId));

      const scope = {
        tenantId: row.tenant_id,
        userId: row.user_id,
        appId: row.app_id,
        projectId: row.project_id,
        agentId: row.agent_id,
        namespace: row.namespace,
        visibility: row.visibility,
        ...(workspaceId ? { workspaceId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };

      const { authorityScopeFingerprint } = await import('./dist/packages/core/src/domain/authority-scope-fingerprint.js');
      const computed = authorityScopeFingerprint(scope);
      console.log('Computed fingerprint:', computed);
      console.log('Match?', computed === row.scope_fingerprint);

      if (computed !== row.scope_fingerprint) {
        console.error('MISMATCH!');
        console.log('Scope:', JSON.stringify(scope, null, 2));
      }
    } catch (error) {
      console.error('Error processing row:', error.message);
    }
  }

} finally {
  await connection.close();
}
