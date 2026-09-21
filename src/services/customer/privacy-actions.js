'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/services/auth/admin';
import { sql } from '@/services/db';
import { reviewPrivacyRequest } from '@/services/customer/privacy-admin';
export async function startPrivacyReview(form) {
  const admin=await requireAdmin();
  await reviewPrivacyRequest(sql,admin.id,form.get('requestId'));
  revalidatePath('/admin/privacy');
  revalidatePath('/account/privacy');
}
