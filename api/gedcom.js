// GEDCOM 5.5.1 parser.  No external deps.  Returns { persons, edges } ready to
// insert into the DB.  Dates are passed through as text; the schema is TEXT.
//
// Format recap (one record per blank-line separated block):
//   0 @I1@ INDI
//   1 NAME John /Smith/
//   1 SEX M
//   1 BIRT
//   2 DATE 15 JUN 1832
//   2 PLAC Frankfurt am Main
//   1 DEAT
//   2 DATE ABT 1900
//   0 @F1@ FAM
//   1 HUSB @I1@
//   1 WIFE @I2@
//   1 CHIL @I3@

import { randomUUID } from 'node:crypto';

const SEX_MAP = { M: 'm', F: 'f' };            // U or anything else → null (= divers unknown)
const MAX_FIELD = 500;                         // mirrors the API sanitizePerson() limit

function trimField(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

/* -------- line parsing -------- */

// GEDCOM line format: `<level> [<xref>] <tag> [<value>]`
// Lines starting with `@xref@` after level identify records; otherwise the
// token after the level is the tag and the rest (if any) is the value.
function parseLine(raw) {
  const line = raw.replace(/﻿/, '').replace(/\s+$/, '');
  if (!line) return null;
  const m = line.match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  const level = Number(m[1]);
  let rest = m[2];
  let xref = null;
  const xm = rest.match(/^(@[^@]+@)\s*(.*)$/);
  if (xm) { xref = xm[1]; rest = xm[2]; }
  const [tagRaw, ...valParts] = rest.split(/\s+/);
  const tag = (tagRaw || '').toUpperCase();
  const value = valParts.join(' ');
  return { level, xref, tag, value };
}

// Fold the flat line stream into a tree.  Each node:
//   { tag, value, xref, children: [] }
export function parseGedcom(text) {
  if (!text) return { records: [] };
  const lines = String(text).split(/\r\n|\r|\n/);
  const records = [];
  const stack = []; // stack[level] = node currently open at that level

  for (const raw of lines) {
    const p = parseLine(raw);
    if (!p) continue;
    const node = { tag: p.tag, value: p.value, xref: p.xref, children: [] };
    if (p.level === 0) {
      records.push(node);
      stack.length = 0;
      stack[0] = node;
      continue;
    }
    const parent = stack[p.level - 1];
    if (!parent) continue; // malformed, skip
    parent.children.push(node);
    stack.length = p.level + 1;
    stack[p.level] = node;
  }
  return { records };
}

/* -------- record interpretation -------- */

function findChild(node, tag) { return node.children.find(c => c.tag === tag); }
function findChildren(node, tag) { return node.children.filter(c => c.tag === tag); }
function childValue(node, tag) { return findChild(node, tag)?.value || ''; }

function parseName(nameValue) {
  // "John /Smith/" or "John /Smith/ Jr" — surname delimited by slashes.
  if (!nameValue) return { given: '', surname: '' };
  const m = nameValue.match(/^(.*?)\/([^/]*)\/(.*)$/);
  if (!m) return { given: nameValue.trim(), surname: '' };
  const given = (m[1] + ' ' + m[3]).trim().replace(/\s+/g, ' ');
  const surname = m[2].trim();
  return { given, surname };
}

function readEvent(node, kind) {
  const ev = findChild(node, kind);
  if (!ev) return { date: null, place: null };
  return {
    date: trimField(childValue(ev, 'DATE')),
    place: trimField(childValue(ev, 'PLAC')),
  };
}

function readIndi(node) {
  // Some files have multiple NAMEs; take the first (primary).
  const nameNode = findChild(node, 'NAME');
  const { given, surname } = parseName(nameNode?.value || '');
  const birth = readEvent(node, 'BIRT');
  const death = readEvent(node, 'DEAT');
  const sex = (childValue(node, 'SEX') || '').toUpperCase();
  return {
    xref: node.xref,
    given_name: trimField(given),
    surname: trimField(surname),
    birth_name: null,
    gender: SEX_MAP[sex] || null,
    birth_date: birth.date,
    birth_place: birth.place,
    death_date: death.date,
    death_place: death.place,
    notes: null,
  };
}

function readFam(node) {
  return {
    xref: node.xref,
    husb: findChild(node, 'HUSB')?.value || null,
    wife: findChild(node, 'WIFE')?.value || null,
    children: findChildren(node, 'CHIL').map(c => c.value).filter(Boolean),
  };
}

/* -------- public: parse → ready-to-insert shape -------- */

export function gedcomToPayload(text) {
  const { records } = parseGedcom(text);
  const indis = records.filter(r => r.tag === 'INDI').map(readIndi);
  const fams = records.filter(r => r.tag === 'FAM').map(readFam);

  // GEDCOM xref → new UUID
  const idByXref = new Map();
  const persons = indis.map(i => {
    const id = randomUUID();
    if (i.xref) idByXref.set(i.xref, id);
    const { xref, ...rest } = i;
    return { id, ...rest };
  });

  const edges = [];
  const seenParent = new Set();                // "<parent>|<child>"
  const seenSpouse = new Set();                // sorted "<a>|<b>"
  for (const fam of fams) {
    const parentIds = [fam.husb, fam.wife].map(x => x && idByXref.get(x)).filter(Boolean);
    const childIds = fam.children.map(x => x && idByXref.get(x)).filter(Boolean);
    // spouse edge (one row, unordered)
    if (parentIds.length === 2) {
      const [a, b] = parentIds.slice().sort();
      const key = `${a}|${b}`;
      if (!seenSpouse.has(key)) {
        seenSpouse.add(key);
        edges.push({ id: randomUUID(), from_id: parentIds[0], to_id: parentIds[1], type: 'spouse' });
      }
    }
    // parent edges
    for (const parentId of parentIds) {
      for (const childId of childIds) {
        if (parentId === childId) continue;
        const key = `${parentId}|${childId}`;
        if (seenParent.has(key)) continue;
        seenParent.add(key);
        edges.push({ id: randomUUID(), from_id: parentId, to_id: childId, type: 'parent' });
      }
    }
  }

  return { persons, edges };
}
