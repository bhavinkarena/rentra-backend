// Fixture-only: mint portal sessions in the disposable DB for the browser gate.
import postgres from 'postgres';
import { writeFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import { encryptSession } from '@/services/auth/session-crypto.js';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
const url = process.env.DATABASE_URL;
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(url))
  throw new Error('refusing non-disposable database');
const sql = postgres(url, { max: 1 });
const key = new TextEncoder().encode(process.env.SESSION_SECRET);
const [client] = await sql`SELECT id FROM "user" WHERE role='client' AND email='client@gmail.com'`;
await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES
  ('full@fixture.invalid','fixture-not-a-hash','Full Admin',NULL),
  ('limited@fixture.invalid','fixture-not-a-hash','Limited Admin','["admin.records.read"]'::jsonb),
  ('reader@fixture.invalid','fixture-not-a-hash','Clients Reader','["admin.clients.read"]'::jsonb),
  ('custreader@fixture.invalid','fixture-not-a-hash','Customers Reader','["admin.customers.read"]'::jsonb),
  ('second@fixture.invalid','fixture-not-a-hash','Second Reviewer',NULL)
  ON CONFLICT (email) DO NOTHING`;
// CP03 fixture: one upcoming confirmed visit on the seeded client's live listing.
await sql`INSERT INTO booking(reference,rentable_id,customer_id,day,slot,amount_rent,amount_fee,state,starts_at,ends_at)
  SELECT 'GATEUP1', r.id, (SELECT id FROM "user" WHERE role='customer' LIMIT 1), (now() + interval '6 days')::date,
    'day', 5000, 400, 'confirmed', now() + interval '6 days', now() + interval '6 days 8 hours'
  FROM rentable r WHERE r.client_id=${client.id} AND r.status='live'
  ORDER BY r.created_at LIMIT 1
  ON CONFLICT (reference) DO NOTHING`;
const admins = await sql`SELECT id,email FROM admin_user WHERE email LIKE '%@fixture.invalid'`;
const adminToken = async (id) =>
  new SignJWT({ adminId: id, sessionId: await issuePortalSession(sql, 'admin', id, 3600) })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
const out = {
  client: await encryptSession({
    userId: client.id,
    role: 'client',
    accountStatus: 'active',
    sessionId: await issuePortalSession(sql, 'client', client.id, 3600),
  }),
};
for (const a of admins) out[a.email.split('@')[0]] = await adminToken(a.id);
// CP04 fixture: a signed-in customer and a second customer holding an email.
const [guest] = await sql`SELECT id FROM "user" WHERE role='customer' AND phone='9898980001'`;
await sql`UPDATE "user" SET email='taken@fixture.invalid' WHERE role='customer' AND phone='9898980002'`;
// Re-running the mint replaces the customer's fixture session instead of stacking them.
await sql`UPDATE "user" SET name='Rahul S.', email=NULL, account_status='active', lifecycle_version=1 WHERE id=${guest.id}`;
await sql`UPDATE customer_session SET revoked_at=now() WHERE user_id=${guest.id} AND revoked_at IS NULL`;
const [guestSession] =
  await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${guest.id},now()+interval '1 day') RETURNING id`;
out.customer = await encryptSession({
  userId: guest.id,
  role: 'customer',
  sessionId: guestSession.id,
});
out.customerId = guest.id;
// CP05 fixture: two complete, submitted Gate 1 applications from pending clients.
const applicant = async (email, phone, legalName) => {
  const [user] =
    await sql`INSERT INTO "user"(email,role,account_status,name,phone,client_type,email_verified_at,phone_verified_at)
    VALUES (${email},'client','pending_application',${legalName},${phone},'owner',now(),now())
    ON CONFLICT (email, role) DO UPDATE SET account_status='pending_application' RETURNING id`;
  const [app] =
    await sql`INSERT INTO client_application(user_id,status,legal_name,residential_address,pincode,
      kyc_doc_type,kyc_name_on_doc,payout_upi_id,payout_holder_name,consent_at,submitted_at)
    VALUES (${user.id},'submitted',${legalName},'12 Ring Road, Surat','395007','pan_card',${legalName},
      ${`${phone}@upi`},${legalName},now(),now() - interval '50 hours')
    ON CONFLICT (user_id) DO UPDATE SET status='submitted', review_version=1, assigned_to=NULL,
      flagged_fields=NULL, strike_count=0, submitted_at=now() - interval '50 hours' RETURNING id`;
  await sql`INSERT INTO document(owner_type,owner_id,doc_type,side,storage_key,mime_type,status)
    VALUES ('client_application',${app.id},'pan_card','front',${`fixture/${app.id}`},'image/jpeg','uploaded')
    ON CONFLICT (owner_type, owner_id, doc_type, side) DO NOTHING`;
  await sql`DELETE FROM audit_log WHERE entity='client_application' AND entity_id=${app.id}`;
  await sql`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action)
    VALUES ('client',${user.id},'client_application',${app.id},'application_submitted')`;
  const [doc] = await sql`SELECT id FROM document WHERE owner_id=${app.id}`;
  return { userId: user.id, appId: app.id, docId: doc.id };
};
const gateA = await applicant('gate-a@fixture.invalid', '9111100001', 'Asha Gate');
const gateB = await applicant('gate-b@fixture.invalid', '9111100002', 'Bharat Gate');
out.gateA = gateA;
out.gateB = gateB;
out.gateAClient = await encryptSession({
  userId: gateA.userId,
  role: 'client',
  accountStatus: 'pending_application',
  sessionId: await issuePortalSession(sql, 'client', gateA.userId, 3600),
});
const [listing] =
  await sql`SELECT r.id, r.slug, r.public_code FROM rentable r JOIN booking b ON b.rentable_id=r.id
    WHERE r.client_id=${client.id} AND r.status='live' AND b.reference='GATEUP1'`;
out.listingId = listing?.id;
out.listingPath = listing ? `/listing/${listing.slug}-${listing.public_code}` : null;
out.clientId = client.id;
const [other] = await sql`SELECT id FROM rentable WHERE client_id<>${client.id} LIMIT 1`;
out.otherListingId = other?.id ?? null;
await writeFile(process.argv[2], JSON.stringify(out));
await sql.end();
console.log('minted', Object.keys(out).join(','));
