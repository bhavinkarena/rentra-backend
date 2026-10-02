import { requireClient } from '../auth/dal.js';
import { bookingActor } from '../booking/record-page.js';
export async function supportActor(kind) {
  return kind === 'owner' ? { kind, id: (await requireClient()).id } : bookingActor(kind);
}
