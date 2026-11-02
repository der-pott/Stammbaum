#!/usr/bin/env node
// Headless layout overlap regression check.
//
// Fetches /api/tree from a running instance (default: production), runs the
// SAME computeLayout() the browser does (loaded straight from
// public/stammbaum.js via a tiny shim), and reports overlapping node bboxes.
//
// Usage:
//   node scripts/test_layout_overlaps.js                 # https://stammbaum.p-m-pott.de
//   BASE=http://localhost:8080 node scripts/test_layout_overlaps.js
//   PIN=060481 node scripts/test_layout_overlaps.js
//
// Exits 0 on clean layout, 1 on overlaps.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'https://stammbaum.p-m-pott.de';
const PIN  = process.env.PIN  || '060481';
const ROLE = process.env.ROLE || 'viewer';

// --- Login + fetch tree ------------------------------------------------
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ role: ROLE, pin: PIN }),
});
const setCookie = loginRes.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
if (!cookie) { console.error('login failed'); process.exit(2); }
const treeRes = await fetch(`${BASE}/api/tree`, { headers: { cookie } });
const tree = await treeRes.json();

// --- Load computeLayout from public/stammbaum.js via sandbox -----------
const src = readFileSync(join(here, '..', 'public', 'stammbaum.js'), 'utf8');

// Browser globals the layout code expects. The layout path only touches
// state.persons/edges, uses measureText (stubbed), and some DOM accessors
// via renderTree — but we only need computeLayout().
const sandbox = {
  state: { persons: tree.persons, edges: tree.edges },
  // Minimal browser shims so the module loads.
  window: {}, document: {
    getElementById: () => null,
    createElementNS: () => ({ setAttribute(){}, appendChild(){}, textContent:'', style:{} }),
    createElement: () => ({ setAttribute(){}, appendChild(){}, textContent:'', style:{}, getContext: () => ({ measureText: (s) => ({ width: s.length * 7 }) }) }),
  },
  console,
  Map, Set,
};
sandbox.OffscreenCanvas = undefined;

const ctx = vm.createContext(sandbox);
// Extract just the body up through the end of computeLayout(). Simpler:
// strip import/export and run the whole file. Any browser-only side effects
// are harmless because document/window are stubbed.
vm.runInContext(src, ctx, { filename: 'stammbaum.js' });

// computeLayout is defined at module scope.
const layout = ctx.computeLayout?.();
if (!layout) { console.error('computeLayout returned null'); process.exit(2); }

const n = layout.overlaps.length;
if (n === 0) {
  console.log(`✓ layout clean — ${layout.nodes.length} nodes, no overlaps`);
  process.exit(0);
}
console.error(`✗ ${n} overlap(s):`);
for (const o of layout.overlaps.slice(0, 25)) {
  console.error(`  ${o.aName}  ↔  ${o.bName}`);
}
if (n > 25) console.error(`  … and ${n - 25} more`);
process.exit(1);
