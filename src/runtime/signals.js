/**
 * Control-flow signals the ported service layer throws.
 *
 * `redirect()` and `notFound()` work by throwing in Next.js, and the ported
 * code relies on that: `redirect('/partner')` after a successful action means
 * "we are done, send the user here", and the lines below it never run. An API
 * server has no navigation, but the *intent* is still meaningful to the
 * client, so we carry it across the wire instead of discarding it.
 */
export class RedirectSignal extends Error {
  constructor(location) {
    super(`REDIRECT ${location}`);
    this.name = 'RedirectSignal';
    this.location = location;
  }
}

export class NotFoundSignal extends Error {
  constructor() {
    super('NOT_FOUND');
    this.name = 'NotFoundSignal';
  }
}

export const isRedirect = (e) => e instanceof RedirectSignal;
export const isNotFound = (e) => e instanceof NotFoundSignal;
