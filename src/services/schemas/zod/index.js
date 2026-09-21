export * from './booking';
export * from './listing';

/**
 * Turn a ZodError into the flat { field: message } shape a form wants.
 * Use in Server Actions so the client gets field errors, not a stack trace.
 */
export function fieldErrors(zodError) {
  const out = {};
  for (const issue of zodError.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
