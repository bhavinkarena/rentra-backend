import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incidentRemedy } from '../../src/services/domain/incident-remedy.js';

const paid = { rent: 9500, fee: 500, tax: 0 };
const half = { rent: 4750, fee: 250, tax: 0 };
const run = (extra) =>
  incidentRemedy({ paid, counted: half, targetPct: 100, responsibility: 'proportional', ...extra });

test('Story 4.4 remedy maths: mockup example and matrix', () => {
  const p = run();
  assert.equal(p.additionalDueMinor, 5000);
  assert.equal(p.owner.increaseMinor, 4750);
  assert.equal(p.owner.totalMinor, 9500);
  assert.equal(p.rentra.totalMinor, 500);
  assert.equal(p.reassignedFromRentraMinor, 0);
  assert.equal(p.rentra.retainedFeeMinor, 0);

  const o = run({ responsibility: 'owner_funded' });
  assert.equal(o.additionalDueMinor, 5000);
  assert.equal(o.owner.totalMinor, 10000);
  assert.equal(o.owner.increaseMinor, 5250);
  assert.equal(o.reassignedFromRentraMinor, 250);
  assert.equal(o.owner.exceedsProceedsMinor, 500);
  assert.equal(o.rentra.totalMinor, 0);
  assert.equal(o.rentra.retainedFeeMinor, 500);

  const visits = [{ rentMinor: 9500, paidOut: true }];
  assert.equal(run({ visits, recoveredMinor: 2000 }).projectedRecoveryMinor, 7500);
  assert.equal(
    run({ visits, recoveredMinor: 2000, responsibility: 'owner_funded' }).projectedRecoveryMinor,
    8000,
  );
  assert.equal(run({ visits: [{ rentMinor: 9500, paidOut: false }] }).projectedRecoveryMinor, 0);

  const low = run({ targetPct: 30 });
  assert.equal(low.additionalDueMinor, 0);
  assert.equal(low.providerCall, false);
  assert.equal(low.owner.totalMinor, 4750, 'no clawback');

  // An in-flight 1000 counts like any other earlier refund.
  const inflight = incidentRemedy({
    paid,
    counted: { rent: 950, fee: 50, tax: 0 },
    targetPct: 50,
    responsibility: 'proportional',
  });
  assert.equal(inflight.additionalDueMinor, 4000);
});

test('Story 4.4 remedy maths: no fee moves when nothing more is paid', () => {
  const o = run({ targetPct: 30, responsibility: 'owner_funded' });
  assert.equal(o.additionalDueMinor, 0);
  assert.equal(o.reassignedFromRentraMinor, 0);
  assert.equal(o.owner.totalMinor, 4750);
});

test('Story 4.4 remedy maths: owner share weighted over visits', () => {
  const p = incidentRemedy({
    paid: { rent: 9000, fee: 0, tax: 0 },
    counted: { rent: 0, fee: 0, tax: 0 },
    targetPct: 100,
    responsibility: 'proportional',
    visits: [
      { rentMinor: 6000, paidOut: true },
      { rentMinor: 3000, paidOut: false },
    ],
  });
  assert.equal(p.projectedRecoveryMinor, 6000);
});

test('Story 4.4 remedy maths: tax is its own line, in no share', () => {
  const p = incidentRemedy({
    paid: { rent: 9000, fee: 500, tax: 500 },
    counted: { rent: 0, fee: 0, tax: 0 },
    targetPct: 100,
    responsibility: 'owner_funded',
  });
  assert.equal(p.additionalDueMinor, 10000);
  assert.equal(p.taxMinor, 500);
  assert.equal(p.owner.totalMinor, 9500);
  assert.equal(p.rentra.totalMinor, 0);
  const q = incidentRemedy({
    ...{ paid: { rent: 9000, fee: 500, tax: 500 }, counted: { rent: 0, fee: 0, tax: 0 } },
    targetPct: 100,
    responsibility: 'proportional',
  });
  assert.equal(q.owner.totalMinor + q.rentra.totalMinor + q.taxMinor, 10000);
  assert.equal(q.rentra.totalMinor, 500);
});
