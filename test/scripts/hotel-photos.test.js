import assert from 'node:assert/strict';
import test from 'node:test';
import { extractHotelGallery, sourceImageUrl } from '../../src/scripts/import-hotel-photos.js';

const source = 'https://www.makemytrip.com/hotels/test-details-mumbai.html';
function fixture() {
  return {
    requestInfo: { query: { hotelId: '123' } },
    hotelDetail: {
      staticDetail: {
        hotelDetails: { id: '123', name: 'Test Hotel' },
        hotelImageCatagory: ['Exterior', 'Room', 'Reception', 'Pool', 'Restaurant', 'Gym'].map(
          (title, n) => ({
            title,
            imageList: [
              { src: `https://r1imghtlak.mmtcdn.com/property-${n}.jpg`, mediaType: 'image' },
            ],
          }),
        ),
        hotelImageByTraveller: [{ src: 'https://r1imghtlak.mmtcdn.com/guest-selfie.jpg' }],
      },
    },
  };
}
const html = (state) => `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>`;

test('collects distinct property images with category labels and excludes traveller photos', () => {
  const state = fixture();
  state.hotelDetail.staticDetail.hotelImageCatagory.push(
    state.hotelDetail.staticDetail.hotelImageCatagory[0],
  );
  const gallery = extractHotelGallery(html(state), source);
  assert.equal(gallery.photos.length, 6);
  assert.equal(gallery.sourceHotelId, '123');
  assert.equal(gallery.photos[0].category, 'Exterior');
  assert(
    gallery.photos.every((p) => !p.sourceUrl.includes('selfie') && p.alt.endsWith('Test Hotel')),
  );
});

test('rejects mismatched hotels, missing page data, unsafe hosts and placeholders', () => {
  const state = fixture();
  state.requestInfo.query.hotelId = 'another-hotel';
  assert.throws(() => extractHotelGallery(html(state), source), /identity mismatch/);
  assert.throws(() => extractHotelGallery('200-OK', source), /state is missing/);
  for (const url of [
    'http://r1imghtlak.mmtcdn.com/photo.jpg',
    'https://localhost/photo.jpg',
    'https://r1imghtlak.mmtcdn.com.evil.example/photo.jpg',
    'https://r1imghtlak.mmtcdn.com/default.jpg',
  ]) {
    assert.throws(() => sourceImageUrl(url));
  }
  assert.equal(
    sourceImageUrl('https://r1imghtlak.mmtcdn.com/photo.jpg?downsize=100:100'),
    'https://r1imghtlak.mmtcdn.com/photo.jpg',
  );
  assert.equal(
    sourceImageUrl('https://cf.bstatic.com/photo.jpg?k=signature'),
    'https://cf.bstatic.com/photo.jpg?k=signature',
  );
  assert.equal(
    sourceImageUrl('https://ak-d.tripcdn.com/images/actual-photo_R_500_400_R5.webp'),
    'https://ak-d.tripcdn.com/images/actual-photo.jpg',
  );
});
