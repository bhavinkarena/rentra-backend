import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correctedTimeAllowed,
  correctionChain,
  effectiveEvidence,
  incidentReference,
  incidentTimeAllowed,
} from '../../src/services/domain/visit-evidence.js';
import { EvidenceError, preparePhotos } from '../../src/services/booking/visit-evidence.js';

const png = (seed = 0) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, seed),
  ]);
const file = (buffer, name = 'photo.png', type = 'image/png') => new File([buffer], name, { type });

test('CP13 photos are sniffed from bytes, bounded and never duplicated', async () => {
  const photos = await preparePhotos([file(png(1)), file(png(2)), file(Buffer.alloc(0))]);
  assert.equal(photos.length, 2, 'empty file inputs are ignored');
  assert.ok(photos.every((p) => p.mime === 'image/png' && /^[a-f0-9]{64}$/.test(p.sha256)));
  const refused = async (files, pattern) =>
    assert.rejects(
      preparePhotos(files),
      (error) =>
        error instanceof EvidenceError && error.field === 'photos' && pattern.test(error.message),
    );
  // A GIF renamed and labelled as JPEG is still a GIF.
  await refused(
    [file(Buffer.from('GIF89a' + 'x'.repeat(20)), 'photo.jpg', 'image/jpeg')],
    /JPG, PNG or WebP/,
  );
  await refused([file(Buffer.from('%PDF-1.7' + 'x'.repeat(20)), 'photo.png')], /JPG, PNG or WebP/);
  await refused([file(png(1)), file(png(1))], /twice/);
  await refused(
    [1, 2, 3, 4].map((n) => file(png(n))),
    /up to 3/,
  );
  await refused([file(Buffer.concat([png(9), Buffer.alloc(2 * 1024 * 1024)]))], /under 2MB/);
});

test('CP13 corrections form one chain and supersede without erasing the original', () => {
  const evidence = {
    occurredAt: '2026-09-20T05:00:00.000Z',
    note: 'Original handover note with enough words.',
  };
  const first = {
    id: 'a',
    supersedesId: null,
    correctedOccurredAt: '2026-09-20T05:30:00.000Z',
    correctedNote: null,
  };
  const second = {
    id: 'b',
    supersedesId: 'a',
    correctedOccurredAt: null,
    correctedNote: 'Corrected note that explains what happened.',
  };
  const stray = {
    id: 'z',
    supersedesId: 'missing',
    correctedOccurredAt: '2026-09-20T09:00:00.000Z',
    correctedNote: null,
  };
  assert.deepEqual(
    correctionChain([second, stray, first]).map((c) => c.id),
    ['a', 'b'],
  );
  const effective = effectiveEvidence(evidence, [second, first, stray]);
  assert.equal(effective.occurredAt, first.correctedOccurredAt);
  assert.equal(effective.note, second.correctedNote);
  assert.equal(effective.headId, 'b');
  assert.equal(effective.corrected, true);
  assert.equal(evidence.note, 'Original handover note with enough words.', 'original is untouched');
  assert.deepEqual(effectiveEvidence(evidence, []), {
    ...evidence,
    corrected: false,
    headId: null,
    chain: [],
  });
});

test('CP13 corrected times stay inside the visit and keep phases ordered', () => {
  const context = {
    startsAt: '2026-09-20T03:30:00.000Z',
    now: '2026-09-21T00:00:00.000Z',
    effectiveTimes: { handover: '2026-09-20T04:00:00.000Z', complete: '2026-09-20T13:00:00.000Z' },
  };
  assert.equal(correctedTimeAllowed('return', '2026-09-20T12:00:00.000Z', context), true);
  assert.equal(
    correctedTimeAllowed('return', '2026-09-20T03:59:00.000Z', context),
    false,
    'before handover',
  );
  assert.equal(
    correctedTimeAllowed('return', '2026-09-20T13:01:00.000Z', context),
    false,
    'after completion',
  );
  assert.equal(
    correctedTimeAllowed('handover', '2026-09-20T03:00:00.000Z', context),
    false,
    'before the visit',
  );
  assert.equal(
    correctedTimeAllowed('complete', '2026-09-21T00:00:01.000Z', context),
    false,
    'future',
  );
  assert.equal(correctedTimeAllowed('unknown', '2026-09-20T12:00:00.000Z', context), false);
});

test('CP13 incidents accept arrival problems a day early but never future times', () => {
  const context = { startsAt: '2026-09-20T03:30:00.000Z', now: '2026-09-20T10:00:00.000Z' };
  assert.equal(incidentTimeAllowed('2026-09-19T03:30:00.000Z', context), true);
  assert.equal(incidentTimeAllowed('2026-09-19T03:29:59.000Z', context), false);
  assert.equal(incidentTimeAllowed('2026-09-20T10:00:01.000Z', context), false);
  assert.equal(incidentReference('0f8e9d2c-1234-4abc-8def-001122334455'), 'INC-0F8E9D2C12');
});
