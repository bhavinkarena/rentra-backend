/**
 * Refuse to start without the module loader, and say why.
 *
 * src/ is the Next.js service layer moved across intact. It still imports
 * `@/services/...`, extensionless relative paths, and five framework modules
 * — `next/headers`, `next/cache`, `next/navigation`, `react`, `server-only`
 * — that are NOT installed as packages. loader/hooks.mjs resolves the first
 * two and redirects the last five to the shims in src/runtime.
 *
 * So the loader is a requirement, not a convenience. Started without it, the
 * process dies on the first import with:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/services'
 *
 * which says nothing about the actual mistake. This turns that into an
 * instruction. It exists because a platform's start command is a setting
 * someone can change, and `node src/index.js` looks like the obvious thing
 * to put there.
 *
 * Imported for its side effect only, and it must be the FIRST import in the
 * entry module — everything after it has to be a dynamic import, or the
 * static imports resolve before this runs and the message never appears.
 */

/**
 * `server-only` is the cheapest probe: no such package is installed, so it
 * resolves if and only if the loader's shim table is active.
 */
function loaderIsRegistered() {
  try {
    import.meta.resolve('server-only');
    return true;
  } catch {
    return false;
  }
}

if (!loaderIsRegistered()) {
  process.stderr.write(
    [
      '',
      'Rentra API: refusing to start — the module loader is not registered.',
      '',
      'This process was started without `--import ./loader/register.mjs`.',
      'The service layer imports `@/…` aliases and the framework modules',
      '`next/headers`, `next/cache`, `next/navigation`, `react` and',
      '`server-only`, none of which are installed packages — the loader in',
      'loader/hooks.mjs is what resolves them. Without it nothing resolves.',
      '',
      'Start it with:',
      '',
      '    npm start                                           (the web service)',
      '    node --import ./loader/register.mjs src/cron/index.js   (the worker)',
      '',
      'If a host is configured to run `node src/index.js`, change that',
      'setting to `npm start`. See render.yaml.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
