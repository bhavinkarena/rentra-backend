// QA-only (untracked): mint a 1-day owner portal session for the disposable DB.
import postgres from 'postgres';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { encryptSession } from '@/services/auth/session-crypto.js';
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const id = process.argv[2];
console.log(await encryptSession({ userId: id, role: 'client', sessionId: await issuePortalSession(sql, 'client', id, 86400) }));
await sql.end();
