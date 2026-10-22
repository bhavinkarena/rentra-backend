// Hotel guest-path load test (hotel plan, Phase 9). Read-only endpoints only: search with dates,
// a hotel's rooms and a stay quote. Run against a staging or local API, never production:
//   node scripts/hotel-load.mjs http://localhost:4106/api/v1 [seconds=30] [concurrency=25] [betaPass]
const [base, seconds = '30', concurrency = '25', pass] = process.argv.slice(2);
if (!base || /onrender\.com|rentra\.(in|com)/.test(base)) throw new Error('Give a local or staging API URL.');
const headers = pass ? { 'X-Rentra-Beta': pass } : {};
const day = (n) => new Date(Date.now() + 5.5 * 36e5 + n * 864e5).toISOString().slice(0, 10);
const get = (path) => fetch(`${base}${path}`, { headers }).then(async (r) => ({ ok: r.ok, body: await r.json() }));

const seed = await get(`/discovery/search?vertical=hotel&checkin=${day(20)}&checkout=${day(22)}`);
const codes = (seed.body.data?.items ?? []).map((item) => item.href.match(/-([0-9a-z]+)\?/)?.[1]).filter(Boolean);
if (!codes.length) throw new Error('No bookable hotels found (is Hotels visible? pass a beta pass as the 4th argument).');
const routes = [
  () => `/discovery/search?vertical=hotel&city=surat&checkin=${day(10 + Math.floor(Math.random() * 60))}&checkout=${day(72)}&adults=2`,
  () => `/discovery/listings/${codes[Math.floor(Math.random() * codes.length)]}/rooms?checkin=${day(30)}&checkout=${day(32)}&adults=2`,
  () => `/discovery/suggest?q=sur&vertical=hotel`,
];
const timings = { search: [], rooms: [], suggest: [] };
let errors = 0;
const statuses = {};
const end = Date.now() + Number(seconds) * 1000;
await Promise.all(Array.from({ length: Number(concurrency) }, async () => {
  while (Date.now() < end) {
    const i = Math.floor(Math.random() * routes.length);
    const started = performance.now();
    const response = await fetch(`${base}${routes[i]()}`, { headers }).catch(() => null);
    if (!response?.ok) errors += 1;
    const key = `${['search', 'rooms', 'suggest'][i]} ${response?.status ?? 'network'}`;
    statuses[key] = (statuses[key] ?? 0) + 1;
    await response?.arrayBuffer();
    timings[['search', 'rooms', 'suggest'][i]].push(performance.now() - started);
  }
}));
const pct = (list, p) => Math.round([...list].sort((a, b) => a - b)[Math.max(0, Math.ceil(list.length * p) - 1)] ?? 0);
const total = Object.values(timings).reduce((sum, list) => sum + list.length, 0);
console.log(`requests ${total} in ${seconds}s at concurrency ${concurrency} (${Math.round(total / Number(seconds))}/s), errors ${errors}`);
for (const [name, list] of Object.entries(timings)) console.log(`${name.padEnd(8)} n=${list.length} p50=${pct(list, 0.5)}ms p95=${pct(list, 0.95)}ms p99=${pct(list, 0.99)}ms`);
console.log('statuses', statuses, '(429 = the per-IP discovery rate limit doing its job)');
