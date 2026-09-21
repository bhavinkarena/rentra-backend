import { createApp } from '@/app.js';

/**
 * Print every mounted route.
 *
 * Exists because the routing table is the API's contract with the frontend,
 * and a contract nobody can read drifts. `npm run routes` is the fastest way
 * to check that a route you just added is actually reachable at the path you
 * think it is.
 */
const app = createApp();
const rows = [];

collect(app._router?.stack ?? app.router?.stack ?? [], '');

rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
for (const { method, path } of rows) {
  console.log(`${method.padEnd(6)} ${path}`);
}
console.log(`\n${rows.length} routes`);

function collect(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        rows.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
      continue;
    }
    if (layer.name === 'router' && layer.handle?.stack) {
      collect(layer.handle.stack, prefix + mountPath(layer));
    }
  }
}

/** Express stores the mount path as a regex; recover the literal prefix. */
function mountPath(layer) {
  const source = layer.regexp?.source ?? '';
  if (source === '^\\/?$' || layer.regexp?.fast_slash) return '';
  const match = source.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/);
  return match ? '/' + match[1].replace(/\\\//g, '/') : '';
}
