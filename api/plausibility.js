// Plausibility checks over the live DB. SELECT-only. Returns a flat
// array of {key, severity, person_id, person_label, title, detail}.
// `key` is stable across runs so dismissals survive.

import { colognePhonetic } from './phonetic.js';

const SEV = { ERROR: 'error', WARN: 'warn', INFO: 'info' };

function parseYear(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\b(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})\b/);
  return m ? parseInt(m[1], 10) : null;
}

function parseDate(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = m[2] ? parseInt(m[2], 10) : 7;
  const d  = m[3] ? parseInt(m[3], 10) : 1;
  return new Date(Date.UTC(y, mo - 1, d));
}

function fullName(p) {
  return [p.given_name, p.surname].filter(Boolean).join(' ') || p.id.slice(0,8);
}

function pushIssue(out, issue) {
  out.push(issue);
}

export function runPlausibilityChecks(db) {
  const persons = db.prepare('SELECT * FROM persons WHERE deleted_at IS NULL').all();
  const edges   = db.prepare('SELECT * FROM edges   WHERE deleted_at IS NULL').all();
  const byId = new Map(persons.map(p => [p.id, p]));

  // Build parent → children and child → parents maps
  const children = new Map(); // parentId -> [childId]
  const parents  = new Map(); // childId  -> [parentId]
  const partners = new Map(); // personId -> [{partnerId, marriage_date, divorce_date, start_date, end_date}]
  for (const e of edges) {
    if (e.type === 'parent') {
      if (!children.has(e.from_id)) children.set(e.from_id, []);
      children.get(e.from_id).push(e.to_id);
      if (!parents.has(e.to_id)) parents.set(e.to_id, []);
      parents.get(e.to_id).push(e.from_id);
    } else if (e.type === 'partner' || e.type === 'spouse') {
      const pair = [[e.from_id, e.to_id], [e.to_id, e.from_id]];
      for (const [a, b] of pair) {
        if (!partners.has(a)) partners.set(a, []);
        partners.get(a).push({
          partnerId: b,
          marriage_date: e.marriage_date || e.start_date || null,
          divorce_date:  e.divorce_date  || e.end_date   || null,
        });
      }
    }
  }

  // Load dismissals
  let dismissed = new Set();
  try {
    const rows = db.prepare('SELECT issue_key FROM plausibility_dismissals').all();
    dismissed = new Set(rows.map(r => r.issue_key));
  } catch { /* table may not exist yet */ }

  const out = [];

  // 1. death before birth
  for (const p of persons) {
    const b = parseYear(p.birth_date);
    const d = parseYear(p.death_date);
    if (b && d && d < b) {
      pushIssue(out, {
        key: `death-before-birth:${p.id}`,
        severity: SEV.ERROR,
        person_id: p.id,
        person_label: fullName(p),
        title: 'Todesdatum vor Geburtsdatum',
        detail: `${fullName(p)}: geboren ${b}, gestorben ${d}.`,
      });
    }
  }

  // 2. mother/father age at child birth
  for (const [parentId, kids] of children.entries()) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    const pb = parseYear(parent.birth_date);
    const pd = parseYear(parent.death_date);
    if (!pb) continue;
    const isFemale = parent.gender === 'female' || parent.gender === 'w';
    const isMale   = parent.gender === 'male'   || parent.gender === 'm';
    for (const childId of kids) {
      const child = byId.get(childId);
      if (!child) continue;
      const cb = parseYear(child.birth_date);
      if (!cb) continue;
      const age = cb - pb;
      if (age < 12) {
        pushIssue(out, {
          key: `parent-too-young:${parentId}:${childId}`,
          severity: SEV.WARN,
          person_id: parentId,
          person_label: fullName(parent),
          title: 'Elternteil sehr jung bei Geburt',
          detail: `${fullName(parent)} war ${age} Jahre alt bei Geburt von ${fullName(child)}.`,
        });
      }
      if (isFemale && age > 55) {
        pushIssue(out, {
          key: `mother-too-old:${parentId}:${childId}`,
          severity: SEV.WARN,
          person_id: parentId,
          person_label: fullName(parent),
          title: 'Mutter sehr alt bei Geburt',
          detail: `${fullName(parent)} war ${age} Jahre alt bei Geburt von ${fullName(child)}.`,
        });
      }
      if (isMale && age > 80) {
        pushIssue(out, {
          key: `father-too-old:${parentId}:${childId}`,
          severity: SEV.WARN,
          person_id: parentId,
          person_label: fullName(parent),
          title: 'Vater sehr alt bei Geburt',
          detail: `${fullName(parent)} war ${age} Jahre alt bei Geburt von ${fullName(child)}.`,
        });
      }
      if (pd && cb > pd) {
        // Allow father up to 1 year after death (posthumous).
        const grace = isMale ? 1 : 0;
        if (cb > pd + grace) {
          pushIssue(out, {
            key: `parent-dead-at-birth:${parentId}:${childId}`,
            severity: SEV.ERROR,
            person_id: parentId,
            person_label: fullName(parent),
            title: 'Elternteil bereits gestorben bei Geburt',
            detail: `${fullName(parent)} starb ${pd}, ${fullName(child)} geboren ${cb}.`,
          });
        }
      }
    }
  }

  // 3. marriage after death / before birth
  for (const [personId, pairs] of partners.entries()) {
    const p = byId.get(personId);
    if (!p) continue;
    const pb = parseYear(p.birth_date);
    const pd = parseYear(p.death_date);
    for (const pair of pairs) {
      const my = parseYear(pair.marriage_date);
      if (!my) continue;
      if (pd && my > pd) {
        pushIssue(out, {
          key: `marriage-after-death:${personId}:${pair.partnerId}`,
          severity: SEV.ERROR,
          person_id: personId,
          person_label: fullName(p),
          title: 'Heirat nach Tod',
          detail: `${fullName(p)} starb ${pd}, Heirat verzeichnet ${my}.`,
        });
      }
      if (pb && my < pb) {
        pushIssue(out, {
          key: `marriage-before-birth:${personId}:${pair.partnerId}`,
          severity: SEV.ERROR,
          person_id: personId,
          person_label: fullName(p),
          title: 'Heirat vor Geburt',
          detail: `${fullName(p)} geboren ${pb}, Heirat verzeichnet ${my}.`,
        });
      }
      if (pb && my - pb < 14) {
        pushIssue(out, {
          key: `marriage-too-young:${personId}:${pair.partnerId}`,
          severity: SEV.WARN,
          person_id: personId,
          person_label: fullName(p),
          title: 'Heirat sehr jung',
          detail: `${fullName(p)} war ${my - pb} Jahre alt bei der Heirat.`,
        });
      }
    }
  }

  // 4. parent-cycle (person is ancestor of themselves)
  for (const p of persons) {
    const seen = new Set();
    const stack = [p.id];
    let cyclic = false;
    while (stack.length) {
      const cur = stack.pop();
      const ps = parents.get(cur) || [];
      for (const parentId of ps) {
        if (parentId === p.id) { cyclic = true; break; }
        if (!seen.has(parentId)) { seen.add(parentId); stack.push(parentId); }
      }
      if (cyclic) break;
    }
    if (cyclic) {
      pushIssue(out, {
        key: `parent-cycle:${p.id}`,
        severity: SEV.ERROR,
        person_id: p.id,
        person_label: fullName(p),
        title: 'Zyklus in Elternkette',
        detail: `${fullName(p)} ist Vorfahr von sich selbst.`,
      });
    }
  }

  // 5. unusually many kids / large sibling gap
  for (const [parentId, kids] of children.entries()) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    if (kids.length > 12) {
      pushIssue(out, {
        key: `many-kids:${parentId}`,
        severity: SEV.INFO,
        person_id: parentId,
        person_label: fullName(parent),
        title: 'Sehr viele Kinder',
        detail: `${fullName(parent)} hat ${kids.length} Kinder.`,
      });
    }
    const years = kids.map(k => parseYear(byId.get(k)?.birth_date)).filter(Boolean).sort();
    for (let i = 1; i < years.length; i++) {
      if (years[i] - years[i-1] > 20) {
        pushIssue(out, {
          key: `sibling-gap:${parentId}:${years[i-1]}:${years[i]}`,
          severity: SEV.INFO,
          person_id: parentId,
          person_label: fullName(parent),
          title: 'Großer Geschwisterabstand',
          detail: `${fullName(parent)}: Geschwister ${years[i-1]} → ${years[i]} (${years[i]-years[i-1]}J).`,
        });
      }
    }
  }

  // 6. potential duplicates via phonetic + birth year proximity
  const buckets = new Map();
  for (const p of persons) {
    const key = colognePhonetic((p.given_name || '').split(/\s+/)[0] + '|' + (p.surname || p.birth_name || ''));
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const ay = parseYear(a.birth_date), by = parseYear(b.birth_date);
        if (ay && by && Math.abs(ay - by) > 3) continue;
        const [x, y] = [a.id, b.id].sort();
        pushIssue(out, {
          key: `possible-dup:${x}:${y}`,
          severity: SEV.INFO,
          person_id: a.id,
          person_label: fullName(a),
          title: 'Mögliches Duplikat',
          detail: `${fullName(a)} ↔ ${fullName(b)}: phonetisch gleich${ay && by ? `, Geburt ${ay}/${by}` : ''}.`,
        });
      }
    }
  }

  // Filter dismissals, order by severity
  const rank = { error: 0, warn: 1, info: 2 };
  return out
    .filter(i => !dismissed.has(i.key))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}
