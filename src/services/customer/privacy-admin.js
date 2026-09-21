import 'server-only';
import { z } from 'zod';

async function activeAdmin(tx, adminId) {
  z.string().uuid().parse(adminId);
  const [admin]=await tx`SELECT id FROM admin_user WHERE id=${adminId} AND is_active=true FOR SHARE`;
  if(!admin) throw new Error('Active admin required.');
}
export async function readPrivacyQueue(database, adminId, offset = 0) {
  z.number().int().min(0).max(1000000).parse(offset);
  return database.begin(async tx=>{
    await activeAdmin(tx,adminId);
    const rows=await tx`SELECT id,customer_id,kind,state,created_at FROM customer_privacy_request
      WHERE state<>'closed' ORDER BY created_at,id LIMIT 100 OFFSET ${offset}`;
    return rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString()}));
  });
}
export async function reviewPrivacyRequest(database, adminId, requestId) {
  z.string().uuid().parse(requestId);
  return database.begin(async tx=>{
    await activeAdmin(tx,adminId);
    const [row]=await tx`UPDATE customer_privacy_request SET state='in_review',updated_at=now()
      WHERE id=${requestId} AND state='open' RETURNING id`;
    if(row) await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action)
      VALUES('admin',${adminId},'customer_privacy_request',${row.id},'privacy_review_started')`;
  });
}
