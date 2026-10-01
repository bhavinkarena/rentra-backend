import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const fixture = JSON.parse(await readFile(process.env.GATE_DB_JSON, 'utf8'));
const url = new URL(fixture.url);
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '55432' ||
  !url.pathname.startsWith('/rentra_test_')
)
  throw new Error('Disposable local fixture required');
const child = spawn('npm', ['run', 'smoke'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: fixture.url,
    NODE_ENV: 'test',
    SESSION_SECRET: 'phase13-local-fixture-signing-secret',
    NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
    CLOUDINARY_CLOUD_NAME: 'phase13-fixture',
    CLOUDINARY_API_KEY: 'fixture',
    CLOUDINARY_API_SECRET: 'fixture',
  },
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
