import { readFileSync } from 'fs';
import {
  createHistoryWorkMemoryProjectionDependencies
} from './dist/scripts/operator-history-work-memory-projection.js';
import { loadHistoryRebuildManifest } from './dist/scripts/operator-history-rebuild.js';

const configPath = process.env.HOME + '/.mengshu/config.json';
const manifestPath = process.env.HOME + '/.mengshu/migrations/2026-08-16-history-rebuild-prod-02/history-rebuild-manifest.json';

console.log('Step 1: Creating dependencies...');
const deps = createHistoryWorkMemoryProjectionDependencies();

console.log('\nStep 2: Loading manifest...');
const manifestText = readFileSync(manifestPath, 'utf8');
const loaded = loadHistoryRebuildManifest(manifestText);
console.log('Manifest loaded:', {
  migrationId: loaded.manifest.migrationId,
  requiredSchemaVersion: loaded.manifest.requiredSchemaVersion,
  requireSealed: loaded.manifest.tree.requireSealed,
  sha256: loaded.sha256
});

console.log('\nStep 3: Parsing config...');
const configText = readFileSync(configPath, 'utf8');
const config = deps.parseConfig(configText);
console.log('Config parsed successfully');

console.log('\nStep 4: Connecting to database...');
const connection = await deps.connect(config);
console.log('Connected successfully');

try {
  console.log('\nStep 5: Acquiring advisory lock...');
  const lockResult = await connection.client.query(
    `SELECT pg_try_advisory_lock(hashtextextended(concat_ws(chr(31), 'mengshu.history-rebuild-operator/v1', $1::text), 0)) AS acquired`,
    [loaded.manifest.migrationId]
  );
  console.log('Lock acquired:', lockResult.rows[0]);

  console.log('\nStep 6: Starting transaction...');
  await connection.client.query('BEGIN READ ONLY');
  console.log('Transaction started');

  console.log('\nStep 7: Asserting schema version...');
  try {
    await deps.assertSchemaVersion({
      client: connection.client,
      manifest: loaded.manifest,
      manifestSha256: loaded.sha256,
      operatorConfig: config
    });
    console.log('Schema version OK');
  } catch (error) {
    console.error('Schema version check failed:', error.message);
    throw error;
  }

  console.log('\nStep 8: Loading batches...');
  try {
    const loadedBatches = await deps.loadBatches({
      client: connection.client,
      manifest: loaded.manifest,
      manifestSha256: loaded.sha256
    });
    console.log('Batches loaded:', {
      batches: loadedBatches.batches.length,
      activeMemories: loadedBatches.activeMemories,
      evidenceNodes: loadedBatches.evidenceNodes,
      summaries: loadedBatches.summaries
    });
  } catch (error) {
    console.error('Batch loading failed:', error.message);
    console.error('Stack:', error.stack);
    throw error;
  }

  await connection.client.query('ROLLBACK');
  console.log('\nTransaction rolled back');

} catch (error) {
  console.error('\nError during execution:', error);
  await connection.client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await connection.close();
  console.log('Connection closed');
}
