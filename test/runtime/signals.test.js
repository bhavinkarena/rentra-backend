import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redirect, notFound } from '@/runtime/navigation-test-entry.js';
import { isRedirect, isNotFound } from '@/runtime/signals.js';
import { runWithContext, getContext } from '@/runtime/context.js';
import { revalidatePath } from '@/runtime/next-cache.js';

/**
 * `redirect()` works by throwing in Next.js and the ported code depends on
 * that: nothing after it runs. If it ever stopped throwing, an action that
 * redirects on failure would continue into the success path.
 */
test('redirect throws, and carries the location', () => {
  assert.throws(
    () => redirect('/partner'),
    (error) => isRedirect(error) && error.location === '/partner',
  );
});

test('notFound throws its own distinguishable signal', () => {
  assert.throws(
    () => notFound(),
    (error) => isNotFound(error) && !isRedirect(error),
  );
});

test('revalidatePath collects paths per request, not globally', async () => {
  await runWithContext({}, async () => {
    revalidatePath('/partner/settings');
    revalidatePath('/partner');
    revalidatePath('/partner');
    assert.deepEqual([...getContext().revalidate], ['/partner/settings', '/partner']);
  });

  /** A second request must start clean — otherwise one user's paths leak. */
  await runWithContext({}, async () => {
    assert.equal(getContext().revalidate.size, 0);
  });
});

test('outside a request, revalidatePath is inert rather than fatal', () => {
  assert.doesNotThrow(() => revalidatePath('/anywhere'));
});
