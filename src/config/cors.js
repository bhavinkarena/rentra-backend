import { config } from './env.js';

/**
 * CORS for a cookie-authenticated API.
 *
 * `credentials: true` is what makes the session cookie travel, and it forces
 * an exact origin echo — the spec forbids pairing it with `*`. So unknown
 * origins are rejected by name here rather than waved through.
 *
 * A request with no Origin header (server-to-server, curl, the Razorpay
 * webhook, a health check) is allowed: CORS is a browser mechanism and there
 * is no browser to protect in that case. Authorisation is still enforced by
 * the auth middleware regardless.
 */
export function corsOptions() {
  const { corsOrigins } = config();

  return {
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) return callback(null, true);
      callback(Object.assign(new Error('Origin not allowed'), { status: 403 }));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Razorpay-Signature'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  };
}
