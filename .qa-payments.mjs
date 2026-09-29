// QA-only: enable the Razorpay Test gateway in the disposable DB (untracked, delete after use).
import postgres from 'postgres';
import { setPaymentGatewayConfiguration } from '@/services/payments/gateway-settings.js';
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [admin] = await sql`SELECT id FROM admin_user WHERE email='full@fixture.invalid'`;
const [cur] = await sql`SELECT coalesce(max(version),0)::int v FROM payment_gateway_config`;
console.log(await setPaymentGatewayConfiguration(sql, { actorId: admin.id, expectedVersion: cur.v, provider: 'razorpay', environment: 'test', enabled: true, collectionPurpose: 'full' }));
await sql.end();
