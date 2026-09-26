import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveProfilePhoto,
  validateProfilePhoto,
  PROFILE_PHOTO_MAX_BYTES,
} from '@/services/customer/photo.js';

const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0]);
const session = {
  role: 'customer',
  userId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
};
function fixture({ active = true, version = 3 } = {}) {
  const writes = [],
    deleted = [],
    uploads = [];
  const tx = async (strings, ...values) => {
    const query = strings.join('?');
    if (query.includes('FROM "user"')) return [{ id: session.userId }];
    if (query.includes('FROM customer_session')) return active ? [{ id: session.sessionId }] : [];
    if (query.includes('SELECT photo_public_id'))
      return [{ photo_public_id: 'profile-photos/old', version }];
    if (query.startsWith('UPDATE customer_profile')) {
      writes.push(values);
      return [];
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  return {
    database: { begin: (fn) => fn(tx) },
    writes,
    deleted,
    uploads,
    storage: {
      upload: async (input) => {
        uploads.push(input);
        return { publicId: 'profile-photos/new' };
      },
      destroy: async (id) => {
        deleted.push(id);
      },
    },
  };
}

test('avatar accepts image signatures and rejects PDF, SVG, empty and oversized uploads', () => {
  assert.doesNotThrow(() => validateProfilePhoto(jpeg));
  for (const buffer of [
    Buffer.from('%PDF-1.7 example'),
    Buffer.from('<svg>not an image</svg>'),
    Buffer.alloc(0),
    Buffer.alloc(PROFILE_PHOTO_MAX_BYTES + 1),
  ]) {
    assert.throws(() => validateProfilePhoto(buffer));
  }
});

test('an invalid customer session cannot upload or change another profile', async () => {
  const f = fixture({ active: false });
  await assert.rejects(
    saveProfilePhoto(f.database, session, { buffer: jpeg, expectedVersion: 3 }, {}, f.storage),
    /log in/,
  );
  assert.equal(f.uploads.length, 0);
  assert.equal(f.writes.length, 0);
});

test('a stale version cleans up the new upload and preserves the old avatar', async () => {
  const f = fixture();
  await assert.rejects(
    saveProfilePhoto(f.database, session, { buffer: jpeg, expectedVersion: 2 }, {}, f.storage),
    /another tab/,
  );
  assert.deepEqual(f.deleted, ['profile-photos/new']);
  assert.equal(f.writes.length, 0);
});

test('replacement persists on the authenticated account before deleting the old photo', async () => {
  const f = fixture();
  const result = await saveProfilePhoto(
    f.database,
    session,
    { buffer: jpeg, expectedVersion: 3 },
    { CLOUDINARY_CLOUD_NAME: 'test-cloud' },
    f.storage,
  );
  assert.equal(result.version, 4);
  assert.match(result.photoUrl, /test-cloud\/image\/upload\/profile-photos\/new$/);
  assert.deepEqual(f.writes[0], ['profile-photos/new', session.userId]);
  assert.deepEqual(f.deleted, ['profile-photos/old']);
});

test('removing the photo restores the initial fallback without another upload', async () => {
  const f = fixture();
  const result = await saveProfilePhoto(
    f.database,
    session,
    { remove: true, expectedVersion: 3 },
    {},
    f.storage,
  );
  assert.equal(result.photoUrl, null);
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.writes[0], [null, session.userId]);
  assert.deepEqual(f.deleted, ['profile-photos/old']);
});
