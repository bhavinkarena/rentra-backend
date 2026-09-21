import './boot-check.js';

const { createApp } = await import('./app.js');
const { config } = await import('./config/env.js');
const { sql, assertDatabaseReady } = await import('./config/database.js');
const { logger } = await import('./utils/logger.js');

/**
 * Process entry point.
 *
 * The imports above are dynamic, and deliberately so: they must not be
 * resolved until `boot-check.js` has confirmed the module loader is
 * registered. A static import is hoisted and resolved before any code in
 * this file runs, so the check would never get to speak — the process would
 * die on `@/services/...` with a bare ERR_MODULE_NOT_FOUND instead. See
 * boot-check.js for why the loader is mandatory.
 *
 * `config()` runs first and deliberately throws on bad configuration: a server
 * that boots with a missing SESSION_SECRET and 500s on the first login is
 * worse than one that never starts.
 */
const cfg = config();
const app = createApp();

/**
 * Start listening only once the database answers.
 *
 * Retrying rather than exiting: in a cold start the database is routinely a
 * few seconds behind the app, and a crash loop there turns a normal deploy
 * into an incident. A genuinely unreachable database keeps logging and keeps
 * trying, which is visible without being fatal.
 */
let server;

async function start() {
  try {
    await assertDatabaseReady();
  } catch (error) {
    logger.error('database not ready; retrying in 5s', { code: error?.code });
    setTimeout(start, 5000).unref();
    return;
  }

  logger.info('database connection established');
  server = app.listen(cfg.PORT, () => {
    logger.info('listening', { port: cfg.PORT, env: cfg.NODE_ENV, prefix: cfg.API_PREFIX });
  });

  /**
   * Keep sockets alive just past a typical load balancer's 60s idle timeout.
   * Without this the balancer closes connections Node still believes are open,
   * which surfaces to clients as random EOF errors under load.
   */
  server.keepAliveTimeout = 65_000;
  /** Must exceed keepAliveTimeout, or Node closes before the next request header lands. */
  server.headersTimeout = 66_000;
}

start();

/**
 * Graceful shutdown.
 *
 * In-flight requests are allowed to finish before the database pool closes —
 * otherwise a deploy lands mid-checkout and a guest sees a payment fail for a
 * reason that has nothing to do with their card. The 10s timer is the backstop
 * for a connection that will not drain.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const force = setTimeout(() => {
    logger.warn('forced exit; connections did not drain');
    process.exit(1);
  }, 10_000).unref();

  if (!server) {
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  }

  server.close(async () => {
    clearTimeout(force);
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* Closing a pool that is already gone is not worth failing the exit over. */
    }
    logger.info('stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * An unhandled rejection means some promise chain lost its error. Log and keep
 * serving — killing the process would turn one dropped error into an outage
 * for every request in flight.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { name: reason?.name, code: reason?.code });
});

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', { name: error?.name, message: error?.message });
  shutdown('uncaughtException');
});
