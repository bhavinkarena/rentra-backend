/**
 * What a refund obligation's state means for an operator (CP20). Pure.
 *
 * Only a provider-verified outcome is "refunded". Everything else says what is
 * known, what Rentra will and will not do, and whether a command can help.
 * There is never a second provider refund for an uncertain or failed first
 * one: the obligation keeps its reservation until the provider's own record
 * resolves it.
 */

export const PROVIDER_FAILED = 'PROVIDER_REFUND_FAILED';

export function refundStatus(refund) {
  const testProvider = refund.provider === 'razorpay' && refund.environment === 'test' && refund.mode === 'real';
  if (refund.mode === 'simulated') {
    return {
      key: 'simulated',
      label: 'Simulated',
      tone: 'neutral',
      explanation: 'A simulated refund: no money moved and no provider is involved.',
      recovery: null,
      command: null,
    };
  }
  if (refund.state === 'succeeded') {
    return {
      key: 'refunded',
      label: 'Refunded · verified',
      tone: 'success',
      explanation: 'The provider confirmed this refund as processed. The verified amount is final.',
      recovery: null,
      command: null,
    };
  }
  if (!testProvider) {
    return {
      key: 'unsupported',
      label: 'Needs the live refund process',
      tone: 'danger',
      explanation: 'This refund is outside the Razorpay Test environment. Rentra cannot send or check it here.',
      recovery: 'Live refunds are handled by the live finance process, not this console.',
      command: null,
    };
  }
  if (refund.state === 'requested' && !refund.dispatchedAt) {
    return {
      key: 'queued',
      label: 'Queued',
      tone: 'warning',
      explanation: 'Not sent to Razorpay yet. The refund worker sends it automatically.',
      recovery: 'Send it now instead of waiting for the worker. It is sent only once.',
      command: 'send',
    };
  }
  if (refund.failureCode === PROVIDER_FAILED) {
    return {
      key: 'provider_failed',
      label: 'Failed at provider',
      tone: 'danger',
      explanation:
        'Razorpay reports this refund failed. The amount stays reserved, so it cannot be refunded twice, and Rentra will not send another refund for it.',
      recovery: 'Resolve it with Razorpay support, then check again. The provider’s record decides the outcome.',
      command: 'check',
    };
  }
  if (refund.state === 'unknown' || refund.failureCode) {
    return {
      key: 'uncertain',
      label: 'Uncertain',
      tone: 'danger',
      explanation: `Rentra could not confirm whether Razorpay received or processed this refund${refund.failureCode ? ` (${refund.failureCode})` : ''}. It looks the refund up; it never sends a second refund for it.`,
      recovery: 'Check with the provider. The worker also keeps checking.',
      command: 'check',
    };
  }
  return {
    key: 'processing',
    label: 'Processing at provider',
    tone: 'info',
    explanation: 'Razorpay accepted the refund. It is not refunded until Razorpay reports it processed.',
    recovery: 'Check with the provider for the latest status. Nothing is resent.',
    command: 'check',
  };
}

/**
 * Split a requested amount per component over the visit's verified captures,
 * never past what earlier refunds (pending or done) already reserved.
 * Returns the refund lines, or the components that exceed what remains.
 */
export function allocateAdditionalRefund(sources, requested) {
  const lines = [];
  const exceeded = {};
  for (const component of ['rent', 'fee', 'deposit']) {
    let left = Math.max(0, Math.trunc(Number(requested[component] ?? 0)));
    const own = sources.filter((s) => s.component === component);
    const available = own.reduce((sum, s) => sum + Math.max(0, Number(s.actual_minor) - Number(s.reserved)), 0);
    if (left > available) exceeded[component] = available;
    for (const source of own) {
      if (!left) break;
      const take = Math.min(left, Math.max(0, Number(source.actual_minor) - Number(source.reserved)));
      if (take > 0) {
        lines.push({ allocationId: source.id, transactionId: source.transaction_id, component, amount: take });
        left -= take;
      }
    }
  }
  return { lines, exceeded };
}
