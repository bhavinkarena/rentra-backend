import 'server-only';
import { deliverCustomerCode } from './customer-delivery.js';

/**
 * Owner and caretaker sign-in codes.
 *
 * Email goes through Resend (RESEND_API_KEY, OTP_EMAIL_FROM). SMS reuses the
 * customer Twilio adapter, so it needs CUSTOMER_OTP_DELIVERY=twilio and the
 * TWILIO_* variables. Outside production nothing is sent: the code is printed
 * to the server terminal, as before. A missing provider throws, so a code is
 * never recorded as delivered when it was not.
 */
export async function deliverPortalCode({ identifier, channel, code, purpose }, env = process.env, fetcher = fetch, print = console.info) {
  if (env.NODE_ENV !== 'production') {
    print(`\n  ┌─ OTP ─────────────────────────────────────────\n  │  ${channel.toUpperCase()} → ${identifier}\n  │  code: ${code}\n  └───────────────────────────────────────────────\n`);
    return;
  }
  const payout = purpose === 'payout_confirm';
  const payoutMessage = `Your Rentra code to confirm a payout method change is ${code}. It expires in 10 minutes. Do not share this code. If you did not request this change, do not use the code.`;
  if (channel === 'sms') return deliverCustomerCode(identifier.replace(/^staff:/, ''), code, env, fetcher, payout ? payoutMessage : undefined);
  if (channel !== 'email') throw new Error(`No ${channel} provider configured — cannot deliver OTP in production`);
  if (!env.RESEND_API_KEY || !env.OTP_EMAIL_FROM) throw new Error('Owner email delivery is not configured.');
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.OTP_EMAIL_FROM,
      to: [identifier],
      subject: payout ? `${code} confirms your Rentra payout method change` : `${code} is your Rentra sign-in code`,
      text: payout ? payoutMessage : `Your Rentra sign-in code is ${code}. It expires in 10 minutes. Do not share this code with anyone, including Rentra staff.`,
    }),
  });
  // Never log provider bodies: they can echo the address and the code.
  if (!response.ok) throw new Error('Email delivery failed.');
}
