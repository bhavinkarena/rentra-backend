// No HTTP: stored local evidence survives calls and models lost responses and late success.
export function payoutTransferProvider() {
  const rows = new Map(),
    calls = [];
  return {
    kind: 'local-payout-fixture',
    provider: 'local-fixture',
    account: 'local-fixture-account',
    rows,
    calls,
    outcome: 'succeeded',
    loseResponse: false,
    async create(identity) {
      calls.push({ kind: 'create', identity });
      rows.set(identity.operationId, { ...identity, status: this.outcome });
      if (this.loseResponse) throw new Error('Lost fixture response');
    },
    async lookup(identity) {
      calls.push({ kind: 'lookup', identity });
      return rows.get(identity.operationId) ?? null;
    },
  };
}
