/**
 * Resolution hooks that let the ported Next.js service layer run unmodified
 * under plain Node + Express.
 *
 * Two jobs:
 *
 *   1. `@/*` alias and extensionless relative imports. The service layer was
 *      written for a bundler that resolves `./session` and `@/services/db`.
 *      Node does neither, and rewriting ~100 files by hand would be a hundred
 *      chances to introduce a subtle import bug.
 *
 *   2. Framework shims. The ported code imports `next/headers`, `next/cache`,
 *      `next/navigation`, `react` and `server-only`. None of those packages
 *      are installed here — they are redirected to equivalents in src/runtime
 *      backed by an AsyncLocalStorage request context. This keeps the business
 *      logic byte-identical to the Next app, so a fix in one is a fix in both.
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../src/', import.meta.url);
const RUNTIME = new URL('../src/runtime/', import.meta.url);

/** Bare specifier -> shim module. */
const SHIMS = {
  'server-only': 'server-only.js',
  'next/headers': 'next-headers.js',
  'next/cache': 'next-cache.js',
  'next/navigation': 'next-navigation.js',
  react: 'react.js',
};

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

/**
 * Mirror the bundler's extension resolution: exact, then .js/.mjs, then
 * /index.js. Must check isFile, not mere existence — `@/services/db` matches a
 * DIRECTORY, and Node cannot import one (ERR_UNSUPPORTED_DIR_IMPORT).
 */
function withExtensions(base, root) {
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) {
    const url = new URL(candidate, root);
    if (isFile(url)) return url.href;
  }
  return null;
}

export function resolve(specifier, context, next) {
  if (Object.hasOwn(SHIMS, specifier)) {
    return next(new URL(SHIMS[specifier], RUNTIME).href, context);
  }

  if (specifier.startsWith('@/')) {
    return next(withExtensions(specifier.slice(2), ROOT) ?? specifier, context);
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (/\.[a-z]+$/i.test(specifier)) return next(specifier, context);
    const resolved = context.parentURL ? withExtensions(specifier, context.parentURL) : null;
    return next(resolved ?? specifier, context);
  }

  return next(specifier, context);
}
