import { sql } from '@/config/database.js';
import { requireActiveClient } from '@/services/auth/dal.js';
import { changeHotelAri, hotelAriGrid } from '@/services/booking/hotel-ari.js';
import { apartmentCalendar, changeApartmentCalendar } from '@/services/booking/apartment-stays.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** Hotel operations for owners (hotel plan, Phase 5). */
const owner = async () => ({ kind: 'owner', id: (await requireActiveClient()).id });

export const ariGrid = asyncHandler(async (req, res) =>
  ok(
    res,
    await hotelAriGrid(sql, await owner(), req.params.id, {
      from: req.query.from,
      days: req.query.days,
    }),
  ),
);
export const ariChange = asyncHandler(async (req, res) =>
  ok(res, await changeHotelAri(sql, await owner(), req.params.id, req.body)),
);

/** The same calendar for hotel staff; `req.staff` is set by requireStaff. */
export const staffAriGrid = asyncHandler(async (req, res) =>
  ok(
    res,
    await hotelAriGrid(sql, { kind: 'staff', id: req.staff.id }, req.params.id, {
      from: req.query.from,
      days: req.query.days,
    }),
  ),
);
export const staffAriChange = asyncHandler(async (req, res) =>
  ok(res, await changeHotelAri(sql, { kind: 'staff', id: req.staff.id }, req.params.id, req.body)),
);

/** Story 3.11: a whole apartment's nights (booked, buffer, blocked, open) and block/unblock. */
export const apartmentGrid = asyncHandler(async (req, res) =>
  ok(
    res,
    await apartmentCalendar(sql, (await owner()).id, req.params.id, {
      from: req.query.from,
      days: req.query.days,
    }),
  ),
);
export const apartmentChange = asyncHandler(async (req, res) =>
  ok(res, await changeApartmentCalendar(sql, (await owner()).id, req.params.id, req.body)),
);
