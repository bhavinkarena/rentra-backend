import { forbidden } from '../utils/apiError.js';

export function allowedOrigins(env = process.env) {
  const configured = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return new Set(configured.map((value) => new URL(value).origin));
  return new Set(
    env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000','https://rentrafarm.vercel.app'],
  );
}
export function corsOptions(env = process.env) {
  const origins = allowedOrigins(env);
  return {
    origin(origin, callback) {
      // Server-to-server calls and signed webhooks have no browser Origin.
      if (!origin || origins.has(origin)) callback(null, true);
      else callback(forbidden('ORIGIN_DENIED', 'This origin is not allowed.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Razorpay-Signature'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  };
}
