import { readFile, readdir } from 'node:fs/promises';

const directory = new URL('../../drizzle/', import.meta.url);
const journal = JSON.parse(await readFile(new URL('meta/_journal.json', directory), 'utf8'));
const files = new Set((await readdir(directory)).filter((name) => name.endsWith('.sql')));
const seen = new Set();
let previousTime = -Infinity;
for (const [index, entry] of journal.entries.entries()) {
  if (entry.idx !== index || seen.has(entry.tag) || entry.when <= previousTime) {
    throw new Error(`Invalid migration order: ${entry.tag}`);
  }
  if (!files.delete(`${entry.tag}.sql`)) throw new Error(`Missing SQL: ${entry.tag}`);
  if (!(await readFile(new URL(`${entry.tag}.sql`, directory), 'utf8')).trim()) {
    throw new Error(`Empty migration: ${entry.tag}`);
  }
  seen.add(entry.tag);
  previousTime = entry.when;
}
if (files.size) throw new Error(`Unregistered SQL: ${[...files].join(', ')}`);
console.log(`Verified ${seen.size} migration files and journal entries (no database access).`);
