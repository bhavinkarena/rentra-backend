/**
 * Boot-time module loader registration.
 *
 * Registered with `node --import ./loader/register.mjs`. Must run before any
 * application module is imported, which is why it cannot live inside src/.
 */
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
