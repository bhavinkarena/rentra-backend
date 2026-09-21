/**
 * Minimal structured logging.
 *
 * Deliberately not a logging framework: this server handles KYC documents,
 * phone numbers and payment identifiers, and the cheapest way to keep those
 * out of a log aggregator is to have no mechanism that dumps whole objects.
 * Pass a short message and named scalars.
 */
const time = () => new Date().toISOString();

export const logger = {
  info: (msg, fields) => console.log(format('info', msg, fields)),
  warn: (msg, fields) => console.warn(format('warn', msg, fields)),
  error: (msg, fields) => console.error(format('error', msg, fields)),
};

function format(level, msg, fields) {
  const tail = fields
    ? ' ' +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  return `${time()} [${level}] ${msg}${tail}`;
}
