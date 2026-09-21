import 'server-only';
import { withListingInventory, expireInventoryHolds } from '../booking/inventory.js';
import { runRefundJobs } from './refunds.js';
import { lifecycle } from '../booking/checkout.js';
import { reconcilePayment } from './checkout-service.js';
import { processNextPaymentEvent } from './webhooks.js';

export async function runPaymentJobs(database, options = {}) {
  const listings=await database`SELECT DISTINCT rentable_id FROM booking_order WHERE state='held' AND hold_expires_at<=clock_timestamp() LIMIT 20`;
  for (const row of listings) await withListingInventory(database,row.rentable_id,async tx=>{ await expireInventoryHolds(tx,row.rentable_id); });
  const expired=await database`SELECT id FROM booking_order b WHERE state='expired'
    AND EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=b.id)
    AND NOT EXISTS(SELECT 1 FROM booking_lifecycle_event e WHERE e.order_id=b.id AND e.kind='expired') LIMIT 100`;
  for (const order of expired) await lifecycle(database,order.id,'expired',{environment:'test'});
  const work=await database`WITH due AS (
    SELECT e.payment_order_id FROM payment_execution e JOIN payment_order p ON p.id=e.payment_order_id
    WHERE e.state<>'ready' AND p.state<>'succeeded' AND e.next_check_at<=clock_timestamp()
    ORDER BY e.next_check_at LIMIT 10 FOR UPDATE OF e SKIP LOCKED)
    UPDATE payment_execution e SET next_check_at=clock_timestamp()+interval '1 minute'
    FROM due WHERE e.payment_order_id=due.payment_order_id RETURNING e.payment_order_id`;
  for (const row of work) {
    try { await reconcilePayment(database,row.payment_order_id,options); }
    catch(error) {
      const code=/^[A-Z_]{1,64}$/.test(error.code ?? '')?error.code:'RECONCILIATION_RETRY';
      await database`UPDATE payment_execution SET failure_code=${code},updated_at=clock_timestamp() WHERE payment_order_id=${row.payment_order_id}`;
    }
  }
  let events=0;
  while (events<10 && await processNextPaymentEvent(database,options)) events++;
  const refunds=await runRefundJobs(database,options);
  return { expiryListings:listings.length,reconciliations:work.length,events,refunds };
}
