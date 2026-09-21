import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithContext } from '@/runtime/context.js';
import { cookies, headers } from '@/runtime/next-headers.js';

/**
 * These shims stand in for `next/headers` so the ported auth code runs
 * unmodified. The unit-conversion test below is the important one: Next takes
 * maxAge in SECONDS and Express in MILLISECONDS, and getting it wrong turns a
 * 30-day session into a 30-second one — which looks like a flaky login, not a
 * bug, and would take days to track down.
 */
function fakeReq(cookieJar = {}, headerBag = {}) {
  return { cookies: cookieJar, headers: headerBag };
}

function fakeRes() {
  return {
    set: [],
    cleared: [],
    cookie(name, value, options) {
      this.set.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.cleared.push({ name, options });
    },
  };
}

test('maxAge is converted from seconds to milliseconds', async () => {
  const res = fakeRes();
  await runWithContext({ req: fakeReq(), res }, async () => {
    const jar = await cookies();
    jar.set('rentra_session', 'token', { maxAge: 2_592_000, httpOnly: true });
  });

  assert.equal(res.set[0].options.maxAge, 2_592_000_000);
  assert.equal(res.set[0].options.httpOnly, true);
});

test("get reads the incoming cookie in Next's { value } shape", async () => {
  await runWithContext({ req: fakeReq({ rentra_session: 'abc' }), res: fakeRes() }, async () => {
    const jar = await cookies();
    assert.equal(jar.get('rentra_session')?.value, 'abc');
    assert.equal(jar.get('missing'), undefined);
  });
});

test('a cookie set earlier in the request is visible to a later get', async () => {
  await runWithContext({ req: fakeReq(), res: fakeRes() }, async () => {
    const jar = await cookies();
    jar.set('rentra_customer_challenge', 'id.token', { maxAge: 300 });
    assert.equal(jar.get('rentra_customer_challenge')?.value, 'id.token');
  });
});

test('a deleted cookie reads as absent for the rest of the request', async () => {
  await runWithContext({ req: fakeReq({ rentra_session: 'abc' }), res: fakeRes() }, async () => {
    const jar = await cookies();
    jar.delete('rentra_session');
    assert.equal(jar.get('rentra_session'), undefined);
  });
});

test('headers() is case-insensitive and returns null when absent', async () => {
  await runWithContext(
    { req: fakeReq({}, { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' }), res: fakeRes() },
    async () => {
      const h = await headers();
      assert.equal(h.get('x-forwarded-for'), '203.0.113.9, 10.0.0.1');
      assert.equal(h.get('x-real-ip'), null);
    },
  );
});

test('writing a cookie outside a request fails loudly instead of silently', async () => {
  const jar = await cookies();
  assert.throws(() => jar.set('x', 'y'), /Cookies can only be written/);
});
