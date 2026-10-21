/**
 * Map points without PostGIS functions (hotel plan, Phase 6). Geometry columns
 * arrive as hex EWKB (text on local servers without PostGIS), so search and
 * landmark distances work the same on Neon and on a disposable database.
 */

/** { latitude, longitude } from a hex (E)WKB or (E)WKT point, or null. */
export function parsePoint(hex) {
  // (E)WKT ("SRID=4326;POINT(72.8 21.2)") as written by fixtures and drizzle.
  const text = typeof hex === 'string' && /^(?:SRID=\d+;)?point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)$/i.exec(hex.trim());
  if (text) return { latitude: Number(text[2]), longitude: Number(text[1]) };
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, 'hex');
  const little = bytes[0] === 1;
  if (bytes.length < 21) return null;
  const type = little ? bytes.readUInt32LE(1) : bytes.readUInt32BE(1);
  const at = type & 0x20000000 ? 9 : 5;
  if ((type & 0xffff) !== 1 || bytes.length < at + 16) return null;
  const read = (offset) => (little ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset));
  return { latitude: read(at + 8), longitude: read(at) };
}

/** Hex EWKB for a WGS 84 point: accepted by a geometry column and by its text stand-in. */
export function pointHex({ latitude, longitude }) {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt8(1, 0);
  bytes.writeUInt32LE(0x20000001, 1);
  bytes.writeUInt32LE(4326, 5);
  bytes.writeDoubleLE(longitude, 9);
  bytes.writeDoubleLE(latitude, 17);
  return bytes.toString('hex');
}

/** Great-circle km between two { latitude, longitude } points (PostGIS sphere radius). */
export function distanceKm(a, b) {
  const rad = (deg) => (Number(deg) * Math.PI) / 180;
  const h = Math.sin((rad(b.latitude) - rad(a.latitude)) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin((rad(b.longitude) - rad(a.longitude)) / 2) ** 2;
  return (2 * 6370986 * Math.asin(Math.sqrt(h))) / 1000;
}
