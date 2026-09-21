export const notificationLabels = Object.freeze({ confirmation: 'Booking confirmed', reminder: 'Your visit is coming up',
  cancellation: 'Visits cancelled', refund: 'Refund update', completion: 'Visit completion recorded', review_invitation: 'How was your visit?' });
export function notificationMessage(row) {
  const prefix = row.visit_provenance === 'real' && !row.is_test_payment ? 'Rentra' : 'Rentra Test / simulation';
  return `${prefix}: ${notificationLabels[row.template] || 'Booking update'}. Reference ${row.reference}. Update ${row.id}. Open your Rentra booking record for details. No payment is requested in this message.`;
}
