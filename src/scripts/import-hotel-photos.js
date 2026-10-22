import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';
import postgres from 'postgres';
import { seedDatabaseUrl } from './seed-guard.js';
import { slugifyHotel, validateHotelCatalog } from './import-hotel-catalog.js';
import { normalizePublicPhotos } from '../services/domain/listing-content.js';

const catalogPath = new URL('./data/india-hotel-catalog.json', import.meta.url);
const sourcesPath = new URL('./data/hotel-photo-sources.json', import.meta.url);
const cache = join(tmpdir(), 'rentra-real-hotel-photos');
let saveQueue = Promise.resolve();
const save = (path, value) => {
  const text = JSON.stringify(value, null, 2) + '\n';
  saveQueue = saveQueue.then(() => writeFile(path, text));
  return saveQueue;
};
const IMAGE_DOMAINS = [
  'mmtcdn.com',
  'ibcdn.com',
  'radissonhotels.net',
  'trvl-media.com',
  'marriott.com',
  'bstatic.com',
  'hyatt.com',
  'agoda.net',
  'easemytrip.com',
  'hrsstatic.com',
  'simplotel.com',
  'lemontreehotels.com',
  'ihg.com',
  'ahstatic.com',
  'itchotels.com',
  'theleela.com',
  'sanity.io',
  'theparkhotels.com',
  'fortunehotels.in',
  'royalorchidhotels.com',
  'saharastar.com',
  'orchidhotel.com',
  'ohotelsindia.com',
  'tridenthotels.com',
  'hilton.com',
  'wyndhamhotels.com',
  'zonebythepark.com',
  'hotelavasa.com',
  'hotelparkplaza.in',
  'r9cdn.net',
  'tripadvisor.com',
  'tripcdn.com',
  'cdrst.com',
  'yatra.com',
  'cloudfront.net',
  'spalba.com',
  'flixcart.com',
  'weddingwire.in',
  'wedmegood.com',
  'luxuryescapes.com',
  'skyscnr.com',
  'staticontent.com',
  'vfmleonardo.com',
  'happyeasygo.com',
  'travelapi.com',
];
const imageHost = (host) =>
  IMAGE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

export function sourceImageUrl(value) {
  const url = new URL(value.startsWith('//') ? `https:${value}` : value);
  assert(
    url.protocol === 'https:' && imageHost(url.hostname) && !url.username && !url.password,
    'Unexpected image host',
  );
  assert(
    !/default|placeholder|sprite|logo|icon/i.test(url.pathname),
    'Placeholder or branding image',
  );
  if (/\.(?:mmtcdn|ibcdn)\.com$/.test(url.hostname)) url.search = '';
  if (url.hostname.endsWith('.tripcdn.com'))
    url.pathname = url.pathname.replace(/_R_[^/]+\.(?:webp|jpg|png)$/i, '.jpg');
  url.hash = '';
  return url.href;
}

export function extractHotelGallery(html, sourceUrl) {
  assert.equal(new URL(sourceUrl).hostname, 'www.makemytrip.com');
  const encoded = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/)?.[1];
  assert(encoded, 'Hotel page state is missing');
  const state = JSON.parse(encoded.trim().replace(/;\s*$/, ''));
  const detail = state.hotelDetail?.staticDetail;
  assert(detail?.hotelDetails?.id && detail.hotelDetails.name, 'Hotel identity is missing');
  assert.equal(
    String(state.requestInfo?.query?.hotelId),
    String(detail.hotelDetails.id),
    'Hotel gallery identity mismatch',
  );
  // These categories are property images; never read hotelImageByTraveller or recommendations.
  const categories = (detail.hotelImageCatagory ?? []).filter((c) => Array.isArray(c.imageList));
  const rank = (title) => {
    const keys = [
      /facade|exterior|entrance/i,
      /^room$/i,
      /reception|lobby/i,
      /pool/i,
      /restaurant|dining/i,
      /gym/i,
    ];
    const n = keys.findIndex((p) => p.test(title));
    return n < 0 ? 20 : n;
  };
  categories.sort((a, b) => rank(a.title) - rank(b.title));
  const photos = [];
  const seen = new Set();
  for (let round = 0; round < 5; round++) {
    for (const category of categories) {
      const image = category.imageList[round];
      if (!image || image.mediaType !== 'image') continue;
      let url;
      try {
        url = sourceImageUrl(image.src);
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      photos.push({
        sourceUrl: url,
        category: category.title,
        alt: `${category.title} at ${detail.hotelDetails.name}`,
      });
    }
    if (photos.length >= 24) break;
  }
  assert(photos.length >= 6, `Insufficient property gallery: ${detail.hotelDetails.name}`);
  return {
    sourceUrl,
    sourceHotelId: String(detail.hotelDetails.id),
    sourceHotelName: detail.hotelDetails.name,
    photos: photos.slice(0, 30),
  };
}

async function fetchChecked(url, images = false) {
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url);
    assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password);
    assert(images ? imageHost(parsed.hostname) : parsed.hostname === 'www.makemytrip.com');
    const response = await fetch(url, {
      headers: { Accept: images ? 'image/jpeg,image/png,image/webp' : 'text/html' },
      signal: AbortSignal.timeout(30000),
    });
    assert(
      images ? imageHost(new URL(response.url).hostname) : response.url === url,
      'Unexpected source redirect',
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    assert(response.ok, `HTTP ${response.status}: ${parsed.hostname}`);
    const type = response.headers.get('content-type') ?? '';
    assert(
      images ? /^image\/(jpe?g|png|webp)/i.test(type) : /text\/html/i.test(type),
      `Unexpected content type: ${type}`,
    );
    const limit = images ? 15_000_000 : 10_000_000;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) {
        await response.body.cancel().catch(() => {});
        throw new Error('Source exceeds size limit');
      }
      chunks.push(chunk);
    }
    assert(size > (images ? 5000 : 1000), 'Source is too small');
    return Buffer.concat(chunks);
  }
  throw new Error('Too many redirects');
}

async function collect(data) {
  let sources = [];
  try {
    sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const city of data.cities) {
    for (const hotel of city.hotels) {
      if (sources.some((s) => s.sourceUrl === hotel.sourceUrl)) continue;
      let html;
      try {
        html = (await fetchChecked(hotel.sourceUrl)).toString('utf8');
      } catch (error) {
        console.error(`[photos] ${hotel.name}: ${error.message}`);
        continue;
      }
      const gallery = extractHotelGallery(html, hotel.sourceUrl);
      // The page URL and its requested hotel ID bind the gallery to this catalogue entry.
      sources.push({
        ...gallery,
        catalogName: hotel.name,
        city: city.name,
        retrievedOn: data.researchedOn,
      });
      await save(sourcesPath, sources);
    }
    await save(sourcesPath, sources);
    console.log(
      `[photos] ${city.name}: ${sources.filter((s) => s.city === city.name).length}/8 galleries`,
    );
  }
  assert.equal(
    sources.length,
    72,
    'Some galleries failed; rerun --collect to retry only missing properties',
  );
}

async function upload(data) {
  for (const key of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'])
    assert(process.env[key], `${key} is required`);
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  await mkdir(cache, { recursive: true });
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const exclusions = JSON.parse(
    await readFile(new URL('./data/hotel-photo-exclusions.json', import.meta.url), 'utf8'),
  );
  const excludedHashes = new Set(exclusions.map((p) => p.sha256));
  const excludedUrls = new Set(exclusions.map((p) => p.sourceUrl));
  for (const city of data.cities)
    for (const hotel of city.hotels) {
      if (hotel.photos) hotel.photos = hotel.photos.filter((p) => !excludedHashes.has(p.sha256));
    }
  await save(catalogPath, data);
  const hashes = new Map();
  const perceptualHashes = [];
  for (const city of data.cities)
    for (const hotel of city.hotels)
      for (const p of hotel.photos ?? []) {
        hashes.set(p.sha256, hotel.sourceUrl);
        if (p.perceptualHash) perceptualHashes.push(p.perceptualHash);
      }
  const failures = [];
  for (const city of data.cities) {
    for (let start = 0; start < city.hotels.length; start += 3) {
      await Promise.all(
        city.hotels.slice(start, start + 3).map(async (hotel) => {
          if (hotel.photos?.length === 6) return;
          const source = sources.find((s) => s.sourceUrl === hotel.sourceUrl);
          assert(source, `No gallery: ${hotel.name}`);
          hotel.photos ??= [];
          const candidates = source.photos.filter((p) => {
            try {
              sourceImageUrl(p.sourceUrl);
            } catch {
              return false;
            }
            const identity = `${p.sourcePageUrl} ${p.searchCaption ?? ''}`.toLowerCase();
            if (hotel.name === 'Hyatt Pune' && /regency|pnqhr/.test(identity)) return false;
            if (hotel.name === 'Hyatt Ahmedabad' && /regency/.test(identity)) return false;
            if (hotel.name === 'Ramada by Wyndham Jaipur' && /north|jaisinghpura/.test(identity))
              return false;
            if (
              hotel.name === 'Hotel Royal Orchid Bangalore' &&
              /orchid.central|orchid-central/.test(identity)
            )
              return false;
            return !/unsplash|unlawful|business traveler|portrait|selfie/.test(identity);
          });
          const roomPhotos = candidates.filter((p) =>
            /room|suite|bedroom/i.test(p.searchCaption ?? p.category),
          );
          const otherPhotos = candidates.filter((p) => !roomPhotos.includes(p));
          const ordered = [];
          for (let i = 0; i < Math.max(roomPhotos.length, otherPhotos.length); i++) {
            if (otherPhotos[i]) ordered.push(otherPhotos[i]);
            if (roomPhotos[i]) ordered.push(roomPhotos[i]);
          }
          const attempted = new Set();
          for (const candidate of ordered) {
            if (hotel.photos.length === 6) break;
            if (hotel.photos.some((p) => p.sourceUrl === candidate.sourceUrl)) continue;
            try {
              const sourceUrl = sourceImageUrl(candidate.sourceUrl);
              const imageKey = new URL(sourceUrl).origin + new URL(sourceUrl).pathname;
              if (attempted.has(imageKey)) continue;
              attempted.add(imageKey);
              const bytes = await fetchChecked(sourceUrl, true);
              const hash = createHash('sha256').update(bytes).digest('hex');
              if (
                hashes.has(hash) ||
                excludedHashes.has(hash) ||
                excludedUrls.has(candidate.sourceUrl)
              )
                continue;
              const publicId = `rentra/hotel-catalog/${city.slug}/${slugifyHotel(hotel.name)}/${hash.slice(0, 20)}`;
              const asset = await new Promise((resolve, reject) => {
                cloudinary.uploader
                  .upload_stream(
                    {
                      public_id: publicId,
                      resource_type: 'image',
                      type: 'upload',
                      overwrite: false,
                      transformation: [
                        { width: 1600, height: 1200, crop: 'limit', flags: 'strip_profile' },
                      ],
                      tags: ['rentra-hotel-catalog', city.slug],
                      phash: true,
                    },
                    (error, result) => (error ? reject(new Error(error.message)) : resolve(result)),
                  )
                  .end(bytes);
              });
              assert(asset.width >= 600 && asset.height >= 350, 'Photo resolution is too small');
              assert.equal(new URL(asset.secure_url).hostname, 'res.cloudinary.com');
              const phash = asset.phash;
              if (
                phash &&
                perceptualHashes.some((previous) => {
                  let bits = BigInt(`0x${phash}`) ^ BigInt(`0x${previous}`);
                  let distance = 0;
                  while (bits) {
                    distance++;
                    bits &= bits - 1n;
                  }
                  return distance < 12;
                })
              )
                continue;
              const photo = {
                url: asset.secure_url,
                alt: candidate.alt,
                width: asset.width,
                height: asset.height,
                category: candidate.category,
                sourceUrl: candidate.sourceUrl,
                sourcePageUrl: candidate.sourcePageUrl ?? hotel.sourceUrl,
                sourceHotelId: source.sourceHotelId,
                sha256: hash,
                perceptualHash: phash,
                publicId: asset.public_id,
                usageRights: 'unconfirmed',
              };
              hotel.photos.push(photo);
              hashes.set(hash, hotel.sourceUrl);
              if (phash) perceptualHashes.push(phash);
              await writeFile(join(cache, `${hash}.jpg`), bytes);
              await save(catalogPath, data);
            } catch (error) {
              console.error(`[photos] ${hotel.name}: ${error.message}`);
            }
          }
          if (hotel.photos.length === 6) console.log(`[photos] uploaded 6: ${hotel.name}`);
          else {
            failures.push(hotel.name);
            console.error(`[photos] incomplete ${hotel.photos.length}/6: ${hotel.name}`);
          }
        }),
      );
    }
  }
  assert.equal(failures.length, 0, `Retry missing photos: ${failures.join(', ')}`);
}

export function validateHotelPhotos(data) {
  validateHotelCatalog(data);
  const seen = new Set();
  for (const city of data.cities)
    for (const hotel of city.hotels) {
      assert.equal(hotel.photos?.length, 6, `Six photos required: ${hotel.name}`);
      assert.equal(
        normalizePublicPhotos(hotel.photos).length,
        6,
        'Photos must render through the public photo normalizer',
      );
      for (const photo of hotel.photos) {
        assert.equal(new URL(photo.url).hostname, 'res.cloudinary.com');
        assert.equal(new URL(photo.sourcePageUrl).protocol, 'https:');
        sourceImageUrl(photo.sourceUrl);
        assert.match(photo.sha256, /^[a-f0-9]{64}$/);
        assert(!seen.has(photo.sha256), 'Repeated image bytes');
        seen.add(photo.sha256);
        assert(photo.width >= 600 && photo.height >= 350 && photo.alt);
      }
    }
  return { hotels: 72, photos: seen.size };
}

async function apply(data) {
  const totals = validateHotelPhotos(data);
  const sql = postgres(seedDatabaseUrl('import-hotel-photos'), {
    prepare: false,
    max: 1,
    connect_timeout: 15,
  });
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('rentra-hotel-catalog-import'))`;
      const rows =
        await tx`SELECT r.id,r.photos,r.status,hp.policies FROM rentable r JOIN hotel_profile hp ON hp.rentable_id=r.id
        WHERE hp.policies->'externalCatalog'->>'batch'=${data.batch} FOR UPDATE OF r,hp`;
      assert.equal(rows.length, 72);
      const updates = data.cities.flatMap((city) =>
        city.hotels.map((hotel) => {
          const row = rows.find((r) => r.policies.externalCatalog.sourceUrl === hotel.sourceUrl);
          assert(row?.status === 'draft', `Expected imported draft: ${hotel.name}`);
          assert(
            !row.photos.length ||
              JSON.stringify(row.photos.map((p) => p.url)) ===
                JSON.stringify(hotel.photos.map((p) => p.url)),
            `Preserving existing photos: ${hotel.name}`,
          );
          const catalog = row.policies.externalCatalog;
          return {
            id: row.id,
            photos: hotel.photos,
            policies: {
              ...row.policies,
              externalCatalog: {
                ...catalog,
                photoSource: 'Property-specific official galleries and booking pages',
                photoUsageRights: 'unconfirmed',
                photoCount: 6,
                unverifiedFields: [
                  ...new Set([
                    ...(catalog.unverifiedFields ?? []).filter((field) => field !== 'photos'),
                    'photoUsageRights',
                  ]),
                ],
              },
            },
          };
        }),
      );
      await tx`UPDATE rentable r SET photos=x.photos,updated_at=now()
        FROM jsonb_to_recordset(${tx.json(updates)}::jsonb) AS x(id uuid,photos jsonb)
        WHERE r.id=x.id AND r.photos IS DISTINCT FROM x.photos`;
      await tx`UPDATE hotel_profile hp SET policies=x.policies,updated_at=now()
        FROM jsonb_to_recordset(${tx.json(updates)}::jsonb) AS x(id uuid,policies jsonb)
        WHERE hp.rentable_id=x.id AND hp.policies IS DISTINCT FROM x.policies`;
      const [check] =
        await tx`SELECT count(*)::int AS hotels, sum(jsonb_array_length(r.photos))::int AS photos
        FROM rentable r JOIN hotel_profile hp ON hp.rentable_id=r.id
        WHERE hp.policies->'externalCatalog'->>'batch'=${data.batch} AND r.status='draft' AND jsonb_array_length(r.photos)=6`;
      assert.deepEqual(check, totals);
    });
    console.log(JSON.stringify({ applied: true, ...totals }));
  } finally {
    await sql.end();
  }
}

async function checkUrls(data) {
  const totals = validateHotelPhotos(data);
  const photos = data.cities.flatMap((city) => city.hotels.flatMap((hotel) => hotel.photos));
  for (let start = 0; start < photos.length; start += 12) {
    await Promise.all(
      photos.slice(start, start + 12).map(async (photo) => {
        const response = await fetch(photo.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(20000),
        });
        assert(
          response.ok && /^image\//.test(response.headers.get('content-type') ?? ''),
          `Image unavailable: ${photo.url}`,
        );
      }),
    );
  }
  console.log({ reachableImages: totals.photos });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv[2];
  assert(
    ['--collect', '--upload', '--validate', '--check-urls', '--apply'].includes(flag),
    'Choose --collect, --upload, --validate, --check-urls, or --apply',
  );
  const data = JSON.parse(await readFile(catalogPath, 'utf8'));
  validateHotelCatalog(data);
  if (flag === '--collect') await collect(data);
  if (flag === '--upload') await upload(data);
  if (flag === '--validate') console.log(validateHotelPhotos(data));
  if (flag === '--check-urls') await checkUrls(data);
  if (flag === '--apply') await apply(data);
}
