/** Browser callbacks never feed this state; only authenticated server reads do. */
export function checkoutMessage(checkout) {
  if (!checkout) return 'Review your test booking';
  if (checkout.needsResolution) return 'Payment received after the booking became unavailable. A Test refund was requested; check its current status in your booking record. Your visits are not confirmed.';
  if (checkout.state === 'confirmed' && checkout.paymentState === 'succeeded') return 'Test booking confirmed';
  if (checkout.state === 'cancelled') return 'This booking is cancelled. Check individual visits and Test refund status in your booking record.';
  if (checkout.state !== 'held') return 'The date hold has ended. Check payment status before starting again.';
  if (['unknown', 'dispatched'].includes(checkout.executionState)) return 'Payment outcome is pending. Check status to recover this booking.';
  if (checkout.paymentState === 'failed') return 'Test payment failed. You can retry within the remaining hold time.';
  return 'Your dates are temporarily held. Complete test payment before the timer ends.';
}
export function mayLaunchCheckout(checkout, remainingSeconds) {
  return checkout?.state === 'held' && !checkout.needsResolution && checkout.paymentState !== 'succeeded'
    && remainingSeconds > 0 && ['ready', 'linked'].includes(checkout.executionState);
}
