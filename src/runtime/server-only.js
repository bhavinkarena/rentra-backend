/**
 * Stand-in for the `server-only` package.
 *
 * In the Next app that import is a build-time guard: it makes the bundler
 * refuse to include the module in a client bundle. Here every module is
 * server code by definition, so the guard has nothing to protect against and
 * the import is a no-op. It stays in the source only so the ported files
 * remain identical to their Next counterparts.
 */
