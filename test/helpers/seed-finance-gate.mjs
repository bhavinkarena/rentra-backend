import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { seedFinanceFixture } from './finance-fixture.js';
const path = process.env.CP06_GATE_FIXTURE;
const f = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(f.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw Error('Disposable fixture required');
const sql = postgres(f.databaseUrl, { onnotice: () => {} });
try {
  const finance = await seedFinanceFixture(sql, f.ids);
  await writeFile(path, JSON.stringify({ ...f, finance }));
  console.log('CP22 finance fixture ready');
} finally {
  await sql.end();
}
