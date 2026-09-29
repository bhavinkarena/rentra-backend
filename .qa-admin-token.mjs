// QA-only (untracked): mint a 1-day admin portal session for the disposable DB.
import postgres from 'postgres';
import { SignJWT } from 'jose';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [admin] = await sql`SELECT id FROM admin_user WHERE email='full@fixture.invalid'`;
const sessionId = await issuePortalSession(sql, 'admin', admin.id, 86400);
console.log(await new SignJWT({ adminId: admin.id, sessionId }).setProtectedHeader({ alg: 'HS256' }).setAudience('rentra:admin').setExpirationTime('1d').sign(new TextEncoder().encode(process.env.SESSION_SECRET)));
await sql.end();
