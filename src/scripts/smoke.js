import { createApp } from '@/app.js';
import { sql } from '@/config/database.js';
import { config } from '@/config/env.js';

/**
 * Boot the app on an ephemeral port and exercise the routes that must work
 * before anything else can: health, a public read, and the auth envelope.
 *
 * Deliberately not a substitute for the test suite — it is the check you run
 * against a real database after a deploy or a config change, to confirm this
 * process can reach Postgres and answer in the agreed shape.
 */
const app = createApp();
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}${config().API_PREFIX}`;

let failures = 0;

await check('health/live', `${base}/health/live`, 200);
await check('health/ready', `${base}/health/ready`, 200);
await check('auth/me (signed out)', `${base}/auth/me`, 200);
await check('public cities', `${base}/discovery/cities`, 200);
await check('unknown route', `${base}/nope`, 404);
await check('protected route rejects', `${base}/partner/application`, 401);

server.close();
await sql.end({ timeout: 5 });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

async function check(label, url, expected) {
  let response;
  let body;
  try {
    response = await fetch(url);
    body = await response.json();
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} — ${error.message}`);
    return;
  }

  /** Every response must carry the envelope, including the failures. */
  const shaped =
    typeof body?.success === 'boolean' &&
    typeof body?.statusCode === 'number' &&
    'data' in body &&
    typeof body?.message === 'string';

  const pass = response.status === expected && shaped;
  if (!pass) failures += 1;

  console.log(
    `${pass ? 'ok  ' : 'FAIL'}  ${label} — ${response.status} (expected ${expected})` +
      (shaped ? '' : ' — envelope missing required fields'),
  );
}
