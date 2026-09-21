/**
 * Make sure the module loader is active, registering it if it is not.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * src/ is the Next.js service layer moved across intact. It still imports
 * `@/services/...`, extensionless relative paths, and five framework modules
 * — `next/headers`, `next/cache`, `next/navigation`, `react`, `server-only`
 * — that are NOT installed as packages. loader/hooks.mjs resolves the first
 * two and redirects the last five to the shims in src/runtime. So the loader
 * is a hard requirement: without it the process dies on its first import with
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/services'
 *
 * which says nothing about the actual mistake.
 *
 * WHY IT REGISTERS RATHER THAN JUST COMPLAINING.
 *
 * The loader is normally supplied by `node --import ./loader/register.mjs`,
 * and every script in package.json passes it. But a deployment platform's
 * start command is a setting, and `node src/index.js` is the obvious thing to
 * put there — so the flag goes missing in exactly the environment where a
 * crash costs the most. Rather than depend on that setting being right,
 * this registers the hooks itself when they are absent.
 *
 * `register()` applies to modules imported AFTER it runs, which is why the
 * entry modules import this one statically and everything else dynamically.
 * A static `@/…` import in an entry file would be resolved before this code
 * executes, and would fail no matter what this does.
 *
 * Registration is idempotent in effect: when the `--import` flag already
 * supplied the hooks, the probe below succeeds and nothing further happens,
 * so the hooks are never installed twice.
 */
import { register } from 'node:module';

/**
 * `server-only` is the cheapest probe: no such package is installed, so it
 * resolves if and only if the loader's shim table is already active.
 */
function loaderIsActive() {
  try {
    import.meta.resolve('server-only');
    return true;
  } catch {
    return false;
  }
}

if (!loaderIsActive()) {
  try {
    register('../loader/hooks.mjs', import.meta.url);
  } catch (error) {
    fail(`Registering the module loader failed: ${error?.message ?? error}`);
  }

  /**
   * Confirm it took effect. If the hooks registered but still cannot resolve
   * a shimmed module, the loader files are missing or damaged — that is a
   * broken deploy, not a misconfigured command, and it needs saying plainly
   * rather than surfacing later as a confusing resolution error.
   */
  if (!loaderIsActive()) {
    fail('The module loader registered but is not resolving shimmed modules.');
  }
}

function fail(reason) {
  process.stderr.write(
    [
      '',
      'Rentra API: cannot start — the module loader is unavailable.',
      '',
      `  ${reason}`,
      '',
      'The service layer imports `@/…` aliases and the framework modules',
      '`next/headers`, `next/cache`, `next/navigation`, `react` and',
      '`server-only`, none of which are installed packages. loader/hooks.mjs',
      'is what resolves them, so nothing can load without it.',
      '',
      'Check that loader/hooks.mjs and loader/register.mjs were deployed, then',
      'start with `npm start`, which supplies the loader up front.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
