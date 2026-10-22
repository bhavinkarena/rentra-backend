# Real hotel catalogue

`india-hotel-catalog.json` contains 72 real properties: eight each in Mumbai,
Delhi, Bengaluru, Hyderabad, Chennai, Kolkata, Pune, Ahmedabad and Jaipur.
Each property has a MakeMyTrip detail-page URL, locality, street address and
provider star category. Amenities are a sourced subset, not an exhaustive list.
The research date records when sources were consulted, not a guarantee that
the provider's cached information is current. Descriptions are generated from facts.

The database relationship is `city -> area -> rentable -> hotel_profile`.
`rentable.category_id` points to a category in the hotel vertical; hotel listings
use `rental_unit=night`. Facilities belong in `rentable_amenity`, not a second
JSON amenity store. Bookable rooms require `room_type`, `rate_plan`, and
`room_night`; prices use integer paise. Existing records are never overwritten.

Public catalogue references are inserted as **drafts** under the unclaimed,
pending-application account `hotel-catalog-import@rentra.invalid`. No credentials
are created. Source provenance and unverified fields are stored in
`hotel_profile.policies.externalCatalog`. Profile fields required by the schema
retain database defaults, with `stayAnswered=false` and `gstAnswered=false`;
these defaults must not be interpreted as the hotel's actual policies.

No review scores, room counts, rates, GPS pins, GST registrations, or photos are
invented. Complete owner onboarding, licensed property photos, confirmed room
inventory, rates, taxes and policies before publication. A public travel portal
listing does not provide Rentra a room allotment or a supplier relationship.

Run from `rentra-backend` (DATABASE_URL is loaded from `.env`):

```powershell
node --env-file=.env src/scripts/import-hotel-catalog.js --validate
# Remote imports require SEED_ALLOW_HOST to match the exact DATABASE_URL hostname.
$env:SEED_ALLOW_HOST = '<exact-database-hostname>'
node --env-file=.env src/scripts/import-hotel-catalog.js          # roll back all writes
node --env-file=.env src/scripts/import-hotel-catalog.js --apply  # atomic import
```

The existing seed guard refuses `NODE_ENV=production`. The importer serialises
concurrent runs, skips existing names/slugs in the same city, checks required
catalogue entries, and verifies its new records before commit. Rerunning it
preserves manual edits. The batch ID allows inspection of just this import.

## Real property photos

Each hotel now has six Cloudinary images in its `photos` array. These are real
property photographs sourced from named hotel galleries and booking pages,
with source image/page URLs, dimensions, SHA-256 and perceptual hashes retained.
No generated or generic seed-pool photos are used. The existing public-photo
normalizer and Next.js image configuration accept the Cloudinary URLs.

`hotel-photo-sources.json` keeps the researched candidates. The visual review
exclusions in `hotel-photo-exclusions.json` prevent known repeat crops,
promotional graphics, a placeholder and a mismatched property photo from being
reimported. Uploads resume from completed entries and use stable asset IDs.

```powershell
node --env-file=.env src/scripts/import-hotel-photos.js --upload
node src/scripts/import-hotel-photos.js --validate
node src/scripts/import-hotel-photos.js --check-urls
# Set SEED_ALLOW_HOST as above before applying to a remote database.
node --env-file=.env src/scripts/import-hotel-photos.js --apply
```

The photo apply step changes only the 72 matching imported drafts, preserves
unrelated galleries and checks the final database count in one transaction.
It does not publish listings. Source attribution does not establish a reuse
licence: `usageRights` / `photoUsageRights` remain `unconfirmed` until permission
is established. These are reference catalogue images, not proof of current room
condition or a supplier agreement.
