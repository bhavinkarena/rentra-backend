import 'server-only';
import { notFound } from 'next/navigation';
import { supportActor } from './actor.js';
import { sql } from '../db/index.js';
import { readSupportRequest } from './service.js';
export async function supportRecordPage(kind, id) {
  const actor = await supportActor(kind);
  try { return await readSupportRequest(sql, actor, id); }
  catch (error) { if (error.code === 'NOT_FOUND' || error.name === 'ZodError') notFound(); throw error; }
}
