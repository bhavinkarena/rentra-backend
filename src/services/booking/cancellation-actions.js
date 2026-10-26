'use server';
import { sql } from '../db/index.js';
import { bookingActor } from './record-page.js';
import { previewCancellation, commitCancellation } from './cancellation.js';

function failure(error, operation) {
  const messages={EARLY_DEPARTURE_UNAVAILABLE:'Only an active, already-started hotel stay can end early. Reload your booking record or contact support.',
    EARLY_DEPARTURE_UNSUPPORTED:'This stay needs support to review its original nightly prices, schedule or early-departure policy. No rooms have ended.',
    CANCELLATION_CHANGED:'The cancellation estimate changed. Preview it again before confirming.',
    REFUND_ATTRIBUTION_REQUIRED:'Earlier refunds do not identify their rooms. Contact support for admin resolution before cancelling rooms.',
    STAY_STARTED:'This stay has started. Contact the host using your booking record for help.',
    ROOM_NOT_CANCELLABLE:'A selected room is no longer cancellable. Reload the booking record.',
    VISIT_STARTED:'This visit has started. Contact the host using your booking record for help.',
    VISIT_NOT_CANCELLABLE:'A selected visit is no longer cancellable. Reload the booking record.',
    POLICY_UNSUPPORTED:'This booking needs an operator to review its original policy. Contact the host from your booking record.',
    PAYMENT_UNSUPPORTED:'This payment needs an operator review. Contact the host from your booking record.'};
  if (operation==='early_departure') Object.assign(messages,{CANCELLATION_CHANGED:'The early-departure estimate changed. Preview it again before confirming.',ROOM_NOT_CANCELLABLE:'A selected room can no longer end early. Reload your booking record.',REFUND_ATTRIBUTION_REQUIRED:'Earlier refunds cannot safely be attributed to these unused nights. Contact support for admin resolution.'});
  return {error:messages[error.code]??'Cancellation could not be completed. Reload your booking record to check its current status before retrying.'};
}
export async function previewCustomerCancellation(input) {
  const actor=await bookingActor('customer');
  try {return {preview:await previewCancellation(sql,actor.session,input)};} catch(error){return failure(error,input?.operation);}
}
export async function cancelCustomerVisits(input) {
  const actor=await bookingActor('customer');
  try {return {receipt:await commitCancellation(sql,actor.session,input)};} catch(error){return failure(error,input?.operation);}
}
