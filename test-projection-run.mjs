import { runHistoryWorkMemoryProjectionOperator } from './dist/scripts/operator-history-work-memory-projection.js';

const argv = [
  '--plan',
  '--config', process.env.HOME + '/.mengshu/config.json',
  '--manifest', process.env.HOME + '/.mengshu/migrations/2026-08-16-history-rebuild-prod-02/history-rebuild-manifest.json'
];

console.log('Running projection operator with args:', argv);

try {
  const result = await runHistoryWorkMemoryProjectionOperator(argv);
  console.log('Success:', JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Error caught:', error);
  console.error('Error code:', error.code);
  console.error('Error message:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
