/**
 * Accept every request origin and echo it so cookie credentials still work.
 * A literal wildcard origin cannot be used with credentialed browser requests.
 */
export function corsOptions() {
  return {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Razorpay-Signature'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  };
}
