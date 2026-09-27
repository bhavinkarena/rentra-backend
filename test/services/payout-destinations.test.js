import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskUpi,
  maskedDestination,
  nameCheck,
  payoutReadiness,
  VERIFICATION_AVAILABLE,
} from '../../src/services/domain/payout-destinations.js';

test('CP21 masking never shows more than a UPI prefix or the last four digits', () => {
  assert.equal(maskUpi('farmowner@okaxis'), 'fa•••••••@okaxis');
  assert.equal(maskUpi('ab@ybl'), 'ab•••@ybl');
  assert.equal(maskUpi('not-a-vpa'), null);
  assert.equal(
    maskedDestination({ method: 'bank', account_last4: '6789', ifsc: 'SBIN0001234' }),
    'Bank •••• 6789 · SBIN0001234',
  );
  assert.equal(
    maskedDestination({ method: 'upi', upi_id: 'farmowner@okaxis' }),
    'UPI fa•••••••@okaxis',
  );
});

test('CP21 a name comparison is a hint, never verification', () => {
  assert.equal(nameCheck('Asha  Patel', 'asha patel'), 'same');
  assert.equal(nameCheck('Asha Patel', 'Ravi Patel'), 'different');
  assert.equal(nameCheck('', 'Ravi Patel'), 'unknown');
  assert.equal(VERIFICATION_AVAILABLE, false);
  for (const state of ['submitted', 'draft']) assert.equal(payoutReadiness({ state }).ready, false);
  assert.match(payoutReadiness({ state: 'submitted' }).reason, /not available yet/);
  assert.match(payoutReadiness({ state: 'failed' }).reason, /Submit a new destination/);
  assert.equal(payoutReadiness(null).ready, false);
  assert.equal(payoutReadiness({ state: 'verified' }).ready, true);
});
