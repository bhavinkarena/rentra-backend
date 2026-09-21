import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler, notFoundHandler } from '@/middlewares/error.middleware.js';
import { responseEnhancer } from '@/middlewares/responseEnhancer.middleware.js';
import { AppError } from '@/utils/apiError.js';
import { RedirectSignal } from '@/runtime/signals.js';

process.env.NODE_ENV ??= 'test';

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  responseEnhancer({}, res, () => {});
  return res;
}

const req = { method: 'POST', originalUrl: '/api/v1/bookings/quote', id: 'test' };

test('an operational AppError reaches the caller verbatim', () => {
  const res = fakeRes();
  errorHandler(new AppError('Sign in to continue.', 401, { code: 'AUTH_REQUIRED' }), req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, 'Sign in to continue.');
  assert.equal(res.body.code, 'AUTH_REQUIRED');
  assert.equal(res.body.success, false);
});

test('a coded domain error maps to its documented status and product message', () => {
  const res = fakeRes();
  errorHandler(Object.assign(new Error('raw'), { code: 'DATES_UNAVAILABLE' }), req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.message, 'Those dates have just been taken.');
  assert.equal(res.body.code, 'DATES_UNAVAILABLE');
});

test('an unknown error NEVER leaks its message in production', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = fakeRes();
    errorHandler(new Error('postgres://user:hunter2@db.internal/rentra'), req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, 'INTERNAL_ERROR');
    assert.ok(!res.body.message.includes('hunter2'), 'credentials must never reach the client');
    assert.match(res.body.message, /Reference: [0-9a-f-]{36}/, 'a correlation id must be offered');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('a redirect signal is a success carrying the location, not an error', () => {
  const res = fakeRes();
  errorHandler(new RedirectSignal('/support/42'), req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.redirect, '/support/42');
});

test('an oversized body is 413, not 500', () => {
  const res = fakeRes();
  errorHandler(Object.assign(new Error('too big'), { type: 'entity.too.large' }), req, res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.code, 'BODY_TOO_LARGE');
});

test('an unmatched route is a 404 in the standard envelope', () => {
  const res = fakeRes();
  notFoundHandler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'ROUTE_NOT_FOUND');
  assert.equal(res.body.success, false);
});
