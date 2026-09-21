'use server';
import { sql } from '../db/index.js';
import { bookingActor } from './record-page.js';
import { previewCancellation, commitCancellation } from './cancellation.js';

function failure(error) {
  const messages={CANCELLATION_CHANGED:'The cancellation estimate changed. Preview it again before confirming.',
    VISIT_STARTED:'This visit has started. Contact the host using your booking record for help.',
    VISIT_NOT_CANCELLABLE:'A selected visit is no longer cancellable. Reload the booking record.',
    POLICY_UNSUPPORTED:'This booking needs an operator to review its original policy. Contact the host from your booking record.',
    PAYMENT_UNSUPPORTED:'This payment needs an operator review. Contact the host from your booking record.'};
  return {error:messages[error.code]??'Cancellation could not be completed. Reload your booking record to check its current status before retrying.'};
}
export async function previewCustomerCancellation(input) {
  const actor=await bookingActor('customer');
  try {return {preview:await previewCancellation(sql,actor.session,input)};} catch(error){return failure(error);}
}
export async function cancelCustomerVisits(input) {
  const actor=await bookingActor('customer');
  try {return {receipt:await commitCancellation(sql,actor.session,input)};} catch(error){return failure(error);}
}
