import { addLocalDays, isLocalDate, propertyLocalInstant } from './booking-dates.js';
import { allocateByWeights, refundOfPaid } from './booking-money.js';

/** Original nightly components, including paid extras; never reprice or prorate hours. */
export function earlyDepartureRoom(room, now) {
  const fail = () => { throw new RangeError('EARLY_DEPARTURE_UNSUPPORTED'); };
  const money = value => { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };
  const sum = values => { const value = values.reduce((a, b) => a + BigInt(money(b)), 0n); if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(); return Number(value); };
  try {
    if (!isLocalDate(room.checkIn) || !isLocalDate(room.checkOut) || room.checkOut <= room.checkIn
      || !Number.isInteger(room.checkInMinute) || room.checkInMinute < 0 || room.checkInMinute > 1439
      || !Array.isArray(room.nights) || room.nights.length < 1 || room.nights.length > 30
      || room.policy?.version !== 1 || typeof room.policy.earlyDeparture?.offered !== 'boolean'
      || !Number.isInteger(room.policy.earlyDeparture.pct) || room.policy.earlyDeparture.pct < 0 || room.policy.earlyDeparture.pct > 100) fail();
    const at = new Date(now).getTime();
    if (!Number.isFinite(at)) fail();
    const time = `${String(Math.floor(room.checkInMinute / 60)).padStart(2, '0')}:${String(room.checkInMinute % 60).padStart(2, '0')}`;
    room.nights.forEach((night, i) => { if (night.night !== addLocalDays(room.checkIn, i)) fail(); money(night.rateMinor); money(night.taxMinor); });
    if (addLocalDays(room.checkIn, room.nights.length) !== room.checkOut
      || sum(room.nights.map(n => n.rateMinor)) !== money(room.rent)
      || sum(room.nights.map(n => n.taxMinor)) !== money(room.tax)) fail();
    const fees = allocateByWeights(money(room.fee), room.nights.map(n => n.rateMinor));
    const unused = room.nights.map(n => new Date(propertyLocalInstant(n.night, time, room.timeZone)).getTime() > at);
    const unusedNights = room.nights.filter((_, i) => unused[i]).map(n => n.night);
    const parts = { rent: sum(room.nights.map((n, i) => unused[i] ? n.rateMinor : 0)),
      tax: sum(room.nights.map((n, i) => unused[i] ? n.taxMinor : 0)), fee: sum(fees.map((f, i) => unused[i] ? f : 0)) };
    const offered = room.policy.earlyDeparture.offered, pct = offered ? room.policy.earlyDeparture.pct : 0;
    return { consumedNights: room.nights.filter((_, i) => !unused[i]).map(n => n.night), unusedNights,
      inventoryEnd: unusedNights[0] ?? room.checkOut, offered, pct,
      original: { rent: room.rent, tax: room.tax, fee: room.fee }, unused: parts, refund: refundOfPaid(parts, pct) };
  } catch { fail(); }
}
