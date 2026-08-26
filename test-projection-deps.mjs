import { readFileSync } from 'fs';
import { createHistoryRebuildOperatorDependencies } from './dist/scripts/operator-history-rebuild.js';

console.log('Step 1: Loading dependencies...');
const deps = createHistoryRebuildOperatorDependencies();
console.log('Dependencies created successfully');

console.log('\nStep 2: Reading config...');
const configText = readFileSync(process.env.HOME + '/.mengshu/config.json', 'utf8');
console.log('Config file read successfully');

console.log('\nStep 3: Parsing config...');
let config;
try {
  config = deps.parseConfig(configText);
  console.log('Config parsed successfully');
  console.log('Config dbType:', config.dbType);
} catch (error) {
  console.error('Config parsing failed:', error.message);
  process.exit(1);
}

console.log('\nStep 4: Attempting connection...');
try {
  const connection = await deps.connect(config);
  console.log('Connection successful!');

  console.log('\nStep 5: Testing query...');
  const result = await connection.client.query('SELECT 1 AS test');
  console.log('Query result:', result.rows);

  await connection.close();
  console.log('Connection closed cleanly');
} catch (error) {
  console.error('Connection failed:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
