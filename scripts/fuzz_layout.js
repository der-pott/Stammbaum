#!/usr/bin/env node
// Property-based fuzzer for computeLayout(). Generates synthetic family
// trees (varying number of generations, siblings, satellites, mini-couples,
// orphans) and asserts invariant #1 (no node bbox overlaps) for each.
//
// Usage:  node scripts/fuzz_layout.js [N]     (default N=50)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const N = parseInt(process.argv[2] || '50', 10);

function uid(i, kind) { return `${kind}-${i}-${Math.random().toString(36).slice(2, 6)}`; }

function makeTree(seed) {
  // Simple PRNG so re-runs can be reproduced.
  let s = seed >>> 0;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0, s / 0x100000000);
  const pick = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));

  const persons = [];
  const edges = [];
  function person(given, surname, gender, extra={}) {
    const id = uid(persons.length, 'p');
    persons.push({ id, given_name: given, surname, gender, birth_date: null, death_date: null, birth_place: null, death_place: null, notes: null, birth_name: null, nicknames: null, portrait_image_id: null, ...extra });
    return id;
  }
  function marry(a, b, status='married') {
    edges.push({ id: uid(edges.length, 'e'), type: 'spouse', from_id: a, to_id: b, status, since: null, until: null });
  }
  function parent(p, c) {
    edges.push({ id: uid(edges.length, 'e'), type: 'parent', from_id: p, to_id: c, status: null });
  }

  // Recursive family generator.
  function family(depth, surname='Fam') {
    if (depth <= 0) return [];
    const hasPartner = rnd() < 0.85;
    const dad = person('P' + persons.length, surname, 'm');
    let mom = null;
    if (hasPartner) {
      mom = person('M' + persons.length, surname, 'f');
      marry(dad, mom);
    }
    // Add extra satellites to the dad sometimes (divorced ex, implied).
    if (rnd() < 0.25) {
      const ex = person('X' + persons.length, surname, 'f');
      marry(dad, ex, 'divorced');
    }
    const kidsN = pick(0, depth > 1 ? 3 : 2);
    for (let i = 0; i < kidsN; i++) {
      const kidSurname = rnd() < 0.5 ? surname : surname + 'ovna';
      const [kid] = family(depth - 1, kidSurname);
      if (!kid) continue;
      parent(dad, kid);
      if (mom) parent(mom, kid);
    }
    return [dad, mom].filter(Boolean);
  }

  // Build 1–3 root families.
  const roots = pick(1, 3);
  for (let i = 0; i < roots; i++) family(pick(2, 4), 'Fam' + i);

  // Sprinkle in some upstream-couple candidates: pick a random leaf, add
  // two parentless person with spouse-edge who both parent that leaf.
  const leaves = persons.filter(p => !edges.some(e => e.type === 'parent' && e.from_id === p.id));
  if (leaves.length) {
    const extras = pick(0, Math.min(3, leaves.length));
    for (let k = 0; k < extras; k++) {
      const leaf = leaves[pick(0, leaves.length - 1)];
      const alreadyParented = edges.some(e => e.type === 'parent' && e.to_id === leaf.id);
      if (alreadyParented) continue;
      const uf = person('UF' + persons.length, 'U' + k, 'm');
      const um = person('UM' + persons.length, 'U' + k, 'f');
      marry(uf, um);
      parent(uf, leaf.id);
      parent(um, leaf.id);
    }
  }

  return { persons, edges };
}

// --- VM setup -----------------------------------------------------------
const src = readFileSync(join(here, '..', 'public', 'stammbaum.js'), 'utf8');
const noopEl = { setAttribute(){}, appendChild(){}, addEventListener(){}, textContent:'', style:{}, classList: { add(){}, remove(){} }, dataset: {}, hidden: false };
noopEl.getContext = () => ({ measureText: (s) => ({ width: String(s).length * 7 }) });
const win = { addEventListener(){}, matchMedia: () => ({ matches: false, addListener(){} }), location: { hash: '' }, localStorage: { getItem: () => null, setItem(){}, removeItem(){} } };
const sandbox = {
  state: { persons: [], edges: [] },
  window: win,
  document: { getElementById: () => null, createElementNS: () => ({ ...noopEl }), createElement: () => ({ ...noopEl }), body: { ...noopEl }, documentElement: { ...noopEl, dataset: {} }, addEventListener(){}, querySelector: () => null, querySelectorAll: () => [] },
  console: { log(){}, warn(){}, error(){} },
  Map, Set, URL, URLSearchParams, Image: class {}, localStorage: win.localStorage,
};
sandbox.globalThis = sandbox; sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'stammbaum.js' });

// --- Run N trees --------------------------------------------------------
let failures = 0;
for (let i = 0; i < N; i++) {
  const seed = (Date.now() + i) >>> 0;
  const tree = makeTree(seed);
  sandbox.__p = tree.persons;
  sandbox.__e = tree.edges;
  vm.runInContext('state.persons = __p; state.edges = __e;', ctx);
  try {
    const layout = ctx.computeLayout();
    if (!layout) continue;
    const n = layout.overlaps?.length || 0;
    if (n > 0) {
      failures++;
      if (failures <= 5) {
        console.error(`seed=${seed}  ${n} overlap(s), ${layout.nodes.length} nodes`);
        for (const o of layout.overlaps.slice(0, 3)) console.error(`  ${o.aName}↔${o.bName}`);
      }
    }
  } catch (err) {
    failures++;
    if (failures <= 5) console.error(`seed=${seed}  throw: ${err.message}`);
  }
}
if (failures === 0) {
  console.log(`✓ fuzz clean (${N} synthetic trees, 0 overlaps, 0 throws)`);
  process.exit(0);
}
console.error(`✗ ${failures}/${N} synthetic trees had overlaps`);
process.exit(1);
