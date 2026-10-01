import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { inspectEntertainmentRelease } from '../services/operations/entertainment-release.js';

const stage = process.argv[2] || 'expand';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const migrations = readMigrationFiles({
  migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
});
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  connect_timeout: 10,
});
try {
  const report = await inspectEntertainmentRelease(sql, migrations, stage);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
} finally {
  await sql.end();
}
