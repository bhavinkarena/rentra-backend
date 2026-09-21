import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { getSession, requireActiveClient } from '../auth/dal.js';
import { requireAdmin } from '../auth/admin.js';
import { customerPageAccount } from '../customer/page.js';
import { CustomerAccountError } from '../auth/customer-access.js';
import { sql } from '../db/index.js';
import { BookingRecordError, readBookingRecord, listBookingRecords } from './records.js';

export async function bookingActor(kind) {
  if (kind === 'owner') return { kind, id: (await requireActiveClient()).id };
  if (kind === 'admin') return { kind, id: (await requireAdmin()).id };
  await customerPageAccount();
  return { kind: 'customer', session: await getSession() };
}
export async function bookingRecordPage(kind, id) {
  const actor = await bookingActor(kind);
  try { return await readBookingRecord(sql, actor, id); }
  catch (error) {
    if (error instanceof CustomerAccountError) redirect('/login');
    if (error instanceof BookingRecordError) notFound();
    throw error;
  }
}
export async function bookingHistoryPage(kind, filters) {
  const actor = await bookingActor(kind);
  try { return await listBookingRecords(sql, actor, filters); }
  catch (error) {
    if (error instanceof CustomerAccountError) redirect('/login');
    if (error instanceof BookingRecordError) notFound();
    throw error;
  }
}
