import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit does not read .env the way `node --env-file` does, so `studio`
 * and `generate` would see DATABASE_URL as undefined. Load it here, once.
 */
for (const file of ['.env', '.env.local']) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
}

export default defineConfig({
  dialect: 'postgresql',
  /**
   * The schema is the ported one, shared verbatim with the Next frontend. The
   * backend owns migrations now — see docs/MIGRATION.md — so this is the only
   * drizzle.config in the system that should be generating them.
   */
  schema: './src/services/db/schema/index.js',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL },
  /** PostGIS lives in its own schema; drizzle-kit must not try to manage it. */
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
