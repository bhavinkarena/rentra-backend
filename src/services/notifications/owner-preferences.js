import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { OWNER_CATEGORIES, REQUIRED_CATEGORIES, ownerPreferences } from './owner-domain.js';
export async function readOwnerNotificationPreferences(database,id,env=process.env) {
  const [u]=await database`SELECT notification_prefs,profile_version,email_verified_at,phone_verified_at FROM "user" WHERE id=${id} AND role='client'`;
  if(!u) throw notFound();
  const failures=await database`SELECT DISTINCT channel,failure_code FROM owner_notification WHERE user_id=${id} AND (state IN ('blocked','failed','unknown') OR (state='accepted' AND failure_code IS NOT NULL)) ORDER BY channel,failure_code LIMIT 10`;
  return {deliveryEnabled:env.OWNER_NOTIFICATION_DELIVERY==='enabled',preferences:ownerPreferences(u.notification_prefs),version:u.profile_version,categories:OWNER_CATEGORIES,required:REQUIRED_CATEGORIES,verified:{email:Boolean(u.email_verified_at),mobile:Boolean(u.phone_verified_at)},failures};
}
export async function saveOwnerNotificationPreferences(database,id,input) {
  const parsed=z.object({expectedVersion:z.coerce.number().int().min(0),preferences:z.record(z.enum(OWNER_CATEGORIES),z.object({mobile:z.boolean(),email:z.boolean()}).strict())}).safeParse(input);
  if(!parsed.success) throw unprocessable({preferences:'Choose the listed notification settings.'});
  const prefs=ownerPreferences(parsed.data.preferences);
  for(const category of REQUIRED_CATEGORIES) if(!prefs[category].mobile && !prefs[category].email) throw unprocessable({[category]:'Keep mobile or email on for new bookings and tasks that need you.'});
  return database.begin(async tx=>{
    const [u]=await tx`SELECT profile_version FROM "user" WHERE id=${id} AND role='client' FOR UPDATE`;
    if(!u) throw notFound();
    if(u.profile_version!==parsed.data.expectedVersion) throw conflict('PREFERENCES_CHANGED','Settings changed in another tab. Reload before saving.');
    await tx`UPDATE "user" SET notification_prefs=${JSON.stringify(prefs)}::text::jsonb,profile_version=profile_version+1,updated_at=now() WHERE id=${id}`;
    return {message:'Notification settings saved.',version:u.profile_version+1};
  });
}
