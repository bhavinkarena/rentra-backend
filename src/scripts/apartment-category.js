/**
 * Story 3.10: the "Whole apartment" category (vertical hotel, rental unit unit_night).
 * Run after 0088 commits: db:migrate applies every pending file in ONE transaction, and a new enum
 * value cannot be used in the transaction that added it (55P04). Idempotent.
 */
export function seedApartmentCategory(client) {
  return client`INSERT INTO category (slug, name, form, default_rental_unit, vertical_code, icon_key, sort_order)
    VALUES ('whole-apartment', 'Whole apartment', 'fixed', 'unit_night', 'hotel', 'apartment', 90)
    ON CONFLICT (slug) DO NOTHING`;
}
