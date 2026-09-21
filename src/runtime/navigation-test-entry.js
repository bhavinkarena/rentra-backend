/**
 * Re-export of the navigation shim under a plain filename.
 *
 * The loader maps the bare specifier `next/navigation` to next-navigation.js,
 * but a test importing that file by path bypasses the loader — this entry
 * exists so the tests exercise exactly the module the shim resolves to,
 * without depending on the alias to do it.
 */
export { redirect, permanentRedirect, notFound } from './next-navigation.js';
