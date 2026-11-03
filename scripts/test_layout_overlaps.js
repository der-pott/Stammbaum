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
const noopEl = { setAttribute(){}, appendChild(){}, addEventListener(){}, textContent:'', style:{}, classList: { add(){}, remove(){} }, dataset: {}, hidden: false };
noopEl.getContext = () => ({ measureText: (s) => ({ width: String(s).length * 7 }), save(){}, restore(){}, clearRect(){}, translate(){}, rotate(){}, scale(){}, drawImage(){} });
const win = {
  addEventListener(){}, removeEventListener(){},
  matchMedia: () => ({ matches: false, addListener(){}, removeListener(){} }),
  location: { hash: '' },
  localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
  dispatchEvent(){}, requestAnimationFrame: () => 0,
};
const sandbox = {
  state: { persons: tree.persons, edges: tree.edges },
  window: win,
  document: {
    getElementById: () => null,
    createElementNS: () => ({ ...noopEl }),
    createElement: () => ({ ...noopEl }),
    addEventListener(){}, removeEventListener(){},
    body: { ...noopEl },
    documentElement: { ...noopEl, dataset: {} },
    querySelector: () => null, querySelectorAll: () => [],
  },
  console,
  Map, Set,
  requestAnimationFrame: () => 0,
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' }),
  localStorage: win.localStorage,
  URL, URLSearchParams,
  Image: class { constructor(){ this.onload = null; } set src(_){} get src(){ return ''; } },
  MutationObserver: class { constructor(_){} observe(){} disconnect(){} takeRecords(){ return []; } },
  IntersectionObserver: class { constructor(_){} observe(){} disconnect(){} unobserve(){} },
  ResizeObserver: class { constructor(_){} observe(){} disconnect(){} unobserve(){} },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.OffscreenCanvas = undefined;
sandbox.location = { hash: '', search: '', pathname: '/', href: 'https://stammbaum.p-m-pott.de/' };

sandbox.__persons = tree.persons;
sandbox.__edges = tree.edges;
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'stammbaum.js' });
// The module's own `const state = {...}` shadows our sandbox.state. We mutate
// that module-scoped state here from the test harness, then call computeLayout.
vm.runInContext(`state.persons = __persons; state.edges = __edges;`, ctx);

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
