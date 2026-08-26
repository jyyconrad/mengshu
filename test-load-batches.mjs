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
  await connection.client.query('BEGIN READ ONLY');

  console.log('Calling loadBatches...');
  const result = await deps.loadBatches({
    client: connection.client,
    manifest: loaded.manifest,
    manifestSha256: loaded.sha256
  });

  console.log('Success!');
  console.log('Result:', {
    batches: result.batches.length,
    activeMemories: result.activeMemories,
    evidenceNodes: result.evidenceNodes,
    summaries: result.summaries
  });

  await connection.client.query('ROLLBACK');
} catch (error) {
  await connection.client.query('ROLLBACK').catch(() => {});
  console.error('Error:', error.message);
  console.error('Code:', error.code);
  console.error('Stack:', error.stack);
  throw error;
} finally {
  await connection.close();
}
