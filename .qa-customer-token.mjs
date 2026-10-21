// QA-only (untracked, delete after use): a 1-day customer session on the disposable DB.
import postgres from 'postgres';
import { encryptSession } from '@/services/auth/session-crypto.js';
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name,profile_completed_at)
  VALUES ('hotel-guest@rentra.invalid','+919800000777','customer','active','Asha Patel',now())
  ON CONFLICT DO NOTHING RETURNING id`;
const [row] = user ? [user] : await sql`SELECT id FROM "user" WHERE email='hotel-guest@rentra.invalid' AND role='customer'`;
const [session] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${row.id},now()+interval '1 day') RETURNING id`;
console.log(await encryptSession({ userId: row.id, role: 'customer', sessionId: session.id }));
await sql.end();
