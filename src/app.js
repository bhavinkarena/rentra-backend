import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import { config } from './config/env.js';
import { corsOptions } from './config/cors.js';
import { requestContext } from './middlewares/requestContext.middleware.js';
import { responseEnhancer } from './middlewares/responseEnhancer.middleware.js';
import { generalLimiter } from './middlewares/rateLimit.middleware.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';
import apiRoutes from './routes/index.js';
import webhookRoutes from './routes/webhooks.route.js';
import measurementRoutes from './routes/measurement.route.js';

/**
 * Middleware order here is load-bearing. From the top:
 *
 *   1. trust proxy      — before anything reads req.ip, or the rate limiter
 *                         buckets every request under the load balancer.
 *   2. cookie-parser    — before requestContext, which exposes req.cookies to
 *                         the ported `cookies()` shim.
 *   3. requestContext   — before ANY route that touches the service layer.
 *   4. responseEnhancer — before any route, so res.success / res.error exist
 *                         even on the raw-body routes and in the error handler.
 *   5. raw-body routes  — BEFORE express.json(). Razorpay signs the exact bytes
 *                         it sent, and parsing then re-serialising breaks the
 *                         HMAC; the measurement beacon enforces its own
 *                         512-byte ceiling before anything parses the body.
 *   6. express.json()   — everything else.
 *   7. error handler    — last, and the only place that formats an error.
 *
 * Moving 5 below 6 is the subtle one: body-parser consumes the stream, so
 * `express.raw` further down would hand the controller an already-parsed
 * object and every signature check would fail at once.
 */
export function createApp() {
  const cfg = config();
  const app = express();

  app.disable('x-powered-by');
  /**
   * The exact hop count, never `true`. With `true` any caller can set
   * X-Forwarded-For and hand themselves a fresh rate-limit bucket, walking
   * straight past the OTP limiter.
   */
  app.set('trust proxy', cfg.TRUST_PROXY_HOPS);

  app.use(
    helmet({
      /** No browser renders anything from this origin; CSP belongs on the frontend. */
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  /**
   * responseEnhancer goes ABOVE cors, not below it. A rejected origin is
   * raised by the cors middleware itself, so the error handler needs
   * `res.error` to already exist — otherwise a blocked cross-origin request
   * answers 500 "res.error is not a function" instead of a clean 403.
   */
  app.use(responseEnhancer);
  app.use(cors(corsOptions()));
  app.use(compression());
  if (cfg.LOG_FORMAT !== 'off') app.use(morgan(cfg.LOG_FORMAT));

  app.use(cookieParser());
  app.use(requestContext);

  /* Raw-body routes — see the ordering note above. */
  app.use('/webhooks', webhookRoutes);
  app.use(`${cfg.API_PREFIX}/measurement`, measurementRoutes);

  app.use(express.json({ limit: cfg.REQUEST_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: cfg.REQUEST_BODY_LIMIT }));

  app.use(generalLimiter);
  app.use(cfg.API_PREFIX, apiRoutes);

  /** Unprefixed alias, so a probe does not need to know the API version. */
  app.get('/health', (_req, res) => res.success(200, { status: 'up' }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
