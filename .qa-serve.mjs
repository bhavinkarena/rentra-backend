// QA-only launcher (untracked, delete after use): disposable DB + file-backed fake Razorpay.
import { fileBackedRazorpay } from './test/helpers/fake-razorpay.mjs';
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(process.env.DATABASE_URL ?? ''))
  throw new Error('refusing non-disposable database');
const fake = fileBackedRazorpay(process.env.FAKE_RAZORPAY_STATE);
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  String(url).startsWith('https://api.razorpay.com/') ? fake(String(url), init) : realFetch(url, init);
await import('./src/index.js');
