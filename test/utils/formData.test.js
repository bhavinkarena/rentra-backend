import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFormData } from '@/utils/formData.js';

/**
 * Eighty ported actions read their input with `formData.get()`. This adapter
 * is the single point where an HTTP request becomes that, so a mistake here is
 * a mistake in every action at once.
 */
test('scalars become strings, because a multipart body has nothing else', () => {
  const form = toFormData({ body: { guests: 4, agreed: true, name: 'Asha' } });

  assert.equal(form.get('guests'), '4');
  assert.equal(form.get('agreed'), 'true');
  assert.equal(form.get('name'), 'Asha');
});

test('an array becomes repeated entries, which is what getAll reads', () => {
  const form = toFormData({ body: { amenity: ['pool', 'lawn', 'bonfire'] } });
  assert.deepEqual(form.getAll('amenity'), ['pool', 'lawn', 'bonfire']);
});

test('a single value is still readable through getAll', () => {
  const form = toFormData({ body: { amenity: 'pool' } });
  assert.deepEqual(form.getAll('amenity'), ['pool']);
});

test('null and undefined are omitted, not sent as the strings "null"/"undefined"', () => {
  const form = toFormData({ body: { a: null, b: undefined, c: '' } });
  assert.equal(form.has('a'), false);
  assert.equal(form.has('b'), false);
  /** An empty string is a real answer — "the user cleared this field". */
  assert.equal(form.get('c'), '');
});

test('a nested object travels as JSON text', () => {
  const form = toFormData({ body: { selection: { from: '2026-01-01', slot: 'day' } } });
  assert.deepEqual(JSON.parse(form.get('selection')), { from: '2026-01-01', slot: 'day' });
});

test('an uploaded file arrives as a File with size and arrayBuffer', async () => {
  const form = toFormData({
    body: { docType: 'pan_card' },
    files: [
      {
        fieldname: 'front',
        originalname: 'pan.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      },
    ],
  });

  const file = form.get('front');
  assert.equal(file.name, 'pan.jpg');
  assert.equal(file.type, 'image/jpeg');
  /** The actions gate on `.size` before reading; it must be the real byte length. */
  assert.equal(file.size, 4);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
});

test('multer shapes are all understood: array, fields map, and single', () => {
  const one = {
    fieldname: 'photos',
    originalname: 'a.jpg',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('a'),
  };
  const two = {
    fieldname: 'photos',
    originalname: 'b.jpg',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('b'),
  };

  assert.equal(toFormData({ body: {}, files: [one, two] }).getAll('photos').length, 2);
  assert.equal(toFormData({ body: {}, files: { photos: [one, two] } }).getAll('photos').length, 2);
  assert.equal(toFormData({ body: {}, file: one }).getAll('photos').length, 1);
});

test('an empty request yields an empty form rather than throwing', () => {
  assert.equal([...toFormData({}).keys()].length, 0);
});
