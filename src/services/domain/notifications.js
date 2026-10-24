export const notificationLabels = Object.freeze({ confirmation: 'Booking confirmed', reminder: 'Your visit is coming up',
  cancellation: 'Visits cancelled', refund: 'Refund update', completion: 'Visit completion recorded', review_invitation: 'How was your visit?', arrival_guide: 'Arrival guide',
  request_approved: 'Owner accepted your request', request_declined: 'Owner declined your request' });
/** Hotel stays (hotel plan, Phase 10): the same messages in stay words. */
export const stayNotificationLabels = Object.freeze({ confirmation: 'Hotel booking confirmed', reminder: 'Your hotel stay is coming up',
  cancellation: 'Hotel booking cancelled', refund: 'Refund update', completion: 'Check-out recorded', review_invitation: 'How was your stay?', arrival_guide: 'Check-in details',
  request_approved: 'Hotel accepted your request', request_declined: 'Hotel declined your request' });
export function notificationMessage(row) {
  const labels = row.is_stay ? stayNotificationLabels : notificationLabels;
  const prefix = row.visit_provenance === 'real' && !row.is_test_payment ? 'Rentra' : 'Rentra Test / simulation';
  if (row.template === 'arrival_guide' && row.guide) return `${prefix}: Arrival guide for ${row.reference}. ${row.guide}. Update ${row.id}.`;
  if (row.template === 'request_approved') return `${prefix}: ${labels.request_approved}. Reference ${row.reference}. Open your Rentra booking to pay and confirm before the hold ends. Update ${row.id}.`;
  return `${prefix}: ${labels[row.template] || 'Booking update'}. Reference ${row.reference}. Update ${row.id}. Open your Rentra booking record for details. No payment is requested in this message.`;
}
