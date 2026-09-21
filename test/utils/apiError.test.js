import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  unavailable,
} from '@/utils/apiError.js';

/**
 * The operational/non-operational split is the whole safety property: only an
 * AppError's message is allowed to reach a caller. If `isOperational` ever
 * stopped being set, raw Postgres and Razorpay errors would start leaking
 * connection strings and key fragments to clients.
 */
test('an AppError is operational and carries its status', () => {
  const error = new AppError('Nope', 403);
  assert.equal(error.isOperational, true);
  assert.equal(error.statusCode, 403);
  assert.equal(error.name, 'AppError');
});

test('a plain Error is NOT operational', () => {
  assert.notEqual(new Error('leak me').isOperational, true);
});

test('each helper produces its documented status', () => {
  assert.equal(badRequest().statusCode, 400);
  assert.equal(unauthorized().statusCode, 401);
  assert.equal(forbidden().statusCode, 403);
  assert.equal(notFound().statusCode, 404);
  assert.equal(conflict().statusCode, 409);
  assert.equal(unprocessable({}).statusCode, 422);
  assert.equal(unavailable().statusCode, 503);
});

test('a code is always present, derived from the status when not given', () => {
  assert.equal(new AppError('x', 404).code, 'NOT_FOUND');
  assert.equal(new AppError('x', 401).code, 'AUTH_REQUIRED');
  assert.equal(new AppError('x', 418).code, 'INTERNAL_ERROR');
});

test('badRequest takes the code first, matching the other helpers', () => {
  const error = badRequest('BAD_DATE_RANGE', 'Bad date range.');
  assert.equal(error.code, 'BAD_DATE_RANGE');
  assert.equal(error.message, 'Bad date range.');
});

test('unprocessable carries the field map a form needs', () => {
  const error = unprocessable({ email: 'Enter a valid email' });
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.deepEqual(error.fields, { email: 'Enter a valid email' });
});
