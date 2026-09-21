import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validate } from '@/middlewares/validate.middleware.js';

/**
 * Edge validation rejects malformed requests before they reach a database
 * connection. It is NOT the business rule check — the actions re-validate
 * everything they use, because they are also reachable from the worker and the
 * scripts. What is asserted here is that it fails cleanly and never mangles a
 * multipart body on its way through.
 */
function run(middleware, req) {
  return new Promise((resolve) => middleware(req, {}, (error) => resolve({ req, error })));
}

test('a valid request passes and exposes the coerced values', async () => {
  const middleware = validate({ query: z.object({ page: z.coerce.number().int().min(1) }) });
  const { error, req } = await run(middleware, { query: { page: '3' } });

  assert.equal(error, undefined);
  assert.equal(req.valid.query.page, 3);
});

test('an invalid body is a 422 carrying a field map', async () => {
  const middleware = validate({ body: z.object({ email: z.string().email() }) });
  const { error } = await run(middleware, { body: { email: 'nope' } });

  assert.equal(error.statusCode, 422);
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.ok(error.fields.email, 'the offending field must be named');
});

test('an invalid param is a 400, not a 422 — there is no field to highlight', async () => {
  const middleware = validate({ params: z.object({ id: z.string().uuid() }) });
  const { error } = await run(middleware, { params: { id: 'not-a-uuid' } });

  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'INVALID_REQUEST');
});

test('a multipart body is left intact, so the uploads survive', async () => {
  const middleware = validate({ body: z.object({ docType: z.string() }).passthrough() });
  const original = { docType: 'pan_card' };
  const { req } = await run(middleware, { body: original, files: [{ fieldname: 'front' }] });

  /**
   * Replacing req.body here would drop the parsed-away fields that toFormData
   * still needs to pair with the files.
   */
  assert.equal(req.body, original);
});

test('a JSON body IS replaced by the coerced value', async () => {
  const middleware = validate({ body: z.object({ guests: z.coerce.number() }) });
  const { req } = await run(middleware, { body: { guests: '4' } });
  assert.equal(req.body.guests, 4);
});
