#!/usr/bin/env node
// Semantic ego-centred layout verification.
//
// Loads the same computeLayout() the browser uses (from public/stammbaum.js),
// runs it against the live tree, and asserts all ego-layout invariants.
//
// Usage:
//   PIN=060481 node scripts/test_ego_layout.js
//   BASE=http://localhost:8080 PIN=060481 node scripts/test_ego_layout.js
//
// Exits 0 on all pass, 1 on any failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'https://stammbaum.p-m-pott.de';
const PIN  = process.env.PIN  || '060481';
const ROLE = process.env.ROLE || 'viewer';

const EGO_ID     = '4c504882-f2e3-409a-b51e-c2b56c218256';
const LEONARD_ID = '4b8c2477-b44e-451d-90f4-79df36f86bda';
const VALID_SIDES = new Set(['left', 'right', 'center', 'none']);

// --- Login + fetch tree -------------------------------------------------------
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ role: ROLE, pin: PIN }),
});
const setCookie = loginRes.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
if (!cookie) { console.error('login failed — check PIN'); process.exit(2); }

const treeRes = await fetch(`${BASE}/api/tree`, { headers: { cookie } });
const tree = await treeRes.json();

// --- Load computeLayout from public/stammbaum.js via sandbox -----------------
const src = readFileSync(join(here, '..', 'public', 'stammbaum.js'), 'utf8');

const noopEl = {
  setAttribute(){}, appendChild(){}, addEventListener(){}, textContent: '',
  style: {}, classList: { add(){}, remove(){} }, dataset: {}, hidden: false,
};
noopEl.getContext = () => ({
  measureText: (s) => ({ width: String(s).length * 7 }),
  save(){}, restore(){}, clearRect(){}, translate(){}, rotate(){}, scale(){}, drawImage(){},
});
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

sandbox.__persons = tree.persons;
sandbox.__edges = tree.edges;
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'stammbaum.js' });
vm.runInContext(`state.persons = __persons; state.edges = __edges;`, ctx);

const layout = ctx.computeLayout?.();
if (!layout) { console.error('computeLayout returned null'); process.exit(2); }

const { nodes, posById, overlaps, totalW } = layout;
let allPass = true;

function pass(msg) { console.log(`✓ ${msg}`); }
function fail(msg) { console.log(`✗ ${msg}`); allPass = false; }

// --- Assertion 1: Ego resolved -----------------------------------------------
const egoNode = posById.get(EGO_ID);
if (egoNode) {
  pass(`Ego resolved — cx=${egoNode.cx.toFixed(1)}, cy=${egoNode.cy.toFixed(1)}, side=${egoNode.side}`);
} else {
  fail(`Ego not resolved — id ${EGO_ID} not in posById`);
  // Remaining checks depend on ego; bail out early.
  process.exit(1);
}

// --- Assertion 2: .side present on all nodes ---------------------------------
const missingSide = nodes.filter(n => !VALID_SIDES.has(n.side));
if (missingSide.length === 0) {
  pass(`node.side present and valid on all ${nodes.length} nodes`);
} else {
  fail(`node.side missing or invalid on ${missingSide.length} node(s): ${missingSide.slice(0,5).map(n => n.id).join(', ')}`);
}

// --- Assertion 3: Left-side nodes — at least 5 (full Pott subtree propagated) -
const leftNodes = nodes.filter(n => n.side === 'left');
const leftFailing = leftNodes.filter(n => n.cx >= egoNode.cx + 20);
if (leftNodes.length >= 5 && leftFailing.length === 0) {
  pass(`Pott-ancestors (left): ${leftNodes.length} node(s) >= 5, all cx < egoNode.cx + 20`);
} else {
  if (leftNodes.length < 5) fail(`Pott-ancestors (left): only ${leftNodes.length} node(s) tagged left — BFS propagation may still be broken (expected >= 5)`);
  if (leftFailing.length > 0) fail(`Pott-ancestors (left): ${leftNodes.length} total, ${leftFailing.length} fail x-check (cx >= egoNode.cx+20): ${leftFailing.slice(0,3).map(n => `${n.person?.given_name} ${n.person?.surname} cx=${n.cx.toFixed(1)}`).join('; ')}`);
}

// --- Assertion 4: Right-side nodes — at least 5 (full Sehnke subtree propagated)
const rightNodes = nodes.filter(n => n.side === 'right');
const rightFailing = rightNodes.filter(n => n.cx <= egoNode.cx - 20);
if (rightNodes.length >= 5 && rightFailing.length === 0) {
  pass(`Sehnke-ancestors (right): ${rightNodes.length} node(s) >= 5, all cx > egoNode.cx - 20`);
} else {
  if (rightNodes.length < 5) fail(`Sehnke-ancestors (right): only ${rightNodes.length} node(s) tagged right — BFS propagation may still be broken (expected >= 5)`);
  if (rightFailing.length > 0) fail(`Sehnke-ancestors (right): ${rightNodes.length} total, ${rightFailing.length} fail x-check (cx <= egoNode.cx-20): ${rightFailing.slice(0,3).map(n => `${n.person?.given_name} ${n.person?.surname} cx=${n.cx.toFixed(1)}`).join('; ')}`);
}

// --- Assertion 5: Leonard under Max ------------------------------------------
const leonardNode = posById.get(LEONARD_ID);
if (!leonardNode) {
  fail(`Leonard not resolved — id ${LEONARD_ID} not in posById`);
} else {
  const cyOk   = leonardNode.cy > egoNode.cy;
  const cxOk   = Math.abs(leonardNode.cx - egoNode.cx) < 200;
  const sideOk = leonardNode.side === 'center';
  if (cyOk && cxOk && sideOk) {
    pass(`Leonard under ego — cy=${leonardNode.cy.toFixed(1)} > ego.cy=${egoNode.cy.toFixed(1)}, Δcx=${Math.abs(leonardNode.cx - egoNode.cx).toFixed(1)} < 200, side=center`);
  } else {
    const reasons = [];
    if (!cyOk)   reasons.push(`cy=${leonardNode.cy.toFixed(1)} NOT > ego.cy=${egoNode.cy.toFixed(1)}`);
    if (!cxOk)   reasons.push(`|cx delta|=${Math.abs(leonardNode.cx - egoNode.cx).toFixed(1)} >= 200`);
    if (!sideOk) reasons.push(`side=${leonardNode.side} (expected center)`);
    fail(`Leonard position: ${reasons.join(', ')}`);
  }
}

// --- Assertion 6: Overlap-free -----------------------------------------------
if (overlaps.length === 0) {
  pass(`Overlap-free — ${nodes.length} nodes, 0 overlaps`);
} else {
  fail(`${overlaps.length} overlap(s): ${overlaps.slice(0,5).map(o => `${o.aName} ↔ ${o.bName}`).join('; ')}`);
}

// --- Assertion 7: Ego hard-centered in SVG bbox (0.4–0.6 band) ---------------
const egoCxRatio = egoNode.cx / totalW;
const inHardBand = egoCxRatio >= 0.4 && egoCxRatio <= 0.6;
if (inHardBand) {
  pass(`Ego centered — cx=${egoNode.cx.toFixed(1)}, totalW=${totalW.toFixed(1)}, ratio=${(egoCxRatio * 100).toFixed(1)}% (0.4–0.6)`);
} else {
  fail(`Ego not centered — cx=${egoNode.cx.toFixed(1)}, totalW=${totalW.toFixed(1)}, ratio=${(egoCxRatio * 100).toFixed(1)}% (expected 40–60%)`);
}

// --- Summary -----------------------------------------------------------------
console.log('');
console.log(allPass ? 'RESULT: PASS — all assertions satisfied' : 'RESULT: FAIL — one or more assertions failed');
process.exit(allPass ? 0 : 1);
