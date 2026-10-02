export const OWNER_CATEGORIES = ['account','property','booking','case','review','team'];
export const REQUIRED_CATEGORIES = ['account','property','booking','case','review'];
export function ownerPreferences(value = {}) {
  return Object.fromEntries(OWNER_CATEGORIES.map(c => [c,{mobile:value[c]?.mobile !== false,email:value[c]?.email !== false}]));
}
export const ownerEventTitles = {
  booking_confirmed:'New booking',visits_cancelled:'Booking cancelled',arrival_tomorrow:'Arrival tomorrow',arrival_today:'Arrival today',checkout_overdue:'Check-out not recorded',
  application_approved:'Your verification is approved',application_more_info:'Your verification needs changes',application_rejected:'Your verification was not approved',
  listing_published:'Your property is live',listing_review_decided:'Property review updated',listing_hidden:'Your property needs attention',
  verification_scheduled:'Property verification scheduled',verification_rescheduled:'Property verification moved',verification_recorded:'Property verification updated',
  dates_running_out:'Your open dates are running out',review_published:'New guest review — reply when ready',review_report_closed:'Your review report was reviewed',
  dispute_opened:'A dispute was opened',dispute_response_requested:'Rentra needs your dispute reply',dispute_resolved:'A dispute was resolved',support_reply:'Rentra replied to your support request',
  caretaker_evidence:'Your caretaker recorded a visit update',caretaker_revoked:'Caretaker removed during a visit',payout_destination_failed:'Your payout method needs changes',
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function ownerUpdateHref(update) {
  const d=update.detail || update.payload?.detail || {}, action=update.action || update.event || ''; 
  if (uuid.test(d.supportId || '')) return `/partner/support/${d.supportId}`;
  if (uuid.test(d.disputeId || '')) return `/partner/disputes/${d.disputeId}`;
  if (uuid.test(d.reviewId || '')) return '/partner/reviews';
  if (action.startsWith('application_')) return '/partner';
  if (action==='payout_destination_failed') return '/partner/settings/payout';
  if (action.startsWith('caretaker_revoked')) return '/partner/team';
  const property=update.rentable_id || update.payload?.propertyId,order=update.order_id || update.payload?.orderId;
  if (action==='dates_running_out' && uuid.test(property || '')) return `/partner/listings/${property}/calendar`;
  if (uuid.test(order || '')) return `/partner/bookings/${order}`;
  if (uuid.test(property || '')) return `/partner/listings/${property}/overview`;
  return '/partner/updates';
}
export function quietUntil(now, urgent = false) {
  if(urgent) return null;
  const ist=new Date(+new Date(now)+330*60000),hour=ist.getUTCHours();
  if(hour>=7 && hour<22) return null;
  ist.setUTCHours(hour<7?7:31,0,0,0);
  return new Date(+ist-330*60000);
}
export function ownerNotificationMessage(row, origin) {
  const d=row.detail || row.payload?.detail || {};
  const title=ownerEventTitles[row.event || row.action] || 'Rentra update';
  const context=[row.property_title,d.reference,d.visitDate,d.slot?.replaceAll('_',' '),d.guests ? `${d.guests} guests` : null].filter(Boolean).join(' · ');
  const rent=d.rentMinor != null && /^\d+$/.test(String(d.rentMinor)) ? `Booked rent ₹${(BigInt(d.rentMinor)/100n).toLocaleString('en-IN')}.${(BigInt(d.rentMinor)%100n).toString().padStart(2,'0')}.` : '';
  return `${title}${context ? ': '+context : ''}. ${rent} Open: ${origin}${ownerUpdateHref(row)}`;
}
