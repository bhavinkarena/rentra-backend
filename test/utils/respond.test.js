import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseEnhancer } from '@/middlewares/responseEnhancer.middleware.js';

/**
 * The envelope is the API's contract with every client. A field silently
 * disappearing from it is the kind of change that passes review and breaks
 * every error screen at once, so it is asserted field by field.
 */
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

test('success carries statusCode, data, message and success:true', () => {
  const res = fakeRes();
  res.success(200, { id: 'abc' }, 'Loaded');

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    statusCode: 200,
    data: { id: 'abc' },
    message: 'Loaded',
    success: true,
  });
});

test('success defaults to 200 / null data / "Success"', () => {
  const res = fakeRes();
  res.success();
  assert.deepEqual(res.body, { statusCode: 200, data: null, message: 'Success', success: true });
});

test('error carries success:false and the same four base fields', () => {
  const res = fakeRes();
  res.error(404, 'Not found.');

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.equal(res.body.statusCode, 404);
  assert.equal(res.body.message, 'Not found.');
  assert.equal(res.body.data, null);
});

test('code and errors appear only when supplied', () => {
  const plain = fakeRes();
  plain.error(500, 'Boom');
  assert.ok(!('code' in plain.body), 'code must be absent when not given');
  assert.ok(!('errors' in plain.body), 'errors must be absent when not given');

  const validation = fakeRes();
  validation.error(422, 'Check the highlighted fields.', {
    code: 'VALIDATION_FAILED',
    errors: { email: 'Enter a valid email' },
  });
  assert.equal(validation.body.code, 'VALIDATION_FAILED');
  assert.deepEqual(validation.body.errors, { email: 'Enter a valid email' });
});

test('clients branch on code, which is stable, not on message, which is not', () => {
  const res = fakeRes();
  res.error(409, 'Those dates have just been taken.', { code: 'DATES_UNAVAILABLE' });
  assert.equal(res.body.code, 'DATES_UNAVAILABLE');
});
