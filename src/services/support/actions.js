'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { supportActor } from './actor.js';
import { sql } from '../db/index.js';
import {
  createSupportRequest,
  replySupportRequest,
  addSupportNote,
  manageSupportRequest,
  SupportError,
} from './service.js';
import { previewIncidentRemedy, decideIncidentRemedy, executeIncidentAward } from './remedy.js';
import {
  createIncidentRepaymentLink,
  checkIncidentRepaymentLink,
  resolveIncidentRepaymentLink,
} from '../finance/owner-repayment.js';

/** Story 4.1: each `affected` checkbox is a visit id, or `visitId|roomTypeId` for one hotel room line. */
const stayIssueFields = (form) => ({
  issueType: form.get('issueType'),
  discoveredAt: form.get('discoveredAt'),
  affected: form.getAll('affected').map((value) => {
    const [visitId, roomTypeId = null] = String(value).split('|');
    return { visitId, roomTypeId };
  }),
  remedy: form.get('remedy'),
  remedyText: form.get('remedyText') || null,
  lateReason: form.get('lateReason') || null,
});
async function open(kind, form) {
  const actor = await supportActor(kind);
  let result;
  try {
    result = await createSupportRequest(sql, actor, {
      category: form.get('category'),
      subject: form.get('subject') || null,
      body: form.get('body'),
      orderId: form.get('orderId') || null,
      privacyRequestId: form.get('privacyRequestId') || null,
      propertyId: form.get('propertyId') || null,
      visitId: form.get('visitId') || null,
      stayIssue: form.get('category') === 'stay_issue' ? stayIssueFields(form) : null,
      requestKey: form.get('requestKey'),
    }, process.env, form.getAll('photos'));
  } catch (error) {
    if (error instanceof SupportError) throw error;
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
  revalidatePath('/support');
  revalidatePath('/admin/support');
  redirect((kind === 'owner' ? '/partner/support/' : '/support/') + result.id);
}
async function reply(kind, form) {
  const actor = await supportActor(kind);
  try {
    const result = await replySupportRequest(
      sql,
      actor,
      {
        id: form.get('id'),
        body: form.get('body'),
        state: form.get('state'),
        version: Number(form.get('version')),
        requestKey: form.get('requestKey'),
      },
      process.env,
      form.getAll('photos'),
    );
    for (const base of ['/support', '/admin/support', '/partner/support']) {
      revalidatePath(base);
      revalidatePath(`${base}/${result.id}`);
    }
    return { message: 'Posted to the support case.' };
  } catch (error) {
    if (error instanceof SupportError) throw error;
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
}
export async function replyCustomerSupport(previous, form) {
  return reply('customer', form);
}
export async function replyAdminSupport(previous, form) {
  return reply('admin', form);
}
export async function noteAdminSupport(previous, form) {
  try {
    const result = await addSupportNote(
      sql,
      await supportActor('admin'),
      { id: form.get('id'), body: form.get('body'), requestKey: form.get('requestKey') },
      process.env,
      form.getAll('photos'),
    );
    revalidatePath('/admin/support');
    revalidatePath('/admin/support/' + result.id);
    return { message: 'Private note saved. Only Rentra admins can see it.' };
  } catch (error) {
    if (error instanceof SupportError) throw error;
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
}

export async function openSupport(previous, form) {
  return open('customer', form);
}
export async function openOwnerSupport(previous, form) {
  return open('owner', form);
}
export async function replyOwnerSupport(previous, form) {
  return reply('owner', form);
}
export async function manageSupport(previous, form) {
  try {
    const result = await manageSupportRequest(sql, await supportActor('admin'), {
      id: form.get('id'),
      version: Number(form.get('version')),
      assignedTo: form.get('assignedTo') || null,
      priority: form.get('priority'),
      relatedRequestId: form.get('relatedRequestId') || null,
      reason: form.get('reason'),
    });
    revalidatePath('/admin/support');
    revalidatePath('/admin/support/' + result.id);
    return { message: 'Assignment and case details saved.' };
  } catch (error) {
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
}

/* Story 4.4: incident remedy preview and reviewed decision. Refusals return the fresh preview on PREVIEW_CHANGED. */
const remedyFields = (form) => ({
  supportRequestId: form.get('id'),
  // Absent visitIds = the reported visits; an empty or missing % stays undefined so validation refuses it.
  visitIds: form.has('visitIds') ? form.getAll('visitIds').map(String).filter(Boolean) : undefined,
  targetPct: form.get('targetPct') || undefined,
  responsibility: form.get('responsibility') || undefined,
});
async function remedyCall(run) {
  try {
    return await run();
  } catch (error) {
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    if (error.isOperational && error.code !== 'NOT_FOUND')
      return { error: error.message, code: error.code, status: error.statusCode, ...(error.fields ? { errors: error.fields } : {}), ...(error.preview ? { preview: error.preview } : {}) };
    throw error;
  }
}
export async function previewRemedy(previous, form) {
  return remedyCall(async () => ({ preview: await previewIncidentRemedy(sql, await supportActor('admin'), remedyFields(form)) }));
}
export async function decideRemedy(previous, form) {
  return remedyCall(async () => {
    const decision = await decideIncidentRemedy(sql, await supportActor('admin'), {
      ...remedyFields(form),
      kind: form.get('kind'),
      reason: form.get('reason'),
      digest: form.get('digest') || undefined,
      requestKey: form.get('requestKey'),
    });
    return { decision, message: 'Saved. Execute the award to queue the Test refund.' };
  });
}

/* Story 4.5: execute the active award (Test); PREVIEW_CHANGED returns the fresh figures. */
export async function executeRemedy(previous, form) {
  return remedyCall(async () => {
    const execution = await executeIncidentAward(sql, await supportActor('admin'), {
      decisionId: form.get('decisionId'),
      digest: form.get('digest'),
      requestKey: form.get('requestKey'),
    });
    return { execution, message: execution.replayed ? 'Already executed with this request.' : 'Award executed (Test).' };
  });
}
export async function incidentRepaymentLink(previous, form) {
  return remedyCall(async () => ({
    link: await createIncidentRepaymentLink(sql, await supportActor('admin'), form.get('id'), form.get('obligationId'), { requestKey: form.get('requestKey') }),
    message: 'Test repayment link created.',
  }));
}
export async function incidentRepaymentCheck(previous, form) {
  return remedyCall(async () => ({
    check: await checkIncidentRepaymentLink(sql, await supportActor('admin'), form.get('id'), form.get('obligationId')),
    message: 'Provider re-checked (Test).',
  }));
}
export async function incidentRepaymentResolve(previous, form) {
  return remedyCall(async () => ({
    link: await resolveIncidentRepaymentLink(sql, await supportActor('admin'), form.get('id'), form.get('obligationId'), {
      linkId: form.get('linkId'),
      reason: form.get('reason'),
    }),
    message: 'Link closed. Create a new link if the obligation is still due.',
  }));
}
