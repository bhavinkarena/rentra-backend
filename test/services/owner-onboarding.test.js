import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileCompletion } from '../../src/services/auth/profile.js';
import {
  onboardingPayoutSchema,
  payoutSchema,
} from '../../src/services/schemas/zod/application.js';
import { guideInput } from '../../src/services/auth/owner-guide.js';

test('four-step verification accepts mobile sign-in, retains flagged corrections and explains rejections', () => {
  const user = {
    accountStatus: 'pending_application',
    name: 'Test Owner',
    clientType: 'owner',
    phoneVerifiedAt: new Date(),
  };
  const app = {
    status: 'draft',
    residentialAddress: '123 Main Street',
    kycDocType: 'pan_card',
    kycNameOnDoc: 'Test Owner',
    payoutUpiId: 'owner@bank',
    consentAt: new Date(),
  };
  const docs = [{ docType: 'pan_card', side: 'front', status: 'uploaded' }];
  let completion = profileCompletion(user, app, docs);
  assert.equal(completion.total, 4);
  assert.equal(completion.canSubmit, true, 'email is not required for a mobile account');
  completion = profileCompletion(
    user,
    { ...app, status: 'more_info_needed', flaggedFields: ['phone', 'kyc'] },
    docs,
  );
  assert.deepEqual(
    completion.remaining.map((s) => s.id),
    ['details', 'kyc'],
  );
  assert.equal(completion.canSubmit, false);
  completion = profileCompletion(
    user,
    { ...app, status: 'rejected', decisionReason: 'ID was unreadable', strikeCount: 2 },
    docs,
  );
  assert.equal(completion.status, 'rejected');
  assert.equal(completion.strikesLeft, 1);
  assert.equal(completion.decisionReason, 'ID was unreadable');
  assert.equal(
    profileCompletion({ ...user, accountStatus: 'blocked' }, app, docs).canSubmit,
    false,
  );
  assert.equal(profileCompletion(user, app, [{ ...docs[0], status: 'rejected' }]).canSubmit, false);
});

test('bank confirmation normalizes separators; guide state rejects unknown keys and client timestamps', () => {
  const bank = {
    method: 'bank',
    holderName: 'Test Owner',
    accountNumber: '1234-5678 9012',
    confirmAccountNumber: '123456789012',
    ifsc: 'sbin0001234',
  };
  assert.equal(onboardingPayoutSchema.parse(bank).accountNumber, '123456789012');
  assert.equal(
    onboardingPayoutSchema.safeParse({ ...bank, confirmAccountNumber: '123456789013' }).success,
    false,
  );
  assert.equal(
    payoutSchema.safeParse({ ...bank, confirmAccountNumber: undefined }).success,
    true,
    'other payout callers do not need onboarding confirmation',
  );
  assert.equal(
    guideInput.safeParse({ intendedVertical: 'entertainment', welcomeSeenAt: true }).success,
    true,
  );
  assert.equal(guideInput.safeParse({ accountStatus: 'active' }).success, false);
  assert.equal(guideInput.safeParse({ welcomeSeenAt: '2026-10-02' }).success, false);
});
