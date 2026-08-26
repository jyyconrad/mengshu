import { readFileSync } from 'fs';
import pg from 'pg';

const configText = readFileSync(process.env.HOME + '/.mengshu/config.json', 'utf8');
const config = JSON.parse(configText);

const pool = new pg.Pool({
  ...config.postgres,
  max: 1,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

const connection = await pool.connect();

const ACTIVE_MEMORY_IDS_SQL = `
SELECT memory.id::text AS id, memory.text, memory.data_type, memory.lifecycle_status,
  memory.legacy_quarantine_reason, memory.importance, memory.category,
  memory.vector::text AS vector_text,
  memory.created_at AS created_at_ms, memory.metadata
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

// 获取一个 runId
const runsResult = await connection.query(`
  SELECT run_id FROM mengshu_history_rebuild_runs
  WHERE migration_id = 'history-rebuild-2026-08-16-prod-02'
    AND manifest_hash = '441ae448587d15af27be16f49d53871457c61dcfd02a0f43aca373aedf49a957'
    AND state = 'completed'
  LIMIT 1
`);

if (runsResult.rows.length === 0) {
  console.log('No completed runs found');
  process.exit(1);
}

const runId = runsResult.rows[0].run_id;
console.log('Testing with runId:', runId);

const result = await connection.query(ACTIVE_MEMORY_IDS_SQL, [runId]);

if (result.rows.length === 0) {
  console.log('No active memories found for this run');
  process.exit(0);
}

const row = result.rows[0];
console.log('\n=== Memory Record ===');
console.log('ID:', row.id);
console.log('Text length:', row.text?.length);
console.log('Text trimmed empty?:', !row.text || row.text.trim().length === 0);
console.log('data_type:', row.data_type);
console.log('lifecycle_status:', row.lifecycle_status);
console.log('legacy_quarantine_reason:', row.legacy_quarantine_reason);
console.log('importance:', row.importance, 'typeof:', typeof row.importance, 'finite?:', Number.isFinite(Number(row.importance)));
console.log('category:', row.category);

const metadata = row.metadata || {};
console.log('\n=== Metadata ===');
console.log('admissionRoute:', metadata.admissionRoute);
console.log('contextEligible:', metadata.contextEligible, 'is true?:', metadata.contextEligible === true);
console.log('memoryContainer:', metadata.memoryContainer);
console.log('semanticType:', metadata.semanticType);
console.log('valueScore:', metadata.valueScore, 'finite?:', Number.isFinite(metadata.valueScore));
console.log('importance (meta):', metadata.importance, 'matches row?:', metadata.importance === row.importance);
console.log('confidence:', metadata.confidence, 'finite?:', Number.isFinite(metadata.confidence));
console.log('sourceNodeIds:', Array.isArray(metadata.sourceNodeIds) ? metadata.sourceNodeIds.length : 'not array');

const governance = metadata.governance || {};
console.log('\n=== Governance ===');
console.log('commandType:', governance.commandType);
console.log('evidenceIds:', Array.isArray(governance.evidenceIds) ? governance.evidenceIds.length : 'not array');
console.log('evidenceIds === sourceNodeIds?:', JSON.stringify(governance.evidenceIds) === JSON.stringify(metadata.sourceNodeIds));

const native = governance.native || {};
console.log('\n=== Native ===');
console.log('kind:', native.kind);
console.log('semanticType:', native.semanticType);
console.log('category:', native.category, 'matches row?:', native.category === row.category);
console.log('dataType:', native.dataType, 'matches row?:', native.dataType === row.data_type);
console.log('container:', native.container, 'matches meta?:', native.container === undefined || native.container === metadata.memoryContainer);

const candidate = governance.candidate || {};
console.log('\n=== Candidate ===');
console.log('confidence:', candidate.confidence, candidate.confidence !== undefined ? `finite?: ${Number.isFinite(candidate.confidence)}` : '(undefined)');
if (candidate.evidence) {
  const candidateEvidence = candidate.evidence || {};
  console.log('evidence.eventIds:', Array.isArray(candidateEvidence.eventIds) ? candidateEvidence.eventIds.length : 'not array');
  console.log('evidence.eventIds === governance.evidenceIds?:', JSON.stringify(candidateEvidence.eventIds) === JSON.stringify(governance.evidenceIds));
}

console.log('\n=== Validation Summary ===');
const checks = {
  'text not empty': row.text && row.text.trim().length > 0,
  'data_type = memory': row.data_type === 'memory',
  'lifecycle_status = active': row.lifecycle_status === 'active',
  'no quarantine': row.legacy_quarantine_reason === null,
  'importance finite': Number.isFinite(row.importance),
  'admissionRoute = active': metadata.admissionRoute === 'active',
  'contextEligible = true': metadata.contextEligible === true,
  'memoryContainer valid': ['personal', 'project', 'team', 'enterprise'].includes(metadata.memoryContainer),
  'valueScore finite': Number.isFinite(metadata.valueScore),
  'importance matches': metadata.importance === row.importance,
  'confidence finite': Number.isFinite(metadata.confidence),
  'commandType valid': ['ingest', 'extract', 'backfill'].includes(governance.commandType),
  'native.kind valid': ['observation', 'insight', 'task', 'decision', 'preference', 'entity', 'relation'].includes(native.kind),
  'native.category matches': native.category === row.category,
  'native.dataType matches': native.dataType === row.data_type,
  'evidenceIds = sourceNodeIds': JSON.stringify(governance.evidenceIds) === JSON.stringify(metadata.sourceNodeIds),
  'semanticType matches': metadata.semanticType === native.semanticType,
};

for (const [check, pass] of Object.entries(checks)) {
  console.log(pass ? '✓' : '✗', check);
}

connection.release();
await pool.end();
