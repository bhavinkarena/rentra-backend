import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Every API response, success or failure, must carry the same four fields.
 * Clients are written against that shape, so a route answering differently is
 * a breaking change no type checker here would catch.
 */
let server;
let base;

before(async () => {
  const { createApp } = await import('@/app.js');
  const { config } = await import('@/config/env.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}${config().API_PREFIX}`;
});

after(async () => {
  server?.close();
  const { sql } = await import('@/config/database.js');
  await sql.end({ timeout: 5 }).catch(() => {});
});

function assertEnvelope(body) {
  assert.equal(typeof body.statusCode, 'number', 'statusCode');
  assert.equal(typeof body.success, 'boolean', 'success');
  assert.equal(typeof body.message, 'string', 'message');
  assert.ok('data' in body, 'data');
}

test('a success carries the envelope with success:true', async () => {
  const response = await fetch(`${base}/health/live`);
  const body = await response.json();

  assertEnvelope(body);
  assert.equal(body.success, true);
  assert.equal(body.statusCode, response.status);
});

test('an unmatched route carries the envelope with success:false and a code', async () => {
  const response = await fetch(`${base}/no-such-route`);
  const body = await response.json();

  assertEnvelope(body);
  assert.equal(response.status, 404);
  assert.equal(body.success, false);
  assert.equal(body.code, 'ROUTE_NOT_FOUND');
});

test('an unauthenticated protected route is 401 with a stable code', async () => {
  const response = await fetch(`${base}/partner/application`);
  const body = await response.json();

  assertEnvelope(body);
  assert.equal(response.status, 401);
  assert.equal(body.code, 'CLIENT_REQUIRED');
});

test('an admin route never accepts the absence of an admin cookie', async () => {
  const response = await fetch(`${base}/admin/applications`);
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.code, 'ADMIN_REQUIRED');
});

test('a malformed path parameter is a 400 naming the parameter', async () => {
  const response = await fetch(`${base}/discovery/listings/!!`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_REQUEST');
  assert.ok(body.errors, 'the offending parameter must be named');
});

test('malformed JSON is a 400, not a 500', async () => {
  const response = await fetch(`${base}/bookings/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'MALFORMED_JSON');
});

test('CORS echoes an allowed origin and refuses an unknown one', async () => {
  const allowed = await fetch(`${base}/health/live`, {
    headers: { Origin: 'http://localhost:3000' },
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

  const denied = await fetch(`${base}/health/live`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'ORIGIN_NOT_ALLOWED');
});
