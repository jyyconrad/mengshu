import { readFileSync } from 'fs';
import pg from 'pg';

const configText = readFileSync(process.env.HOME + '/.mengshu/config.json', 'utf8');
const config = JSON.parse(configText);

console.log('Config loaded:', {
  dbType: config.dbType,
  host: config.postgres?.host,
  port: config.postgres?.port,
  database: config.postgres?.database,
  user: config.postgres?.user,
  ssl: config.postgres?.ssl
});

try {
  const pool = new pg.Pool({
    ...config.postgres,
    max: 1,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  console.log('Pool created, attempting connection...');
  const connection = await pool.connect();
  console.log('Connection successful!');

  const result = await connection.query('SELECT 1 AS test');
  console.log('Query result:', result.rows);

  connection.release();
  await pool.end();
  console.log('Connection closed cleanly');
} catch (error) {
  console.error('Connection failed:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
