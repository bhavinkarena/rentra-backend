/**
 * Provision (or re-provision) a Super Admin.
 *
 * There is NO self-signup for admins — this script is the only way an admin
 * account comes into existence. The password is generated or provided here,
 * printed once, and stored only as a scrypt hash.
 *
 *   npm run seed:admin -- admin@gmail.com "Kunj Detroja"
 *   npm run seed:admin -- admin@gmail.com "Kunj Detroja" --password Admin@123
 *   npm run seed:admin -- admin@gmail.com "Kunj Detroja" --totp
 */
import postgres from 'postgres';
import {
  hashPassword, generateStrongPassword, generateTotpSecret, totpUri,
} from '@/services/auth/admin-crypto.js';

const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((a) => !a.startsWith('--'));
const wantTotp = rawArgs.includes('--totp');
const passwordIdx = rawArgs.indexOf('--password');
const customPassword = passwordIdx !== -1 ? rawArgs[passwordIdx + 1] : null;
const email = (args[0] ?? 'admin@gmail.com').toLowerCase();
const name = args[1] ?? 'Rentra Ops';

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

const password = customPassword || generateStrongPassword();
const passwordHash = hashPassword(password);
const secret = wantTotp ? generateTotpSecret() : null;

const [existing] = await sql`SELECT id FROM admin_user WHERE email = ${email}`;

if (existing) {
  await sql`
    UPDATE admin_user
       SET password_hash = ${passwordHash},
           name = ${name},
           is_active = true,
           failed_attempts = 0,
           locked_until = NULL
           ${wantTotp ? sql`, totp_secret = ${secret}` : sql``}
     WHERE id = ${existing.id}`;
  console.log(`\n  Reset existing admin: ${email}`);
} else {
  await sql`
    INSERT INTO admin_user (email, name, password_hash, totp_secret)
    VALUES (${email}, ${name}, ${passwordHash}, ${secret})`;
  console.log(`\n  Created admin: ${email}`);
}

console.log('  ┌──────────────────────────────────────────────────────────');
console.log(`  │  email     ${email}`);
console.log(`  │  password  ${password}`);
console.log('  │');
console.log('  │  Shown ONCE. Not recoverable — re-run this script to reset.');
if (wantTotp) {
  console.log('  │');
  console.log('  │  Add this to your authenticator app:');
  console.log(`  │  ${totpUri({ email, secret })}`);
  console.log(`  │  (or enter the secret manually: ${secret})`);
} else {
  console.log('  │');
  console.log('  │  No TOTP enrolled. Fine for development — but admin login is');
  console.log('  │  BLOCKED in production without it. Re-run with --totp before');
  console.log('  │  you deploy.');
}
console.log('  └──────────────────────────────────────────────────────────\n');

await sql.end();
