import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoAlt } from '../../src/services/domain/listing-content.js';

test('placeholder alts become tag + place; hand-written alts are kept', () => {
  const ctx = { title: 'Green Acres', place: 'Dumas, Surat' };
  assert.equal(
    photoAlt({ alt: 'Green Acres', tag: 'Pool' }, 0, ctx),
    'Pool at Green Acres, Dumas, Surat',
  );
  assert.equal(
    photoAlt({ alt: 'Green Acres — photo 3', tag: 'Other' }, 2, ctx),
    'Green Acres, Dumas, Surat — photo 3',
  );
  assert.equal(photoAlt({}, 1, ctx), 'Green Acres, Dumas, Surat — photo 2');
  assert.equal(
    photoAlt({ alt: 'Swimming pool at sunset', tag: 'Pool' }, 0, ctx),
    'Swimming pool at sunset',
  );
  assert.equal(photoAlt({ alt: 'Green Acres — photo 1' }, 0), 'Green Acres — photo 1');
  assert.equal(photoAlt({}, 4), 'Listing photo 5');
});
