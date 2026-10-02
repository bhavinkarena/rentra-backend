import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContent,
  publicContent,
  contentCommand,
} from '../../src/services/content/service.js';
import { policyVersions, POLICY_VERSION } from '../../src/services/domain/help.js';
import { canAccessRoute } from '../../src/services/auth/capabilities.js';
const emptyDatabase = async () => [];
test('CP25 original published policies remain exact and unrecognized versions fail closed', async () => {
  for (const [version, policies] of Object.entries(policyVersions))
    for (const [kind, body] of Object.entries(policies)) {
      const p = await publicContent(emptyDatabase, kind, version);
      assert.deepEqual(p.body, body);
      assert.equal(p.version, version);
      assert.match(p.contentHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(validateContent(kind, body), body);
    }
  assert.equal((await publicContent(emptyDatabase, 'terms')).version, POLICY_VERSION);
  await assert.rejects(publicContent(emptyDatabase, 'constructor'), { statusCode: 404 });
  await assert.rejects(publicContent(emptyDatabase, 'terms', '2026-09-99'), { statusCode: 404 });
  await assert.rejects(publicContent(emptyDatabase, 'terms', '0'.repeat(32)), { statusCode: 404 });
});
test('CP25 plain text, safe destinations, bounded sections and verified-channel syntax', () => {
  const policy = { title: 'Terms', sections: [['Heading', 'Useful text']] };
  for (const title of [
    '<script>x</script>',
    '<img src=x onerror=alert(1)>',
    '\u0000bad',
    '',
    'a'.repeat(161),
  ])
    assert.throws(() => validateContent('terms', { ...policy, title }), {
      code: 'INVALID_CONTENT',
    });
  assert.throws(() => validateContent('terms', { ...policy, sections: [] }), {
    code: 'INVALID_CONTENT',
  });
  assert.throws(() => validateContent('terms', { ...policy, arbitraryHtml: 'x' }), {
    code: 'INVALID_CONTENT',
  });
  const faq = {
    question: 'Where?',
    answer: 'Read your booking',
    href: '/bookings',
    link: 'Bookings',
  };
  const help = { title: 'Help', intro: 'Useful answers', faqs: [faq] };
  assert.deepEqual(validateContent('help', help), help);
  for (const href of [
    'javascript:alert(1)',
    '//example.com',
    'https://example.com',
    '/admin',
    '/\\evil',
    '/support?redirect=https://evil',
    '/support%0aevil',
  ])
    assert.throws(() => validateContent('help', { ...help, faqs: [{ ...faq, href }] }), {
      code: 'INVALID_CONTENT',
    });
  assert.throws(() => validateContent('help', { ...help, faqs: [{ ...faq, link: '' }] }), {
    code: 'INVALID_CONTENT',
  });
  const contact = {
    title: 'Contact',
    email: 'support@example.com',
    whatsapp: '919000000000',
    hours: 'Monday 09:00–17:00',
    timeZone: 'Asia/Kolkata',
  };
  assert.deepEqual(validateContent('contact', contact), contact);
  assert.equal(
    validateContent('contact', { ...contact, phone: '+919000000000' }).phone,
    '+919000000000',
  );
  for (const patch of [
    { email: 'bad\r\nBcc:evil@example.com' },
    { email: '<bad>@example.com' },
    { whatsapp: '+91abcd' },
    { phone: 'javascript:alert(1)' },
    { hours: '<script>x</script>' },
    { timeZone: 'UTC' },
  ])
    assert.throws(() => validateContent('contact', { ...contact, ...patch }), {
      code: 'INVALID_CONTENT',
    });
  assert.equal(
    validateContent('contact', { ...contact, email: '', whatsapp: '', hours: '' }).email,
    '',
  );
});
test('CP25 content capabilities separate read, write and inactive accounts', () => {
  const reader = { isActive: true, permissions: ['admin.content.read'] };
  assert(canAccessRoute(reader, 'admin', 'GET', '/content/terms'));
  assert(!canAccessRoute(reader, 'admin', 'POST', '/content/terms'));
  assert(!canAccessRoute({ ...reader, isActive: false }, 'admin', 'GET', '/content'));
  assert(!canAccessRoute(reader, 'client', 'GET', '/content'));
});
test('CP25 invalid commands cannot reach the database and public outages do not silently return old copy', async () => {
  const database = {
    begin() {
      throw new Error('unexpected database call');
    },
  };
  await assert.rejects(
    contentCommand(database, null, 'terms', {
      command: 'delete',
      version: 0,
      reason: 'Invalid destructive command',
    }),
    { code: 'INVALID_CONTENT' },
  );
  await assert.rejects(
    contentCommand(database, null, 'terms', {
      command: 'save',
      version: -1,
      reason: 'Invalid revision',
    }),
    { code: 'INVALID_CONTENT' },
  );
  const outage = new Error('fixture outage');
  await assert.rejects(
    publicContent(async () => {
      throw outage;
    }, 'terms'),
    (error) => error === outage,
  );
});
