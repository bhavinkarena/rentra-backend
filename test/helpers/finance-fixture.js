import { randomUUID } from 'node:crypto';
// Explicit disposable-database fixture only. These ledger facts model evidence; no provider or money is contacted.
export async function seedFinanceFixture(sql, f) {
  const [customer] =
    await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('cp22@fixture.invalid','customer','active','Finance Guest') RETURNING id`;
  const [destination] =
    await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
    VALUES (${f.owner},1,'bank','Property Owner','6789','SBIN0001234','same','verified','migration',now(),'fixture','fixture-verification',${'a'.repeat(64)},now()) RETURNING id`;
  const make = async (environment, options = {}) =>
    sql.begin(async (tx) => {
      const sim = environment === 'simulated',
        mode = sim ? 'simulated' : 'real',
        provider = sim ? 'dummy' : 'fixture',
        key = randomUUID();
      const snapshot = {
        title: 'Finance Farm',
        ...(options.unattributed ? {} : { ownerId: f.owner }),
      };
      const [order] =
        await tx`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,state,payment_mode,visit_provenance)
      VALUES (${key},${customer.id},${f.listing},'INR','Asia/Kolkata','v1','v1','{}',${JSON.stringify(snapshot)}::text::jsonb,100000,8000,0,${key},${'a'.repeat(64)},'completed',${mode},${environment === 'live' ? 'real' : 'test'}) RETURNING id`;
      const [visit] =
        await tx`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,state,amount_rent,amount_fee,starts_at,ends_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,payment_mode,visit_provenance,units_booked,guests,listing_snapshot)
      VALUES (${key.slice(0, 16)},${f.listing},${customer.id},${order.id},1,current_date-1,current_date-1,'day','completed',1000,80,now()-interval '1 day',now()-interval '16 hours','INR','Asia/Kolkata',100000,8000,0,${mode},${environment === 'live' ? 'real' : 'test'},1,2,${JSON.stringify(snapshot)}::text::jsonb) RETURNING id`;
      const [payment] =
        await tx`INSERT INTO payment_order(booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,state)
      VALUES (${order.id},${provider},${environment},${mode},'INR','full',108000,${key},${'b'.repeat(64)},'succeeded') RETURNING id`;
      const [attempt] =
        await tx`INSERT INTO payment_attempt(payment_order_id,provider,environment,mode,currency,attempt_number,expected_minor,state,provider_payment_id)
      VALUES (${payment.id},${provider},${environment},${mode},'INR',1,108000,'succeeded',${key}) RETURNING id`;
      const [transaction] =
        await tx`INSERT INTO payment_transaction(attempt_id,reference,provider,environment,mode,currency,kind,outcome,expected_minor,simulated_minor,captured_minor,provider_payment_id,external_ledger_id,verified_at,evidence_hash)
      VALUES (${attempt.id},${sim ? 'DUMMY_TXN_' + key : key},${provider},${environment},${mode},'INR',${sim ? 'simulated' : 'capture'},'succeeded',108000,${sim ? 108000 : 0},${sim ? 0 : 108000},${key},${key},now(),${'c'.repeat(64)}) RETURNING id`;
      const allocations = [];
      for (const [component, value] of [
        ['rent', 100000],
        ['fee', 8000],
      ]) {
        const [row] =
          await tx`INSERT INTO payment_allocation(transaction_id,booking_id,component,actual_minor,simulated_minor,created_at) VALUES (${transaction.id},${visit.id},${component},${sim ? 0 : value},${sim ? value : 0},${options.createdAt || new Date().toISOString()}) RETURNING id`;
        allocations.push(row.id);
      }
      return {
        orderId: order.id,
        bookingId: visit.id,
        transactionId: transaction.id,
        allocationId: allocations[0],
        feeAllocationId: allocations[1],
        paymentId: payment.id,
      };
    });
  const live = await make('live'),
    test = await make('test'),
    simulated = await make('simulated'),
    unresolved = await make('live', { unattributed: true });
  for (const [state, value] of [
    ['succeeded', 20000],
    ['requested', 10000],
    ['failed', 5000],
  ]) {
    await sql.begin(async (tx) => {
      const key = randomUUID();
      const [refund] =
        await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,actual_minor,idempotency_key,request_hash,provider_refund_id,verified_at,evidence_hash)
        VALUES ('Fixture partial refund',${key},${live.transactionId},'fixture','live','real','INR',${state},${value},${state === 'succeeded' ? value : 0},${key},${'d'.repeat(64)},${state === 'succeeded' ? key : null},${state === 'succeeded' ? new Date().toISOString() : null},${state === 'succeeded' ? 'e'.repeat(64) : null}) RETURNING id`;
      await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor,actual_minor) VALUES (${refund.id},${live.allocationId},${live.bookingId},'rent',${value},${state === 'succeeded' ? value : 0})`;
    });
  }
  const [payout] =
    await sql`INSERT INTO payout(booking_id,client_id,funding_allocation_id,actual_net_minor,gross,commission,net,status,destination_id,utr,settled_at)
    VALUES (${live.bookingId},${f.owner},${live.allocationId},30000,1000,80,920,'paid',${destination.id},'FIXTURE-UTR',now()) RETURNING id`;
  const [legacy] =
    await sql`INSERT INTO payout(booking_id,client_id,gross,commission,net,status,destination_id) VALUES (${test.bookingId},${f.owner},1000,80,920,'pending',${destination.id}) RETURNING id`;
  return {
    live,
    test,
    simulated,
    unresolved,
    payoutId: payout.id,
    legacyPayoutId: legacy.id,
    destinationId: destination.id,
    add: make,
    period: new Date().toISOString().slice(0, 7),
  };
}
