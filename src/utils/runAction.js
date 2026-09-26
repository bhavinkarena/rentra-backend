import { isRedirect, isNotFound } from '@/runtime/signals.js';
import { toFormData } from './formData.js';
import { ok, fail, redirected } from './respond.js';
import { notFound } from './apiError.js';
import { asyncHandler } from './asyncHandler.js';

/**
 * Adapter between an Express route and a ported Server Action.
 *
 * The actions have three ways of finishing and all three are meaningful:
 *
 *   · return an object with `errors`  → the form failed validation (422),
 *     and the rest of the object is the state the form needs to re-render,
 *     so it is returned alongside rather than thrown away.
 *   · throw a RedirectSignal          → success, and here is where to go next.
 *   · return anything else            → success with a payload.
 *
 * `formArgs` controls the call shape: actions written for `useActionState`
 * take `(previousState, formData)`, a handful take just `(formData)`, and the
 * newer ones take a plain object. See the per-route wiring in src/controllers.
 */
export function runAction(action, { style = 'state' } = {}) {
  // Express 4 ignores a rejected async handler; without this an unexpected
  // error (a failed query, a missing table) hangs the request until timeout.
  return asyncHandler(async function handler(req, res) {
    let result;

    try {
      result = await invoke(action, style, req);
    } catch (error) {
      if (isRedirect(error)) return redirected(res, error.location);
      if (isNotFound(error)) throw notFound();
      throw error;
    }

    if (result && typeof result === 'object' && result.errors) {
      const { errors, ...state } = result;
      return fail(res, {
        status: 422,
        code: 'VALIDATION_FAILED',
        message: 'Check the highlighted fields.',
        fields: errors,
        data: Object.keys(state).length ? state : undefined,
      });
    }

    /**
     * Several actions signal a domain refusal with a bare `{ error: '...' }`
     * — not a field problem, but not success either. 400 rather than 422,
     * because there is no field for the client to highlight.
     */
    if (result && typeof result === 'object' && typeof result.error === 'string') {
      const { error, ...state } = result;
      return fail(res, {
        status: result.status ?? 400,
        code: result.code ?? 'ACTION_REJECTED',
        message: error,
        data: Object.keys(state).length ? state : undefined,
      });
    }

    return ok(res, result ?? null);
  });
}

function invoke(action, style, req) {
  switch (style) {
    /** (previousState, formData) — the useActionState signature. */
    case 'state':
      return action(null, toFormData(req));
    /** (formData) only. */
    case 'form':
      return action(toFormData(req));
    /** (input) — a plain object, already JSON. */
    case 'input':
      return action(req.body);
    /** () — no arguments at all. */
    case 'none':
      return action();
    default:
      throw new Error(`Unknown action style: ${style}`);
  }
}
