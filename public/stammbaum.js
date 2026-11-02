// Stammbaum frontend — Vanilla ES2024, no build step.
// Family archive style: paper + ink + time axis.

const api = {
  async list() { return j(await fetch('/api/persons')); },
  async get(id) { return j(await fetch(`/api/persons/${id}`)); },
  async create(data) { return j(await fetch('/api/persons', postJson(data))); },
  async update(id, data) { return j(await fetch(`/api/persons/${id}`, patchJson(data))); },
  async remove(id) { return j(await fetch(`/api/persons/${id}`, { method: 'DELETE' })); },
  async tree() { return j(await fetch('/api/tree')); },
  async createEdge(data) { return j(await fetch('/api/edges', postJson(data))); },
  async updateEdge(id, data) { return j(await fetch(`/api/edges/${id}`, patchJson(data))); },
  async removeEdge(id) { return j(await fetch(`/api/edges/${id}`, { method: 'DELETE' })); },
  async research(person_id) { return j(await fetch('/api/ai/research', postJson({ person_id }))); },
  async latestResearch(person_id) {
    const r = await fetch(`/api/ai/runs/${person_id}/latest`);
    if (r.status === 404) return null;
    return j(r);
  },
  async importGedcom(file) {
    return j(await fetch('/api/import/gedcom', {
      method: 'POST',
      headers: { 'content-type': 'application/x-gedcom' },
      body: file,
    }));
  },
  async me() {
    const r = await fetch('/api/auth/me');
    if (r.status === 401) return null;
    if (!r.ok) throw new Error('auth-check fehlgeschlagen');
    return r.json();
  },
  async login(role, pin) { return j(await fetch('/api/auth/login', postJson({ role, pin }))); },
  async logout() { return j(await fetch('/api/auth/logout', { method: 'POST' })); },
  async personDetail(id) { return j(await fetch(`/api/persons/${id}`)); },
  async uploadImage(file, caption) {
    const qs = caption ? ('?caption=' + encodeURIComponent(caption)) : '';
    return j(await fetch('/api/images' + qs, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    }));
  },
  async linkImage(person_id, image_id, role) {
    return j(await fetch('/api/person-images', postJson({ person_id, image_id, role })));
  },
  async unlinkImage(person_id, image_id) {
    return j(await fetch('/api/person-images', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ person_id, image_id }),
    }));
  },
  async setPortrait(person_id, image_id) {
    return j(await fetch(`/api/persons/${person_id}/portrait`, postJson({ image_id })));
  },
  async bio(person_id) {
    const r = await fetch(`/api/persons/${person_id}/biography`);
    if (r.status === 404) return null;
    return j(r);
  },
  async makeBio(person_id) {
    return j(await fetch(`/api/persons/${person_id}/biography`, { method: 'POST' }));
  },
  async listSub(person_id, kind) {
    return j(await fetch(`/api/persons/${person_id}/${kind}`));
  },
  async createSub(person_id, kind, data) {
    return j(await fetch(`/api/persons/${person_id}/${kind}`, postJson(data)));
  },
  async updateSub(person_id, kind, id, data) {
    return j(await fetch(`/api/persons/${person_id}/${kind}/${id}`, patchJson(data)));
  },
  async deleteSub(person_id, kind, id) {
    return j(await fetch(`/api/persons/${person_id}/${kind}/${id}`, { method: 'DELETE' }));
  },
  async scrape(person_id, sources) {
    return j(await fetch(`/api/persons/${person_id}/research/scrape`, postJson({ sources: sources || null })));
  },
  async scrapeSource(person_id, key) {
    return j(await fetch(`/api/persons/${person_id}/research/scrape-source/${key}`, postJson({ use_cache: false })));
  },
  async scrapeJob(job_id) {
    return j(await fetch(`/api/research/jobs/${job_id}`));
  },
  async listHits(person_id) {
    return j(await fetch(`/api/persons/${person_id}/research/hits`));
  },
  async applyHit(hit_id, action) {
    return j(await fetch(`/api/research/hits/${hit_id}/apply`, postJson({ action })));
  },
  async researchSources() { return j(await fetch('/api/research/sources')); },
  async researchConsensus(person_id) {
    return j(await fetch(`/api/persons/${person_id}/research/consensus`));
  },
};
function postJson(data) { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }; }
function patchJson(data) { return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }; }
async function j(r) {
  if (r.status === 401) { state.role = null; applyRole(); openLoginDialog(); throw new Error('Login erforderlich'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

const state = {
  persons: [], edges: [], selected: null, filter: '', role: null,
  images: new Map(),
  pz: { x: 0, y: 0, k: 1 },
  dragging: null,
  layout: null,
  latestRunCache: new Map(),
};

/* --- URL routing ---------------------------------------------------- */
function parseHash() {
  const m = location.hash.match(/^#person\/([a-f0-9-]+)/i);
  return m ? m[1] : null;
}
function setHash(id) {
  const want = id ? `#person/${id}` : '';
  if (location.hash !== want) history.replaceState(null, '', want || location.pathname);
}
window.addEventListener('hashchange', () => {
  const id = parseHash();
  if (id !== state.selected) { state.selected = id; render(); }
});

/* --- Theme ---------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem('sb-theme');
  if (saved) document.documentElement.dataset.theme = saved;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('sb-theme', next);
}

/* --- Data load ------------------------------------------------------ */
async function reload() {
  const t = await api.tree();
  const firstLoad = !state.persons.length;
  state.persons = t.persons;
  state.edges = t.edges;
  const h = parseHash();
  if (h && state.persons.some(p => p.id === h)) state.selected = h;
  render();
  if (firstLoad) requestAnimationFrame(fitTree);
}

/* --- Auth ----------------------------------------------------------- */
function applyRole() {
  const loggedIn = !!state.role;
  document.getElementById('app-main').hidden = !loggedIn;
  const badge = document.getElementById('role-badge');
  badge.hidden = !loggedIn;
  badge.textContent = state.role ? (state.role === 'editor' ? 'Editor' : 'Betrachter') : '';
  document.getElementById('btn-logout').hidden = !loggedIn;
  document.getElementById('fab-list').hidden = !loggedIn;
  const canEdit = state.role === 'editor';
  for (const el of document.querySelectorAll('[data-editor]')) el.hidden = !canEdit;
}

function openLoginDialog() {
  const dlg = document.getElementById('login-dialog');
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-error');
  err.hidden = true;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    try {
      const r = await api.login(data.role, data.pin);
      state.role = r.role;
      applyRole();
      dlg.close();
      await reload();
    } catch (e) {
      err.textContent = e.message || 'Fehler beim Anmelden';
      err.hidden = false;
    }
  };
  if (!dlg.open) dlg.showModal();
}

async function logout() {
  try { await api.logout(); } catch (_) {}
  state.role = null; state.persons = []; state.edges = []; state.selected = null;
  setHash(null);
  applyRole();
  openLoginDialog();
}

/* --- Helpers -------------------------------------------------------- */
function nameOf(p) {
  const parts = [p.given_name, p.surname].filter(Boolean);
  return parts.join(' ') || '(ohne Namen)';
}
function primaryNameOf(p) {
  const nick = (p.nicknames || '').split(',')[0]?.trim();
  if (nick && nick !== p.given_name) return [nick, p.surname].filter(Boolean).join(' ');
  return nameOf(p);
}
function fullNameOf(p) { return nameOf(p); }
function hasAltName(p) {
  const nick = (p.nicknames || '').split(',')[0]?.trim();
  return nick && nick !== p.given_name;
}
function initialsOf(p) {
  const first = (p.given_name || '').split(/[\s-]+/)[0] || '';
  const last  = (p.surname || '').split(/[\s-]+/)[0] || '';
  return (first.slice(0, 1) + last.slice(0, 1)).toUpperCase() || '·';
}
function year(s) { return (s || '').match(/\b(1[6-9]\d{2}|20\d{2}|21\d{2})\b/)?.[1] || null; }
function fmtLifeShort(p) {
  const b = year(p.birth_date), d = year(p.death_date);
  if (b && d) return `${b}–${d}`;
  if (b) return `*${b}`;
  if (d) return `✝${d}`;
  return '';
}
function fmtPlace(p) {
  return [p.birth_place, p.death_place].filter(Boolean)[0] || '';
}

/* --- German date I/O ------------------------------------------------ */
// Normalise "21071983" / "210783" / "21-07-1983" / "21/7/83" into "21.07.1983".
// Already-German ("21.07.1983") passes through. Free text ("Sommer 1983",
// "ca. 1941", "um 1900") is left untouched.
function parseGermanDate(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  if (!s) return s;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) return s;
  const digitsOnly = /^\d+$/.test(s);
  if (digitsOnly && s.length === 8) {
    return `${s.slice(0, 2)}.${s.slice(2, 4)}.${s.slice(4, 8)}`;
  }
  if (digitsOnly && s.length === 6) {
    const dd = s.slice(0, 2), mm = s.slice(2, 4), yy = parseInt(s.slice(4, 6), 10);
    const thisYY = new Date().getFullYear() % 100;
    const yyyy = yy <= thisYY ? 2000 + yy : 1900 + yy;
    return `${dd}.${mm}.${yyyy}`;
  }
  const m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    let yyyy = m[3];
    if (yyyy.length === 2) {
      const yy = parseInt(yyyy, 10);
      yyyy = String(yy <= new Date().getFullYear() % 100 ? 2000 + yy : 1900 + yy);
    }
    return `${dd}.${mm}.${yyyy}`;
  }
  return raw;
}

// For display: ISO "1941-07-21" → "21.07.1941"; already-German passes through;
// free text passes through.
function fmtDateDisplay(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  return s;
}

// For storage: German "21.07.1983" → ISO "1983-07-21". Keeps DB sortable chronologically.
// Also accepts "21071983" / "210783" / "21-07-83" via parseGermanDate first, then normalizes.
// Free text (unknown shape) is passed through unchanged.
function toIsoDate(raw) {
  if (!raw) return raw;
  const german = parseGermanDate(raw);
  const m = String(german).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = String(german).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return german;
  return german; // free text
}

// Legacy name retained for callers; now defers to fmtDateDisplay.
function fmtDate(raw) { return fmtDateDisplay(raw); }

// Wire blur-handlers on date-shaped inputs inside a form or dialog.
function wireDateInputs(root) {
  if (!root) return;
  root.querySelectorAll('input').forEach(inp => {
    const name = inp.getAttribute('name') || '';
    if (!/date|^date$|^year$|since|until|start|end/i.test(name)) return;
    const t = (inp.getAttribute('type') || 'text').toLowerCase();
    if (t !== 'text' && t !== '') return;
    inp.setAttribute('placeholder', 'TT.MM.JJJJ');
    inp.setAttribute('inputmode', 'numeric');
    inp.addEventListener('blur', () => {
      const parsed = parseGermanDate(inp.value);
      if (parsed !== inp.value) inp.value = parsed;
    });
  });
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

/* --- Render --------------------------------------------------------- */
function render() {
  renderList();
  renderTree();
  renderDetail();
  setHash(state.selected);
}

function renderList() {
  const ul = document.getElementById('person-list');
  const f = state.filter.toLowerCase();
  const items = state.persons
    .map(p => ({ p, hay: `${nameOf(p)} ${p.nicknames || ''} ${p.birth_place || ''} ${p.death_place || ''} ${year(p.birth_date) || ''}`.toLowerCase() }))
    .filter(({ hay }) => !f || hay.includes(f))
    .sort((a, b) => {
      const ay = year(a.p.birth_date) || '9999';
      const by = year(b.p.birth_date) || '9999';
      return ay.localeCompare(by);
    });
  ul.replaceChildren(...items.map(({ p }) => {
    const li = h('li', { 'data-id': p.id, role: 'option', tabindex: '0' },
      h('div', { class: 'avatar' }, initialsOf(p)),
      h('div', {},
        h('div', { class: 'name' }, primaryNameOf(p)),
        h('div', { class: 'meta' }, [
          hasAltName(p) ? fullNameOf(p) : null,
          fmtLifeShort(p),
          fmtPlace(p),
        ].filter(Boolean).join(' · ')),
      ),
      h('span', { class: 'gen-tag' }, year(p.birth_date) || '—'),
    );
    if (state.selected === p.id) li.classList.add('active');
    li.onclick = () => select(p.id);
    li.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(p.id); } };
    return li;
  }));

  document.getElementById('list-meta').textContent =
    `${items.length} ${items.length === 1 ? 'Person' : 'Personen'}` +
    (items.length !== state.persons.length ? ` von ${state.persons.length}` : '');
}

function select(id) {
  state.selected = id;
  render();
  if (window.matchMedia('(max-width: 820px)').matches) {
    // Make sure the two drawers don't overlap: close any open drawer first.
    document.querySelector('.pane-list')?.classList.remove('open');
    openDrawer('detail');
  }
}

/* --- Tree layout: timeline-based ------------------------------------ */
// Node dimensions for the dynasty-chart layout: round avatar + name/dates underneath.
const NODE_W = 128;    // card width (avatar centered)
const AVATAR_R = 36;   // circular portrait radius
const NODE_H = 150;    // avatar + name + dates (base; wrapped names may extend further)
const SIBLING_GAP = 16;
const COUPLE_GAP = 56;  // ❤-filled gap between spouses
const FAMILY_GAP = 56;  // between adjacent sibling groups
const ROW_H = 260;      // vertical gap between generations (room for 2–3 wrapped name lines)
const NAME_WRAP_W = NODE_W + 24;   // max width per node name block
const NAME_LINE_H = 15;             // px per wrapped name line (font-size 13 + leading)

// Text-metrics cache for SVG wrap.
const _measureCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(400, 50)
  : (typeof document !== 'undefined' ? document.createElement('canvas') : null);
const _measureCtx = _measureCanvas?.getContext ? _measureCanvas.getContext('2d') : null;
function measureText(str, font = '600 13px "Instrument Sans", sans-serif') {
  if (!_measureCtx) return (str || '').length * 7;
  _measureCtx.font = font;
  return _measureCtx.measureText(str || '').width;
}

// Simple word-wrap using the text-metrics cache.
// Falls back to hard character-split for a single word longer than maxWidth.
function wrapText(str, maxWidth, font = '600 13px "Instrument Sans", sans-serif') {
  if (!str) return [''];
  const words = String(str).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (measureText(test, font) <= maxWidth) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      if (measureText(w, font) > maxWidth) {
        let piece = '';
        for (const ch of w) {
          if (measureText(piece + ch, font) > maxWidth) {
            if (piece) lines.push(piece);
            piece = ch;
          } else {
            piece += ch;
          }
        }
        cur = piece;
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function computeLayout() {
  if (!state.persons.length) return null;

  // Build directed relationship maps.
  const parentOf = new Map();   // child -> [parentId]
  const childOf = new Map();    // parent -> [childId]
  const spouseOf = new Map();   // id -> Set(spouseId)
  const spouseEdges = new Map(); // "a|b"(sorted) -> edge object
  for (const p of state.persons) {
    parentOf.set(p.id, []);
    childOf.set(p.id, []);
    spouseOf.set(p.id, new Set());
  }
  for (const e of state.edges) {
    if (e.type === 'parent') {
      parentOf.get(e.to_id)?.push(e.from_id);
      childOf.get(e.from_id)?.push(e.to_id);
    } else if (e.type === 'spouse') {
      spouseOf.get(e.from_id)?.add(e.to_id);
      spouseOf.get(e.to_id)?.add(e.from_id);
      const k = e.from_id < e.to_id ? `${e.from_id}|${e.to_id}` : `${e.to_id}|${e.from_id}`;
      spouseEdges.set(k, e);
    }
  }

  const personById = new Map(state.persons.map(p => [p.id, p]));

  // --- generation assignment (depth from oldest ancestor) --------------
  const gen = new Map();
  for (const p of state.persons) {
    if (!parentOf.get(p.id).length) gen.set(p.id, 0);
  }
  let changed = true, safety = 0;
  function bump(id, g) {
    const cur = gen.get(id);
    if (cur == null || g > cur) { gen.set(id, g); changed = true; }
  }
  while (changed && safety++ < 100) {
    changed = false;
    // Parent-prop: push children DOWN by at-least-one-below max(parents).
    for (const p of state.persons) {
      const pars = parentOf.get(p.id);
      if (!pars.length) continue;
      const parGens = pars.filter(pid => gen.has(pid)).map(pid => gen.get(pid));
      if (!parGens.length) continue;
      bump(p.id, Math.max(...parGens) + 1);
    }
    // Align spouses to max of their current gens (upward only).
    for (const [a, bs] of spouseOf) {
      for (const b of bs) {
        const ga = gen.get(a), gb = gen.get(b);
        if (ga == null && gb == null) continue;
        const target = Math.max(ga ?? -Infinity, gb ?? -Infinity);
        if (target !== -Infinity) {
          bump(a, target);
          bump(b, target);
        }
      }
    }
  }
  for (const p of state.persons) if (!gen.has(p.id)) gen.set(p.id, 0);

  // --- SLOTS ----------------------------------------------------------
  // A SLOT is one position in a generation row. It consists of an anchor
  // person (child of parents, or root) and 0..N satellites (current/ex
  // spouses who are rendered next to the anchor).
  //
  // Rules:
  //  - Every person has at most ONE slot:
  //    * Anchor of their own slot if (has parents) OR (no parents but no
  //      spouse-anchor claims them).
  //    * Satellite in the slot of their spouse if (no parents) AND they are
  //      married/partnered to someone who gets their own slot.
  //  - A person with parents is ALWAYS their own anchor (never a satellite).
  //    Cross-tree spouse edges (two anchors married to each other) are drawn
  //    as a dashed arc.

  const MARRIAGE_GAP = 56;   // anchor <-> satellite gap (same as COUPLE_GAP)
  const SATELLITE_GAP = 44;  // satellite <-> satellite gap

  function childrenShared(a, b) {
    const ca = new Set(childOf.get(a) || []);
    const cb = childOf.get(b) || [];
    let n = 0;
    for (const c of cb) if (ca.has(c)) n++;
    return n;
  }
  function sharedChildrenList(a, b) {
    const ca = new Set(childOf.get(a) || []);
    return (childOf.get(b) || []).filter(c => ca.has(c));
  }

  // --- MARITAL ANCHOR vs BIRTH ANCHOR ---------------------------------
  // Rule: when two persons are married/partnered AND share ≥1 child, that
  // marital couple takes precedence over either spouse's birth family. One
  // of the pair is drawn as the slot anchor; the other as its primary
  // satellite — even if the primary satellite has their own parents in the
  // DB. The satellite's birth parents become a dashed birth-arc.

  // Primary partner (per person) = spouse with earliest shared-child birth-year.
  const earliestKidYearFor = (kids) => {
    let min = Infinity;
    for (const k of kids) {
      const y = parseInt(year(personById.get(k)?.birth_date) || '', 10);
      if (!isNaN(y) && y < min) min = y;
    }
    return min;
  };
  const primaryPartnerOf = new Map();
  for (const p of state.persons) {
    const list = [];
    for (const q of (spouseOf.get(p.id) || [])) {
      const kids = sharedChildrenList(p.id, q);
      if (kids.length) list.push({ q, min: earliestKidYearFor(kids) });
    }
    if (list.length) {
      list.sort((a, b) => a.min - b.min);
      primaryPartnerOf.set(p.id, list[0].q);
    }
  }

  // Mutual primary couples (both prefer each other).
  const pickCoupleAnchor = (a, b) => {
    const pa = personById.get(a), pb = personById.get(b);
    const gA = pa?.gender, gB = pb?.gender;
    if (gA === 'm' && gB !== 'm') return a;
    if (gB === 'm' && gA !== 'm') return b;
    const yA = year(pa?.birth_date), yB = year(pb?.birth_date);
    if (yA && yB && yA !== yB) return yA.localeCompare(yB) < 0 ? a : b;
    return a < b ? a : b;
  };
  const forcedSatelliteOf = new Map();  // satId -> anchorId  (overrides birth-anchor rule)
  const seenCouple = new Set();
  for (const [p, other] of primaryPartnerOf) {
    if (primaryPartnerOf.get(other) !== p) continue;
    const key = p < other ? `${p}|${other}` : `${other}|${p}`;
    if (seenCouple.has(key)) continue;
    seenCouple.add(key);
    const anchor = pickCoupleAnchor(p, other);
    const sat = anchor === p ? other : p;
    forcedSatelliteOf.set(sat, anchor);
  }

  // isAnchor: persons who get their own slot.
  // A person with parents is their own anchor UNLESS a mutual primary couple
  // has designated them the satellite side (then they ride in the anchor's slot
  // and their birth parents become a dashed birth-arc).
  const isAnchor = new Set();
  for (const p of state.persons) {
    if (forcedSatelliteOf.has(p.id)) continue;
    if ((parentOf.get(p.id) || []).length > 0) isAnchor.add(p.id);
  }

  // satelliteOf: persons who sit next to an anchor in that anchor's slot.
  const satelliteOf = new Map();   // satelliteId -> anchorId
  // (a) forced sats from mutual primary couples.
  for (const [sat, anchor] of forcedSatelliteOf) {
    satelliteOf.set(sat, anchor);
  }
  // (b) parent-less persons married to an anchor become its satellite.
  for (const p of state.persons) {
    if (isAnchor.has(p.id)) continue;
    if (satelliteOf.has(p.id)) continue;
    const partners = [...(spouseOf.get(p.id) || [])];
    const anchorPartners = partners.filter(x => isAnchor.has(x));
    if (anchorPartners.length) {
      anchorPartners.sort((a, b) => {
        const ca = childrenShared(a, p.id);
        const cb = childrenShared(b, p.id);
        if (ca !== cb) return cb - ca;
        return a.localeCompare(b);
      });
      satelliteOf.set(p.id, anchorPartners[0]);
    }
  }

  // Persons without parents who were NOT taken as satellites are their own anchors.
  for (const p of state.persons) {
    if (isAnchor.has(p.id)) continue;
    if (satelliteOf.has(p.id)) continue;
    isAnchor.add(p.id);
  }

  // Build slots keyed by anchor.
  //
  // Satellite order: current/active relationships CLOSEST to anchor, ended
  // ones (divorced, widowed) further out. Within the same group, newer
  // relationships sit closer to the anchor than older ones.
  //
  // One exception: when a mutual-primary couple exists AND is still active
  // (status != divorced/widowed), that primary partner stays closest. If the
  // primary is divorced/widowed, status weight wins — a current partner
  // takes the inner slot.
  function statusWeight(status) {
    // Lower = closer to anchor (= more active).
    switch (status) {
      case 'married':
      case 'partner':
      case 'engaged':
      case null:
      case undefined:
      case '':
        return 0;
      case 'widowed':  return 1;
      case 'divorced': return 2;
      default:         return 1;
    }
  }
  const slotByAnchor = new Map();
  for (const a of isAnchor) {
    const sats = [];
    for (const [sid, aid] of satelliteOf) if (aid === a) sats.push(sid);
    // Satellite order with two conflicting user requests:
    //  (1) current/active relationships closer to anchor, ended further out
    //  (2) biological co-parent (shared-kid partner) needs to sit between
    //      anchor and children-drop so the drop line emerges from a clean
    //      midpoint (not through another sat's position).
    //
    // Compromise: shared-children partners (biological co-parents) always
    // sit INNER. If multiple shared-kid partners exist, order those by
    // status weight (current < ended) then by `since` desc. Non-shared sats
    // sit OUTER, same sub-sort.
    const hasSharedKids = (satId) => sharedChildrenList(a, satId).length > 0;
    sats.sort((x, y) => {
      const bioX = hasSharedKids(x), bioY = hasSharedKids(y);
      if (bioX && !bioY) return -1;
      if (bioY && !bioX) return 1;
      const kx = a < x ? `${a}|${x}` : `${x}|${a}`;
      const ky = a < y ? `${a}|${y}` : `${y}|${a}`;
      const ex = spouseEdges.get(kx);
      const ey = spouseEdges.get(ky);
      const wx = statusWeight(ex?.status);
      const wy = statusWeight(ey?.status);
      if (wx !== wy) return wx - wy;
      const sx = ex?.since || '';
      const sy = ey?.since || '';
      if (sx !== sy) return sy.localeCompare(sx);
      const bx = year(personById.get(x)?.birth_date) || '9999';
      const by = year(personById.get(y)?.birth_date) || '9999';
      return bx.localeCompare(by);
    });
    const width = NODE_W + sats.length * (MARRIAGE_GAP + NODE_W);
    slotByAnchor.set(a, { anchorId: a, satellites: sats, width });
  }

  // --- children-of-slot ---
  // For each slot, which other slots are its children?
  // A slot S is a child of slot P iff S.anchor's parents include P.anchor
  // AND the OTHER parent is P.anchor OR a satellite of P.anchor OR not in
  // any slot (orphan parent).
  // Simplification: a child slot C with parents [pA, pB] belongs under:
  //   - the slot of pA if pA is an anchor
  //   - else the slot of pB if pB is an anchor
  //   - If pA and pB are both satellites of DIFFERENT anchors, parent slot
  //     is one of them (whichever's anchor is also parent of C — but anchor
  //     may not be a parent... edge case; take pA's owning anchor's slot).
  const childSlotsOfAnchor = new Map();  // anchorId -> [childAnchorId]
  for (const a of isAnchor) childSlotsOfAnchor.set(a, []);
  for (const c of isAnchor) {
    const pars = parentOf.get(c) || [];
    if (!pars.length) continue;
    // Prefer a parent that IS an anchor:
    let parentAnchor = pars.find(x => isAnchor.has(x));
    if (!parentAnchor) {
      // Both parents are satellites: resolve to the anchor they belong to.
      for (const par of pars) {
        if (satelliteOf.has(par)) { parentAnchor = satelliteOf.get(par); break; }
      }
    }
    if (!parentAnchor) continue;
    childSlotsOfAnchor.get(parentAnchor).push(c);
  }

  // Order sibling slots by birth-year of their anchor.
  for (const [a, kids] of childSlotsOfAnchor) {
    kids.sort((x, y) => {
      const bx = year(personById.get(x)?.birth_date) || '9999';
      const by = year(personById.get(y)?.birth_date) || '9999';
      return bx.localeCompare(by);
    });
  }

  // --- recursive subtree width ----------------------------------------
  // Width of a slot's subtree = max(slot own width, total child slots width)
  const subtreeWidth = new Map();
  function computeSubtreeWidth(a, visited = new Set()) {
    if (visited.has(a)) return slotByAnchor.get(a).width;
    visited.add(a);
    const slot = slotByAnchor.get(a);
    const kids = childSlotsOfAnchor.get(a) || [];
    if (!kids.length) {
      subtreeWidth.set(a, slot.width);
      return slot.width;
    }
    let kidsW = 0;
    for (let i = 0; i < kids.length; i++) {
      kidsW += computeSubtreeWidth(kids[i], visited);
      if (i < kids.length - 1) kidsW += FAMILY_GAP;
    }
    const w = Math.max(slot.width, kidsW);
    subtreeWidth.set(a, w);
    return w;
  }

  // Root anchors = anchors whose parent isn't itself an anchor (no proper parent slot).
  const rootAnchors = [];
  for (const a of isAnchor) {
    const pars = parentOf.get(a) || [];
    const anchorParent = pars.find(x => isAnchor.has(x));
    if (!anchorParent) rootAnchors.push(a);
  }
  // Order roots by birth-year.
  rootAnchors.sort((x, y) => {
    const bx = year(personById.get(x)?.birth_date) || '9999';
    const by = year(personById.get(y)?.birth_date) || '9999';
    return bx.localeCompare(by);
  });

  for (const r of rootAnchors) computeSubtreeWidth(r);
  // Orphan anchors not reached by root walk:
  for (const a of isAnchor) if (!subtreeWidth.has(a)) computeSubtreeWidth(a);

  // --- place slots top-down -------------------------------------------
  // Each slot has: anchorX, satelliteXs (one per satellite), y
  const slotPos = new Map();   // anchorId -> {anchorCx, satelliteCxs: [], y}

  const marginL = 80, marginT = 80, marginB = 60, marginR = 80;

  function placeSlotAt(a, slotLeftX, y) {
    const slot = slotByAnchor.get(a);
    const anchorCx = slotLeftX + NODE_W / 2;
    const satCxs = [];
    for (let i = 0; i < slot.satellites.length; i++) {
      satCxs.push(slotLeftX + NODE_W + (i + 1) * MARRIAGE_GAP + i * NODE_W + NODE_W / 2);
    }
    slotPos.set(a, { anchorCx, satelliteCxs: satCxs, y, slotLeftX, width: slot.width });
  }

  function shiftSubtree(a, dx, visited = new Set()) {
    if (visited.has(a)) return;
    visited.add(a);
    const pos = slotPos.get(a);
    if (!pos) return;
    pos.anchorCx += dx;
    pos.satelliteCxs = pos.satelliteCxs.map(x => x + dx);
    pos.slotLeftX += dx;
    const kids = childSlotsOfAnchor.get(a) || [];
    for (const c of kids) shiftSubtree(c, dx, visited);
  }

  function layoutSlot(a, slotLeftX, y, visited = new Set()) {
    if (visited.has(a)) return;
    visited.add(a);
    placeSlotAt(a, slotLeftX, y);
    const slot = slotByAnchor.get(a);
    const sPos = slotPos.get(a);

    const kids = childSlotsOfAnchor.get(a) || [];
    if (!kids.length) return;

    // Place child slots sequentially left-to-right (slot.leftX of next
    // follows slot.rightX of previous + SIBLING_GAP). This gives each
    // child its own slot-width worth of space (anchor + satellites).
    const childLefts = [];
    const childAnchorCxs = [];
    let cursor = 0;  // arbitrary origin; we'll shift the whole group later
    for (const c of kids) {
      const w = slotByAnchor.get(c).width;
      childLefts.push(cursor);
      childAnchorCxs.push(cursor + NODE_W / 2);
      cursor += w + SIBLING_GAP;
    }

    // Center the ANCHORS group under the appropriate parent-midpoint.
    // For a slot with a single co-parent-with-children (the common case), use
    // the (anchor, co-parent) midpoint. If there are multiple co-parents with
    // children, we have to pick one; for now use the midpoint between the
    // two outermost anchor-cxs so the group is centered under the slot itself.
    //
    // Build target: find the dominant co-parent (satellite with most shared
    // kids). Drop line comes from (anchor + co-parent)/2 if co-parent is in
    // this slot's satellites.
    const kidsByCoparent = new Map();
    for (const c of kids) {
      const pars = parentOf.get(c) || [];
      const other = pars.find(x => x !== a) || null;
      if (!kidsByCoparent.has(other)) kidsByCoparent.set(other, []);
      kidsByCoparent.get(other).push(c);
    }
    // Dominant group = largest count
    let dominant = null, bestCount = -1;
    for (const [cop, list] of kidsByCoparent) {
      if (list.length > bestCount) { bestCount = list.length; dominant = cop; }
    }
    let targetCx;
    if (dominant && slot.satellites.includes(dominant)) {
      const idx = slot.satellites.indexOf(dominant);
      targetCx = (sPos.anchorCx + sPos.satelliteCxs[idx]) / 2;
    } else {
      // Solo or cross-tree co-parent — center under the anchor.
      targetCx = sPos.anchorCx;
    }

    const anchorMid = (childAnchorCxs[0] + childAnchorCxs[childAnchorCxs.length - 1]) / 2;
    const shift = targetCx - anchorMid;

    for (let i = 0; i < kids.length; i++) {
      const cy = marginT + (gen.get(kids[i]) ?? 0) * ROW_H;
      layoutSlot(kids[i], childLefts[i] + shift, cy, visited);
    }
  }

  // Place roots left-to-right.
  let cursor = marginL;
  for (const r of rootAnchors) {
    const w = subtreeWidth.get(r) || NODE_W;
    const slotW = slotByAnchor.get(r).width;
    const slotLeftX = cursor + (w - slotW) / 2;  // center the slot inside its subtree
    layoutSlot(r, slotLeftX, marginT + (gen.get(r) ?? 0) * ROW_H);
    cursor += w + FAMILY_GAP;
  }
  // Orphan anchors not placed (not reached from roots):
  for (const a of isAnchor) {
    if (slotPos.has(a)) continue;
    const slot = slotByAnchor.get(a);
    layoutSlot(a, cursor, marginT + (gen.get(a) ?? 0) * ROW_H);
    cursor += slot.width + FAMILY_GAP;
  }

  // --- derive node positions from slot placement ----------------------
  const nodes = [];
  const posById = new Map();
  function makeNode(personId, x, y) {
    const p = personById.get(personId);
    if (!p) return null;
    const n = { id: personId, person: p, x, y, w: NODE_W, h: NODE_H, cx: x + NODE_W / 2, cy: y + AVATAR_R };
    nodes.push(n); posById.set(personId, n); return n;
  }

  for (const [a, pos] of slotPos) {
    makeNode(a, pos.anchorCx - NODE_W / 2, pos.y);
    const slot = slotByAnchor.get(a);
    for (let i = 0; i < slot.satellites.length; i++) {
      const sid = slot.satellites[i];
      makeNode(sid, pos.satelliteCxs[i] - NODE_W / 2, pos.y);
    }
  }

  // Any person not placed (true orphan — not anchor, not satellite, no spouse-anchor):
  let orphanCursor = cursor;
  for (const p of state.persons) {
    if (posById.has(p.id)) continue;
    const g = gen.get(p.id) ?? 0;
    makeNode(p.id, orphanCursor, marginT + g * ROW_H);
    orphanCursor += NODE_W + FAMILY_GAP;
  }

  // --- edges ----------------------------------------------------------
  const links = [];
  for (const e of state.edges) {
    const a = posById.get(e.from_id), b = posById.get(e.to_id);
    if (!a || !b) continue;
    links.push({ e, a, b });
  }

  // --- bounds + normalize ---------------------------------------------
  const minX = Math.min(...nodes.map(n => n.x));
  const maxX = Math.max(...nodes.map(n => n.x + n.w));
  const maxY = Math.max(...nodes.map(n => n.y + n.h));
  const shift = marginL - minX;
  for (const n of nodes) { n.x += shift; n.cx += shift; }
  for (const [, pos] of slotPos) {
    pos.anchorCx += shift;
    pos.satelliteCxs = pos.satelliteCxs.map(x => x + shift);
    pos.slotLeftX += shift;
  }

  const totalW = (maxX + shift) + marginR;
  const totalH = maxY + marginB;

  return {
    nodes, links, posById,
    slotByAnchor, slotPos, childSlotsOfAnchor, satelliteOf, spouseEdges,
    forcedSatelliteOf, parentOf, primaryPartnerOf,
    totalW, totalH,
    marginL, marginT,
  };
}

function fitTree(opts = {}) {
  state.layout = computeLayout();
  if (!state.layout) return;
  const canvas = document.getElementById('tree-canvas');
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (!cw || !ch) { requestAnimationFrame(() => fitTree(opts)); return; }
  const isMobile = window.innerWidth < 820;
  const topPad = isMobile ? 24 : 90;
  const sidePad = isMobile ? 16 : 24;
  const bottomPad = isMobile ? 90 : 24;
  const sx = (cw - sidePad * 2) / state.layout.totalW;
  const sy = (ch - topPad - bottomPad) / state.layout.totalH;
  // Default fit: aim for readable zoom; allow pan. "all" variant shows entire tree.
  const target = Math.min(sx, sy, 1) * 0.95;
  if (opts.all) {
    state.pz.k = Math.max(0.1, target);
  } else if (isMobile) {
    // Mobile default: scale so the full HEIGHT fits (no clamp), user pans horizontally.
    state.pz.k = Math.min(1, sy * 0.95);
  } else {
    state.pz.k = Math.max(target, 0.65);
  }
  // Center. On mobile, prefer centering on the "newest" (rightmost) generations where the current family lives.
  if (isMobile && !opts.all) {
    const viewW = state.layout.totalW * state.pz.k;
    state.pz.x = cw - viewW - sidePad; // flush-right so Maximilian / latest generation visible first
  } else {
    state.pz.x = sidePad + (cw - sidePad * 2 - state.layout.totalW * state.pz.k) / 2;
  }
  state.pz.y = topPad + (ch - topPad - bottomPad - state.layout.totalH * state.pz.k) / 2;
  renderTree();
}

function renderTree() {
  const svg = document.getElementById('tree');
  state.layout = computeLayout();
  svg.innerHTML = '';

  if (!state.layout) {
    const t = textEl(0, 0, 'Noch keine Personen angelegt.', { anchor: 'middle', cls: 'tree-empty-text' });
    svg.appendChild(t);
    return;
  }

  const { nodes, links, posById, totalW, totalH, marginT } = state.layout;

  const canvas = document.getElementById('tree-canvas');
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // clipPaths for round portraits — coordinates are in each node-group's LOCAL
  // space (same space the <image> sits in), not world space.
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  for (const n of nodes) {
    const cp = document.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    cp.setAttribute('id', 'clip-' + n.id);
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', NODE_W / 2);
    c.setAttribute('cy', AVATAR_R);
    c.setAttribute('r', AVATAR_R);
    cp.appendChild(c);
    defs.appendChild(cp);
  }
  svg.appendChild(defs);

  const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.setAttribute('transform', `translate(${state.pz.x} ${state.pz.y}) scale(${state.pz.k})`);
  svg.appendChild(root);

  // ------------ EDGES (drawn under nodes) --------------------------------
  const edgeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgeG.setAttribute('class', 'edges');

  // Index spouse edges for status lookup.
  const spouseEdgeMap = new Map();
  for (const e of state.edges) {
    if (e.type !== 'spouse') continue;
    const k = e.from_id < e.to_id ? `${e.from_id}|${e.to_id}` : `${e.to_id}|${e.from_id}`;
    spouseEdgeMap.set(k, e);
  }

  function marriageGlyph(status) {
    // Returns { symbol, cls, label } for the given marriage status.
    switch (status) {
      case 'divorced': return { symbol: '',  cls: 'edge-glyph divorced', label: 'geschieden' };
      case 'widowed':  return { symbol: '❤', cls: 'edge-glyph widowed',  label: 'verwitwet'  };
      case 'engaged':  return { symbol: '◯', cls: 'edge-glyph engaged',  label: 'verlobt'    };
      case 'partner':  return { symbol: '∞', cls: 'edge-glyph partner',  label: 'Partner'    };
      case 'married':
      default:         return { symbol: '❤', cls: 'edge-glyph married',  label: null         };
    }
  }

  function drawDivorceSlashes(parent, cx, cy, yOffset = 0) {
    // Two parallel diagonal slash marks. yOffset lifts them above the line
    // so they don't crowd the "GESCHIEDEN" label underneath.
    const SLASH_LEN = 10;
    const SLASH_SPACING = 6;
    const y = cy + yOffset;
    for (const dx of [-SLASH_SPACING / 2, SLASH_SPACING / 2]) {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      s.setAttribute('x1', cx + dx - SLASH_LEN / 2);
      s.setAttribute('y1', y + SLASH_LEN / 2);
      s.setAttribute('x2', cx + dx + SLASH_LEN / 2);
      s.setAttribute('y2', y - SLASH_LEN / 2);
      s.setAttribute('class', 'edge-slash');
      parent.appendChild(s);
    }
  }

  // 1. Satellite spouse edges — within each slot, horizontal line from anchor
  //    through its satellites. Each (anchor, satellite_i) segment gets the
  //    status glyph of that specific relationship.
  const { slotByAnchor, slotPos, childSlotsOfAnchor, satelliteOf } = state.layout;
  const drawnCouples = new Set();
  function drawSpouseSegment(leftNode, rightNode, edge) {
    if (!leftNode || !rightNode || !edge) return;
    const key = edge.from_id < edge.to_id ? `${edge.from_id}|${edge.to_id}` : `${edge.to_id}|${edge.from_id}`;
    drawnCouples.add(key);
    const status = edge.status || 'married';
    const glyph = marriageGlyph(status);
    const y = leftNode.y + AVATAR_R;
    const xL = leftNode.cx + AVATAR_R;
    const xR = rightNode.cx - AVATAR_R;
    if (xR <= xL) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', xL); line.setAttribute('x2', xR);
    line.setAttribute('y1', y);  line.setAttribute('y2', y);
    line.setAttribute('class', `edge-spouse status-${status}`);
    edgeG.appendChild(line);
    const mx = (xL + xR) / 2;
    if (status === 'divorced') {
      // Lift slashes above the line; label sits well below.
      drawDivorceSlashes(edgeG, mx, y, -10);
    } else if (glyph.symbol) {
      const sym = textEl(mx, y, glyph.symbol, { anchor: 'middle', cls: glyph.cls });
      edgeG.appendChild(sym);
    }
    if (glyph.label) {
      const lbl = textEl(mx, y + 20, glyph.label, { anchor: 'middle', cls: `edge-label status-${status}` });
      edgeG.appendChild(lbl);
    }
  }
  for (const [anchorId, slot] of slotByAnchor) {
    if (!slot.satellites.length) continue;
    const anchorNode = posById.get(anchorId);
    if (!anchorNode) continue;
    let prev = anchorNode;
    for (const satId of slot.satellites) {
      const satNode = posById.get(satId);
      if (!satNode) continue;
      const k = anchorId < satId ? `${anchorId}|${satId}` : `${satId}|${anchorId}`;
      const edge = spouseEdgeMap.get(k);
      drawSpouseSegment(prev, satNode, edge);
      prev = satNode;
    }
  }

  // Draw spouse edges that are NOT in any slot (cross-tree ties between two
  // anchors) — fallback dashed arc.
  for (const e of state.edges) {
    if (e.type !== 'spouse') continue;
    const key = e.from_id < e.to_id ? `${e.from_id}|${e.to_id}` : `${e.to_id}|${e.from_id}`;
    if (drawnCouples.has(key)) continue;
    const na = posById.get(e.from_id), nb = posById.get(e.to_id);
    if (!na || !nb) continue;
    const status = e.status || 'married';
    const glyph = marriageGlyph(status);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const y1 = na.y + AVATAR_R, y2 = nb.y + AVATAR_R;
    const mx = (na.cx + nb.cx) / 2;
    const my = (y1 + y2) / 2 - 30;
    path.setAttribute('d', `M${na.cx},${y1} Q${mx},${my} ${nb.cx},${y2}`);
    path.setAttribute('class', `edge-spouse-remote status-${status}`);
    edgeG.appendChild(path);
    if (status === 'divorced') {
      drawDivorceSlashes(edgeG, mx, my, -10);
    } else if (glyph.symbol) {
      const sym = textEl(mx, my, glyph.symbol, { anchor: 'middle', cls: glyph.cls });
      edgeG.appendChild(sym);
    }
    if (glyph.label) {
      const lbl = textEl(mx, my + 20, glyph.label, { anchor: 'middle', cls: `edge-label status-${status}` });
      edgeG.appendChild(lbl);
    }
  }

  // 2. Parent/child drop-lines — group kids by (anchor, co-parent) pair.
  //    Drop line comes from midpoint between anchor and the co-parent
  //    (when co-parent is a satellite in the anchor's slot) or from anchor alone.
  const PARENT_STUB = 18;
  const CHILD_STUB = 18;

  // Build (anchor, coparent) → [childNodes] groups.
  const dropGroups = new Map();
  for (const anchorId of slotByAnchor.keys()) {
    const kids = childSlotsOfAnchor.get(anchorId) || [];
    for (const c of kids) {
      const pars = parentOfInLayout(c);
      const other = pars.find(x => x !== anchorId);
      const key = `${anchorId}|${other || ''}`;
      if (!dropGroups.has(key)) dropGroups.set(key, { anchorId, coparentId: other || null, kids: [] });
      dropGroups.get(key).kids.push(c);
    }
  }
  function parentOfInLayout(childId) {
    const edges = state.edges.filter(e => e.type === 'parent' && e.to_id === childId);
    return edges.map(e => e.from_id);
  }

  for (const g of dropGroups.values()) {
    const kidsNodes = g.kids.map(id => posById.get(id)).filter(Boolean);
    if (!kidsNodes.length) continue;
    const anchorNode = posById.get(g.anchorId);
    if (!anchorNode) continue;
    const parentY = anchorNode.y + AVATAR_R * 2;
    const slot = slotByAnchor.get(g.anchorId);
    const sPos = slotPos.get(g.anchorId);
    let parentCx = anchorNode.cx;
    if (g.coparentId && slot && sPos) {
      const satIdx = slot.satellites.indexOf(g.coparentId);
      if (satIdx >= 0) {
        parentCx = (sPos.anchorCx + sPos.satelliteCxs[satIdx]) / 2;
      }
    }
    const childTopY = kidsNodes[0].y;
    const barY = (parentY + PARENT_STUB + childTopY - CHILD_STUB) / 2;

    // Drop from parent-midpoint down to barY
    const drop = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    drop.setAttribute('d', `M${parentCx},${parentY + 2} V${barY}`);
    drop.setAttribute('class', 'edge-parent');
    edgeG.appendChild(drop);

    // Horizontal sibling bar
    const minCx = Math.min(parentCx, ...kidsNodes.map(k => k.cx));
    const maxCx = Math.max(parentCx, ...kidsNodes.map(k => k.cx));
    if (maxCx > minCx) {
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      bar.setAttribute('d', `M${minCx},${barY} H${maxCx}`);
      bar.setAttribute('class', 'edge-parent');
      edgeG.appendChild(bar);
    }
    for (const kid of kidsNodes) {
      const vert = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      vert.setAttribute('d', `M${kid.cx},${barY} V${kid.y - 2}`);
      vert.setAttribute('class', 'edge-parent');
      edgeG.appendChild(vert);
    }
  }

  // Parent edges not drawn above (satellite → own child, or cross-tree):
  // dashed arc.
  const drawnParent = new Set();
  for (const anchorId of slotByAnchor.keys()) {
    const kids = childSlotsOfAnchor.get(anchorId) || [];
    const slot = slotByAnchor.get(anchorId);
    for (const c of kids) {
      drawnParent.add(`${anchorId}|${c}`);
      for (const s of slot.satellites) drawnParent.add(`${s}|${c}`);
    }
  }
  for (const e of state.edges) {
    if (e.type !== 'parent') continue;
    if (drawnParent.has(`${e.from_id}|${e.to_id}`)) continue;
    const na = posById.get(e.from_id), nb = posById.get(e.to_id);
    if (!na || !nb) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${na.cx},${na.y + AVATAR_R * 2} C${na.cx},${na.y + 160} ${nb.cx},${nb.y - 100} ${nb.cx},${nb.y}`);
    path.setAttribute('class', 'edge-parent-remote');
    edgeG.appendChild(path);
  }

  root.appendChild(edgeG);

  // ------------ NODES ----------------------------------------------------
  const nodeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodeG.setAttribute('class', 'nodes');
  for (const n of nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node ' + (n.person.gender || ''));
    g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    if (state.selected === n.id) g.classList.add('selected');

    // Avatar background circle (acts as frame + fallback bg)
    const bgCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bgCircle.setAttribute('cx', NODE_W / 2);
    bgCircle.setAttribute('cy', AVATAR_R);
    bgCircle.setAttribute('r', AVATAR_R);
    bgCircle.setAttribute('class', 'node-avatar');
    g.appendChild(bgCircle);

    // Portrait image if available (clipped to circle)
    if (n.person.portrait_image_id) {
      const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      img.setAttribute('x', NODE_W / 2 - AVATAR_R);
      img.setAttribute('y', 0);
      img.setAttribute('width', AVATAR_R * 2);
      img.setAttribute('height', AVATAR_R * 2);
      img.setAttribute('href', '/api/images/' + n.person.portrait_image_id);
      img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      img.setAttribute('clip-path', `url(#clip-${n.id})`);
      g.appendChild(img);
    } else {
      // Initials fallback
      const init = textEl(NODE_W / 2, AVATAR_R, initialsOf(n.person), { anchor: 'middle', cls: 'node-initials' });
      g.appendChild(init);
    }

    // Ring (over the image, so selected state is visible)
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('cx', NODE_W / 2);
    ring.setAttribute('cy', AVATAR_R);
    ring.setAttribute('r', AVATAR_R);
    ring.setAttribute('class', 'node-ring');
    g.appendChild(ring);

    // Name (wrapped — center-aligned, one tspan per line).
    const nmText = primaryNameOf(n.person);
    const nameLines = wrapText(nmText, NAME_WRAP_W);
    const nameT = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    nameT.setAttribute('x', NODE_W / 2);
    nameT.setAttribute('y', AVATAR_R * 2 + 18);
    nameT.setAttribute('text-anchor', 'middle');
    nameT.setAttribute('class', 'node-name');
    for (let i = 0; i < nameLines.length; i++) {
      const ts = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      ts.setAttribute('x', NODE_W / 2);
      if (i > 0) ts.setAttribute('dy', NAME_LINE_H);
      ts.textContent = nameLines[i];
      nameT.appendChild(ts);
    }
    g.appendChild(nameT);

    // Dates — positioned below the wrapped name block.
    const dates = fmtLifeShort(n.person);
    let belowY = AVATAR_R * 2 + 18 + nameLines.length * NAME_LINE_H + 2;
    if (dates) {
      const dT = textEl(NODE_W / 2, belowY, dates, { anchor: 'middle', cls: 'node-dates' });
      g.appendChild(dT);
      belowY += 14;
    }

    // "geb. <Surname>" label when this person is a forced-satellite with
    // birth parents in another sub-tree (classic Genealogie convention).
    const forcedSatMap = state.layout?.forcedSatelliteOf;
    if (forcedSatMap?.has(n.id)) {
      const parEdges = state.edges.filter(e => e.type === 'parent' && e.to_id === n.id);
      const birthSurname = (() => {
        if (n.person.birth_name && n.person.birth_name !== n.person.surname) return n.person.birth_name;
        for (const e of parEdges) {
          const par = state.persons.find(x => x.id === e.from_id);
          const s = par?.surname;
          if (s && s !== n.person.surname) return s;
        }
        return null;
      })();
      if (parEdges.length) {
        const text = birthSurname ? `geb. ${birthSurname}` : 'geb.';
        const gebT = textEl(NODE_W / 2, belowY, text, { anchor: 'middle', cls: 'node-geb' });
        g.appendChild(gebT);
      }
    }

    g.onclick = () => select(n.id);
    if (window.matchMedia('(hover: hover)').matches) {
      g.onmouseenter = () => showNodeHover(n);
      g.onmouseleave = () => hideNodeHover();
    }
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${nmText}${dates ? ' ' + dates : ''}`);
    g.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id); } };

    nodeG.appendChild(g);
  }
  root.appendChild(nodeG);
}

function textEl(x, y, str, { anchor = 'start', cls = '' } = {}) {
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  if (anchor) t.setAttribute('text-anchor', anchor);
  if (cls) t.setAttribute('class', cls);
  t.setAttribute('dominant-baseline', 'middle');
  t.textContent = str || '';
  return t;
}

function showNodeHover(n) {
  const el = document.getElementById('tree-hover');
  const p = n.person;
  const bits = [];
  if (p.birth_date) bits.push(`* ${fmtDateDisplay(p.birth_date)}${p.birth_place ? ', ' + p.birth_place : ''}`);
  if (p.death_date) bits.push(`✝ ${fmtDateDisplay(p.death_date)}${p.death_place ? ', ' + p.death_place : ''}`);
  el.innerHTML = '';
  el.appendChild(h('h4', {}, fullNameOf(p)));
  for (const b of bits) el.appendChild(h('div', { class: 'meta' }, b));
  if (p.notes) el.appendChild(h('div', { class: 'note' }, p.notes.slice(0, 110) + (p.notes.length > 110 ? '…' : '')));
  el.hidden = false;
  // Position to the right of the node, clamped to viewport.
  const canvasRect = document.getElementById('tree-canvas').getBoundingClientRect();
  const nodeRight = (n.x + n.w) * state.pz.k + state.pz.x;
  const nodeTop = n.y * state.pz.k + state.pz.y;
  const hoverW = el.offsetWidth || 240;
  const hoverH = el.offsetHeight || 100;
  let left = nodeRight + 12;
  let top = nodeTop;
  if (left + hoverW > canvasRect.width - 12) left = Math.max(12, (n.x * state.pz.k + state.pz.x) - hoverW - 12);
  if (top + hoverH > canvasRect.height - 12) top = Math.max(12, canvasRect.height - hoverH - 12);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.transform = 'none';
}
function hideNodeHover() {
  document.getElementById('tree-hover').hidden = true;
}

/* --- Pan / Zoom ----------------------------------------------------- */
function setupPanZoom() {
  const canvas = document.getElementById('tree-canvas');
  const svg = document.getElementById('tree');

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const scale = Math.exp(-ev.deltaY * 0.002);
    const newK = Math.max(0.1, Math.min(3, state.pz.k * scale));
    const ratio = newK / state.pz.k;
    state.pz.x = px - (px - state.pz.x) * ratio;
    state.pz.y = py - (py - state.pz.y) * ratio;
    state.pz.k = newK;
    renderTree();
  }, { passive: false });

  let dragStart = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.node')) return;
    svg.setPointerCapture(ev.pointerId);
    dragStart = { x: ev.clientX, y: ev.clientY, pzx: state.pz.x, pzy: state.pz.y };
    hideNodeHover();
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!dragStart) return;
    state.pz.x = dragStart.pzx + (ev.clientX - dragStart.x);
    state.pz.y = dragStart.pzy + (ev.clientY - dragStart.y);
    renderTree();
  });
  svg.addEventListener('pointerup', () => dragStart = null);
  svg.addEventListener('pointercancel', () => dragStart = null);

  document.getElementById('btn-zoom-in').onclick = () => zoomBy(1.3);
  document.getElementById('btn-zoom-out').onclick = () => zoomBy(1 / 1.3);
  document.getElementById('btn-zoom-fit').onclick = () => fitTree({ all: true });
}
function zoomBy(f) {
  const canvas = document.getElementById('tree-canvas');
  const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
  const newK = Math.max(0.1, Math.min(3, state.pz.k * f));
  const ratio = newK / state.pz.k;
  state.pz.x = cx - (cx - state.pz.x) * ratio;
  state.pz.y = cy - (cy - state.pz.y) * ratio;
  state.pz.k = newK;
  renderTree();
}

/* --- Detail --------------------------------------------------------- */
function relationsOf(id) {
  const byBirth = (a, b) => (year(a.birth_date) || '9999').localeCompare(year(b.birth_date) || '9999');
  const parents = state.edges.filter(e => e.type === 'parent' && e.to_id === id).map(e => state.persons.find(x => x.id === e.from_id)).filter(Boolean).sort(byBirth);
  const children = state.edges.filter(e => e.type === 'parent' && e.from_id === id).map(e => state.persons.find(x => x.id === e.to_id)).filter(Boolean).sort(byBirth);
  const spouses = state.edges.filter(e => e.type === 'spouse' && (e.from_id === id || e.to_id === id))
    .map(e => ({ p: state.persons.find(x => x.id === (e.from_id === id ? e.to_id : e.from_id)), since: e.since, until: e.until, status: e.status }))
    .filter(x => x.p)
    .sort((a, b) => (a.since || '9999').localeCompare(b.since || '9999') || byBirth(a.p, b.p));
  // Siblings
  const myParents = parents.map(x => x.id);
  const siblings = myParents.length
    ? [...new Set(state.edges.filter(e => e.type === 'parent' && myParents.includes(e.from_id) && e.to_id !== id).map(e => e.to_id))]
      .map(sid => state.persons.find(x => x.id === sid)).filter(Boolean).sort(byBirth)
    : [];
  return { parents, children, spouses, siblings };
}

function renderDetail() {
  const emptyEl = document.getElementById('detail-empty');
  const el = document.getElementById('detail');
  const pane = document.querySelector('.pane-detail');
  if (!state.selected) {
    emptyEl.hidden = false; el.hidden = true;
    pane?.classList.remove('expanded');
    return;
  }
  const p = state.persons.find(x => x.id === state.selected);
  if (!p) { emptyEl.hidden = false; el.hidden = true; pane?.classList.remove('expanded'); return; }
  emptyEl.hidden = true; el.hidden = false;
  pane?.classList.add('expanded');

  const { parents, children, spouses, siblings } = relationsOf(p.id);
  el.innerHTML = '';

  // ---- Hero ----------------------------------------------------------
  const hero = h('div', { class: 'dossier-hero' },
    (() => {
      const btn = h('button', { class: 'detail-close icon-btn', 'aria-label': 'Schließen' });
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6l-12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';
      btn.onclick = () => { state.selected = null; render(); closeDrawers(); };
      return btn;
    })(),
    (() => {
      const portrait = h('div', { class: 'dossier-portrait' });
      if (p.portrait_image_id) {
        portrait.appendChild(h('img', { src: '/api/images/' + p.portrait_image_id, alt: nameOf(p) }));
      } else {
        portrait.appendChild(h('span', { class: 'dossier-initials' }, initialsOf(p)));
      }
      return portrait;
    })(),
    h('div', { class: 'dossier-id' },
      h('span', { class: 'dossier-eyebrow' }, [
        p.birth_place || p.death_place || null,
        yearRange(p),
      ].filter(Boolean).join(' · ')),
      (() => {
        const h2 = h('h2', {}, primaryNameOf(p));
        if (hasAltName(p)) h2.appendChild(h('em', {}, nameOf(p)));
        else if (p.birth_name && p.birth_name !== p.surname) h2.appendChild(h('em', {}, 'geborene ' + p.birth_name));
        return h2;
      })(),
    ),
  );
  el.appendChild(hero);

  // ---- Lifespan ------------------------------------------------------
  if (p.birth_date || p.death_date || p.birth_place || p.death_place) {
    el.appendChild(h('div', { class: 'lifespan' },
      h('div', { class: 'born' },
        h('b', {}, p.birth_date ? fmtDateDisplay(p.birth_date) : '?'),
        p.birth_place ? h('small', {}, 'geboren in ' + p.birth_place) : null,
      ),
      h('div', { class: 'arc' }, p.death_date ? '→' : 'lebt'),
      h('div', { class: 'died' },
        p.death_date ? h('b', {}, fmtDateDisplay(p.death_date)) : h('b', {}, '—'),
        p.death_place ? h('small', {}, 'gestorben in ' + p.death_place) : null,
      ),
    ));
  }

  // ---- Biography card (collapsible) ---------------------------------
  const bioSection = h('div', { class: 'section dossier-section', id: 'bio-section' },
    h('h3', {}, 'Biografie'),
    h('div', { id: 'bio-body', class: 'bio-body' }, h('div', { class: 'meta' }, 'Lade…')),
  );
  el.appendChild(bioSection);
  loadBiography(p.id);

  // ---- Historischer Kontext (auto, no backend) ----------------------
  const histEvents = historicalContextFor(p);
  if (histEvents.length) {
    const histSection = h('div', { class: 'section dossier-section' },
      h('h3', {}, 'Historischer Kontext'),
      h('ul', { class: 'ctx-list' },
        ...histEvents.map(e => h('li', {}, [e.label, e.years && h('small', {}, e.years)].filter(Boolean))),
      ),
    );
    el.appendChild(histSection);
  }

  // ---- Familie (round mini-cards) -----------------------------------
  const famSection = h('div', { class: 'section dossier-section' },
    h('h3', {}, 'Familie'),
    h('div', { class: 'family-grid' },
      familyGroup('Eltern', parents),
      familyGroup('Ehepartner', spouses.map(s => s.p), { kind: 'spouse', personId: p.id }),
      familyGroup('Geschwister', siblings),
      familyGroup('Kinder', children),
    ),
  );
  el.appendChild(famSection);

  // ---- Beruf & Karriere ---------------------------------------------
  el.appendChild(subSection('education', 'Ausbildung & Studium', p.id, renderEducation));
  el.appendChild(subSection('jobs', 'Beruf & Karriere', p.id, renderJob));
  // ---- Wohnorte -----------------------------------------------------
  el.appendChild(subSection('residences', 'Wohnorte', p.id, renderResidence));
  // ---- Militärdienst ------------------------------------------------
  el.appendChild(subSection('military', 'Militärdienst', p.id, renderMilitary));
  // ---- Anekdoten ----------------------------------------------------
  el.appendChild(subSection('anecdotes', 'Anekdoten & Erinnerungen', p.id, renderAnecdote));
  // ---- Gesundheit (editor only) -------------------------------------
  if (state.role === 'editor') {
    el.appendChild(subSection('health-events', 'Gesundheit & Erbliches', p.id, renderHealth, { confidential: true, collapsed: true }));
  }

  // ---- Dokumente & Fotos --------------------------------------------
  const docHead = h('div', { class: 'section-head' },
    h('h3', {}, 'Dokumente & Fotos'),
  );
  if (state.role === 'editor') {
    const uploadBtn = h('button', { class: 'btn-ghost sub-add' }, '+ Bild');
    uploadBtn.onclick = () => openImageUpload(p.id);
    docHead.appendChild(uploadBtn);
  }
  const docSection = h('div', { class: 'section dossier-section' },
    docHead,
    h('div', { class: 'meta sub-hint' }, 'Urkunden, Fotos und Portraits. Mit ☆ ein Bild zum Profilbild machen.'),
    h('div', { class: 'image-grid', id: 'image-grid-' + p.id }, h('div', { class: 'meta' }, 'Lade…')),
  );
  el.appendChild(docSection);
  loadImagesInto(p.id, docSection.querySelector('.image-grid'));

  // ---- Externe Quellen (Research) -----------------------------------
  const resSection = h('div', { class: 'section dossier-section', id: 'ext-sources-section' },
    h('h3', {}, 'Externe Quellen'),
    h('div', { id: 'ext-sources-body' }, h('div', { class: 'meta' }, 'Lade…')),
  );
  el.appendChild(resSection);
  loadResearchHits(p.id);

  // ---- KI-Recherche (bestehend) -------------------------------------
  const aiSection = h('div', { class: 'section dossier-section', id: 'ai-section' },
    h('h3', {}, 'KI-Dossier (Verwandtschaft)'),
    h('div', { id: 'ai-latest' }, h('div', { class: 'meta' }, 'Lade…')),
  );
  el.appendChild(aiSection);
  loadLatestResearch(p.id);

  // ---- Quellen & Notizen --------------------------------------------
  if (p.notes) {
    el.appendChild(h('div', { class: 'section dossier-section' },
      h('h3', {}, 'Quellen & Notizen'),
      h('div', { class: 'notes' }, p.notes),
    ));
  }

  // ---- Actions ------------------------------------------------------
  if (state.role === 'editor') {
    const actions = h('div', { class: 'actions' });
    actions.appendChild(btnOutline('Bearbeiten', () => openPersonDialog(p)));
    actions.appendChild(btnOutline('📎 Dokument', () => openImageUpload(p.id)));
    actions.appendChild(btnOutline('Löschen', async () => {
      if (!confirm(`${nameOf(p)} löschen?`)) return;
      await api.remove(p.id); state.selected = null; await reload();
    }, 'btn-danger'));
    el.appendChild(actions);
  }

  // Auto-trigger biography if enough facts and none yet.
  maybeAutoGenerateBio(p);
}

function yearRange(p) {
  const b = year(p.birth_date), d = year(p.death_date);
  if (b && d) return `${b} – ${d}`;
  if (b) return `${b} – lebt`;
  if (d) return `† ${d}`;
  return '';
}

function familyGroup(title, people, opts = {}) {
  if (!people.length) return h('div');
  const isSpouse = opts.kind === 'spouse';
  const wrap = h('div', { class: 'family-col' },
    h('div', { class: 'family-title' }, title),
  );
  const cards = h('div', { class: 'family-cards' });
  for (const x of people) {
    const card = h('button', { class: 'family-card', 'data-id': x.id },
      h('div', { class: 'family-avatar' },
        x.portrait_image_id
          ? h('img', { src: '/api/images/' + x.portrait_image_id, alt: nameOf(x) })
          : h('span', {}, initialsOf(x)),
      ),
      h('div', { class: 'family-meta' },
        h('div', { class: 'family-name' }, primaryNameOf(x)),
        h('div', { class: 'family-dates' }, fmtLifeShort(x) || '—'),
        isSpouse ? (() => {
          const edge = findSpouseEdge(opts.personId, x.id);
          const status = edge?.status || 'married';
          const label = { divorced: 'geschieden', widowed: 'verwitwet', engaged: 'verlobt', partner: 'Lebenspartner', married: null }[status];
          return label ? h('div', { class: 'family-status status-' + status }, label) : null;
        })() : null,
      ),
    );
    card.onclick = () => select(x.id);
    const row = h('div', { class: 'family-card-row' }, card);
    if (isSpouse && state.role === 'editor') {
      const edge = findSpouseEdge(opts.personId, x.id);
      if (edge) {
        const edit = h('button', { class: 'family-card-edit', title: 'Beziehung bearbeiten', 'aria-label': 'Beziehung bearbeiten' });
        edit.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        edit.onclick = (ev) => { ev.stopPropagation(); openEdgeDialog(edge); };
        row.appendChild(edit);
      }
    }
    cards.appendChild(row);
  }
  wrap.appendChild(cards);
  return wrap;
}

/* --- historical context --------------------------------------------- */
const HISTORICAL = [
  { label: 'Weimarer Republik', from: 1918, to: 1933 },
  { label: 'Erster Weltkrieg',  from: 1914, to: 1918 },
  { label: 'Weltwirtschaftskrise', from: 1929, to: 1933 },
  { label: 'Nationalsozialismus', from: 1933, to: 1945 },
  { label: 'Zweiter Weltkrieg', from: 1939, to: 1945 },
  { label: 'Nachkriegszeit / Besatzung', from: 1945, to: 1949 },
  { label: 'DDR gegründet', from: 1949, to: 1990 },
  { label: 'Wirtschaftswunder BRD', from: 1950, to: 1973 },
  { label: 'Mauerbau Berlin', from: 1961, to: 1961 },
  { label: 'Mondlandung', from: 1969, to: 1969 },
  { label: 'Mauerfall', from: 1989, to: 1989 },
  { label: 'Deutsche Wiedervereinigung', from: 1990, to: 1990 },
  { label: 'Einführung des Euro', from: 2002, to: 2002 },
];
function historicalContextFor(p) {
  const b = parseInt(year(p.birth_date), 10);
  const d = parseInt(year(p.death_date), 10) || new Date().getFullYear();
  if (isNaN(b)) return [];
  return HISTORICAL
    .filter(ev => ev.from <= d && ev.to >= b)
    .slice(0, 8)
    .map(ev => ({ label: ev.label, years: ev.from === ev.to ? `${ev.from}` : `${ev.from}–${ev.to}` }));
}

/* --- generic sub-resource section ---------------------------------- */
function subSection(kind, title, personId, renderOne, opts = {}) {
  const box = h('div', { class: 'section dossier-section', id: `sub-${kind}-${personId}` });
  const head = h('div', { class: 'section-head' },
    h('h3', {}, title),
    opts.confidential ? h('span', { class: 'badge badge-conf' }, 'Vertraulich') : null,
    state.role === 'editor' ? btnOutline('+ Eintrag', () => openSubDialog(kind, personId), 'sub-add') : null,
  );
  box.appendChild(head);
  const body = h('div', { class: 'sub-body', id: `body-${kind}-${personId}` }, h('div', { class: 'meta' }, 'Lade…'));
  if (opts.collapsed) { box.classList.add('is-collapsed'); head.onclick = () => box.classList.toggle('is-collapsed'); head.style.cursor = 'pointer'; }
  box.appendChild(body);
  loadSub(kind, personId, body, renderOne);
  return box;
}

async function loadSub(kind, personId, body, renderOne) {
  try {
    const items = await api.listSub(personId, kind);
    body.innerHTML = '';
    if (!items.length) {
      body.appendChild(h('div', { class: 'meta' }, 'Keine Einträge.'));
      return;
    }
    for (const it of items) {
      const row = renderOne(it);
      if (state.role === 'editor') {
        const edit = h('button', { class: 'sub-edit', title: 'Bearbeiten', 'aria-label': 'Bearbeiten' });
        edit.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 20h4L20 8l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        edit.onclick = () => openSubDialog(kind, personId, it);
        row.appendChild(edit);
        const rm = h('button', { class: 'sub-rm', title: 'Entfernen', 'aria-label': 'Entfernen' }, '×');
        rm.onclick = async () => {
          if (!confirm('Diesen Eintrag löschen?')) return;
          await api.deleteSub(personId, kind, it.id);
          await loadSub(kind, personId, body, renderOne);
        };
        row.appendChild(rm);
      }
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}

function fmtRange(a, b) {
  return [a, b].filter(Boolean).map(fmtDateDisplay).join(' – ');
}
function renderJob(j) {
  return h('div', { class: 'sub-row' },
    h('div', { class: 'sub-title' }, j.title || 'Beruf'),
    h('div', { class: 'sub-sub' }, [j.employer, j.place].filter(Boolean).join(' · ')),
    h('div', { class: 'sub-range' }, fmtRange(j.start_date, j.end_date)),
    j.notes ? h('div', { class: 'sub-note' }, j.notes) : null,
  );
}
function renderEducation(e) {
  const titleLine = [e.institution, e.degree].filter(Boolean).join(' · ') || 'Ausbildung';
  const subLine   = [e.field, e.place].filter(Boolean).join(' · ');
  return h('div', { class: 'sub-row' },
    h('div', { class: 'sub-title' }, titleLine),
    h('div', { class: 'sub-sub' }, subLine),
    h('div', { class: 'sub-range' }, fmtRange(e.start_date, e.end_date)),
    e.notes ? h('div', { class: 'sub-note' }, e.notes) : null,
  );
}
function renderResidence(r) {
  return h('div', { class: 'sub-row' },
    h('div', { class: 'sub-title' }, r.place),
    h('div', { class: 'sub-sub' }, r.kind || ''),
    h('div', { class: 'sub-range' }, fmtRange(r.start_date, r.end_date)),
    r.notes ? h('div', { class: 'sub-note' }, r.notes) : null,
  );
}
function renderMilitary(m) {
  return h('div', { class: 'sub-row' },
    h('div', { class: 'sub-title' }, [m.branch, m.rank].filter(Boolean).join(' · ') || 'Militär'),
    h('div', { class: 'sub-sub' }, [m.unit, m.campaigns].filter(Boolean).join(' · ')),
    h('div', { class: 'sub-range' }, fmtRange(m.start_date, m.end_date)),
    m.notes ? h('div', { class: 'sub-note' }, m.notes) : null,
  );
}
function renderAnecdote(a) {
  return h('div', { class: 'sub-row anecdote' },
    h('div', { class: 'sub-title' }, a.title || 'Anekdote'),
    h('div', { class: 'sub-text' }, a.text),
    h('div', { class: 'sub-source' }, [a.year, a.source].filter(Boolean).join(' · ')),
  );
}
function renderHealth(e) {
  return h('div', { class: 'sub-row' },
    h('div', { class: 'sub-title' }, e.condition),
    h('div', { class: 'sub-sub' }, [fmtDateDisplay(e.date), e.hereditary ? 'erblich' : null].filter(Boolean).join(' · ')),
    e.notes ? h('div', { class: 'sub-note' }, e.notes) : null,
  );
}

const SUB_FIELDS = {
  education: [
    { name: 'institution', label: 'Einrichtung', type: 'text', placeholder: 'Schule, Universität, Lehrbetrieb' },
    { name: 'field',       label: 'Fach / Bereich', type: 'text', placeholder: 'z. B. Elektrotechnik, Jura, Tischler' },
    { name: 'degree',      label: 'Abschluss',   type: 'text', placeholder: 'Abitur, Diplom, Gesellenbrief …' },
    { name: 'place',       label: 'Ort',         type: 'text' },
    { name: 'start_date',  label: 'von',         type: 'text', placeholder: 'TT.MM.JJJJ' },
    { name: 'end_date',    label: 'bis',         type: 'text', placeholder: 'TT.MM.JJJJ' },
    { name: 'notes',       label: 'Notiz',       type: 'textarea' },
  ],
  jobs: [
    { name: 'title',      label: 'Position',   type: 'text' },
    { name: 'employer',   label: 'Arbeitgeber', type: 'text' },
    { name: 'place',      label: 'Ort',         type: 'text' },
    { name: 'start_date', label: 'von',         type: 'text', placeholder: 'TT.MM.JJJJ' },
    { name: 'end_date',   label: 'bis',         type: 'text' },
    { name: 'notes',      label: 'Notiz',       type: 'textarea' },
  ],
  residences: [
    { name: 'place',      label: 'Ort',    type: 'text' },
    { name: 'kind',       label: 'Art',    type: 'text', placeholder: 'z. B. Geburtsort, Elternhaus, Studienort' },
    { name: 'start_date', label: 'von',    type: 'text' },
    { name: 'end_date',   label: 'bis',    type: 'text' },
    { name: 'notes',      label: 'Notiz',  type: 'textarea' },
  ],
  military: [
    { name: 'branch',     label: 'Teilstreitkraft', type: 'text', placeholder: 'Heer, Marine, Luftwaffe' },
    { name: 'rank',       label: 'Dienstgrad', type: 'text' },
    { name: 'unit',       label: 'Einheit',    type: 'text' },
    { name: 'campaigns',  label: 'Feldzug / Einsatz', type: 'text' },
    { name: 'start_date', label: 'von',        type: 'text' },
    { name: 'end_date',   label: 'bis',        type: 'text' },
    { name: 'notes',      label: 'Notiz',      type: 'textarea' },
  ],
  anecdotes: [
    { name: 'title',  label: 'Titel',  type: 'text' },
    { name: 'text',   label: 'Text',   type: 'textarea', required: true },
    { name: 'source', label: 'Quelle', type: 'text' },
    { name: 'year',   label: 'Jahr',   type: 'text' },
  ],
  'health-events': [
    { name: 'condition',  label: 'Diagnose / Zustand', type: 'text', required: true },
    { name: 'date',       label: 'Datum', type: 'text' },
    { name: 'hereditary', label: 'erblich?', type: 'checkbox' },
    { name: 'notes',      label: 'Notiz', type: 'textarea' },
  ],
};

function openSubDialog(kind, personId, existing = null) {
  const dlg = document.getElementById('sub-dialog') || createSubDialog();
  const form = dlg.querySelector('form');
  form.innerHTML = '';
  const title = { jobs: 'Beruf', education: 'Ausbildung / Studium', residences: 'Wohnort', military: 'Militärdienst', anecdotes: 'Anekdote', 'health-events': 'Gesundheitseintrag' }[kind];
  const isEdit = !!existing;
  form.appendChild(h('h2', { class: 'dlg-title' }, (isEdit ? 'Eintrag bearbeiten · ' : 'Neuer Eintrag · ') + title));
  const fields = SUB_FIELDS[kind] || [];
  for (const f of fields) {
    const wrap = h('label', { class: 'field' });
    wrap.appendChild(h('span', {}, f.label + (f.required ? ' *' : '')));
    let input;
    if (f.type === 'textarea') input = h('textarea', { name: f.name, rows: '3', maxlength: '2000' });
    else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', name: f.name, value: '1' });
    else input = h('input', { type: 'text', name: f.name, maxlength: '400' });
    if (f.placeholder) input.setAttribute('placeholder', f.placeholder);
    if (f.required) input.setAttribute('required', '');
    if (isEdit && existing[f.name] != null) {
      if (f.type === 'checkbox') input.checked = !!Number(existing[f.name]);
      else if (/date|_at$|^date$|since|until|start|end/i.test(f.name)) input.value = fmtDateDisplay(existing[f.name]);
      else input.value = existing[f.name];
    }
    wrap.appendChild(input);
    form.appendChild(wrap);
  }
  const menu = h('menu', { class: 'dlg-actions' },
    (() => { const b = h('button', { type: 'button', class: 'btn-ghost' }, 'Abbrechen'); b.onclick = () => dlg.close(); return b; })(),
    h('button', { type: 'submit', class: 'btn-primary' }, isEdit ? 'Aktualisieren' : 'Speichern'),
  );
  form.appendChild(menu);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const f of fields) if (f.type === 'checkbox') data[f.name] = form.querySelector(`[name="${f.name}"]`).checked ? '1' : '';
    for (const [k, v] of Object.entries(data)) {
      if (/date|_at$|^date$|since|until|start|end/i.test(k)) data[k] = toIsoDate(v);
    }
    try {
      if (isEdit) await api.updateSub(personId, kind, existing.id, data);
      else await api.createSub(personId, kind, data);
      dlg.close();
      renderDetail();
    } catch (e) { alert('Fehler: ' + e.message); }
  };
  wireDateInputs(form);
  dlg.showModal();
}
function createSubDialog() {
  const dlg = h('dialog', { id: 'sub-dialog', class: 'dlg' });
  dlg.appendChild(h('form', { method: 'dialog', id: 'sub-form' }));
  document.body.appendChild(dlg);
  return dlg;
}

/* --- biography ------------------------------------------------------ */
async function loadBiography(personId) {
  const body = document.getElementById('bio-body');
  if (!body) return;
  try {
    const bio = await api.bio(personId);
    body.innerHTML = '';
    if (!bio) {
      body.appendChild(h('div', { class: 'meta' }, 'Noch keine Biografie erzeugt.'));
      if (state.role === 'editor') {
        const b = btnOutline('✎ Biografie schreiben', () => makeBio(personId));
        body.appendChild(h('div', { style: 'margin-top:8px' }, b));
      }
      return;
    }
    body.appendChild(h('div', { class: 'bio-narrative' }, bio.narrative));
    body.appendChild(h('div', { class: 'bio-foot' },
      h('div', { class: 'meta' }, 'Erzeugt ' + fmtDate(bio.generated_at) + (bio.model ? ' · ' + bio.model : '')),
      state.role === 'editor' ? btnOutline('↻ Neu generieren', () => makeBio(personId), 'small') : null,
    ));
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}
async function makeBio(personId) {
  const body = document.getElementById('bio-body');
  if (!body) return;
  body.innerHTML = '';
  body.appendChild(h('div', { class: 'meta' }, 'Claude schreibt die Biografie…'));
  try {
    await api.makeBio(personId);
    await loadBiography(personId);
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}

function maybeAutoGenerateBio(p) {
  if (state.role !== 'editor') return;
  const { parents, children, spouses } = relationsOf(p.id);
  const factCount =
    (p.given_name || p.surname ? 1 : 0) +
    (p.birth_date ? 1 : 0) +
    (p.death_date ? 1 : 0) +
    (parents.length ? 1 : 0) +
    (spouses.length ? 1 : 0) +
    (children.length ? 1 : 0);
  if (factCount < 3) return;
  // Fire-and-forget check: if no bio yet, start one
  api.bio(p.id).then(bio => {
    if (!bio && state.selected === p.id) makeBio(p.id);
  }).catch(() => { /* ignore */ });
}

/* --- external research hits ---------------------------------------- */
const activeJobPolls = new Map(); // personId → setInterval token

async function loadResearchHits(personId) {
  const body = document.getElementById('ext-sources-body');
  if (!body) return;
  try {
    const [sources, hits, consensusResp] = await Promise.all([
      api.researchSources().catch(() => []),
      api.listHits(personId),
      api.researchConsensus(personId).catch(() => ({ consensus: [] })),
    ]);
    body.innerHTML = '';
    renderConsensus(body, consensusResp?.consensus || []);
    renderSourceGrid(body, sources, hits, personId);
    renderHitsList(body, hits, personId);
    if (state.role === 'editor') {
      body.appendChild(h('div', { class: 'ext-head', style: 'margin-top: 16px' },
        btnOutline('🔎 Recherche starten', () => scrapeHits(personId)),
      ));
    }
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}

function renderConsensus(parent, consensus) {
  if (!consensus.length) return;
  const box = h('div', { class: 'consensus-box' },
    h('div', { class: 'eyebrow' }, 'Übereinstimmungen (≥ 2 Quellen)'),
    ...consensus.slice(0, 8).map(c => h('div', { class: 'consensus-row' },
      h('span', { class: 'consensus-field' }, consensusFieldLabel(c.field)),
      h('span', { class: 'consensus-value' }, c.value),
      h('span', { class: 'consensus-count' }, `${c.source_count}× ✓`),
      h('span', { class: 'consensus-sources' }, c.sources.join(' · ')),
    )),
  );
  parent.appendChild(box);
}
function consensusFieldLabel(f) {
  const m = { birth: 'Geburt', death: 'Tod', year: 'Jahr', mentioned_year: 'erwähnt', place: 'Ort', birth_death_hint: 'Datum-Hinweis' };
  return m[f] || f;
}

function renderSourceGrid(parent, sources, hits, personId) {
  if (!sources.length) return;
  const counts = {};
  for (const h of hits) counts[h.source] = (counts[h.source] || 0) + 1;
  const grid = h('div', { class: 'source-grid' });
  for (const s of sources) {
    const n = counts[s.key] || 0;
    const state_ = n > 0 ? 'done' : (s.note ? 'noted' : 'idle');
    const cell = h('button', {
      class: 'source-cell',
      'data-state': state_,
      title: s.label + (s.note ? ` · ${s.note}` : ''),
    },
      h('div', { class: 'source-cell-dot' }),
      h('div', { class: 'source-cell-label' }, s.key.toUpperCase()),
      h('div', { class: 'source-cell-count' }, n ? String(n) : '—'),
    );
    if (state.role === 'editor') {
      cell.onclick = async () => {
        cell.setAttribute('data-state', 'running');
        try {
          await api.scrapeSource(personId, s.key);
        } catch (e) { /* ignore */ }
        await loadResearchHits(personId);
      };
    }
    grid.appendChild(cell);
  }
  parent.appendChild(h('div', { class: 'source-grid-wrap' },
    h('div', { class: 'eyebrow' }, 'Quellen'),
    grid,
  ));
}

function renderHitsList(parent, hits, personId) {
  if (!hits.length) {
    parent.appendChild(h('div', { class: 'meta', style: 'margin-top: 12px' },
      'Noch keine externen Treffer gespeichert. "Recherche starten" scannt 17 Quellen.'));
    return;
  }
  const bySource = {};
  for (const hit of hits) (bySource[hit.source] ||= []).push(hit);
  const wrap = h('div', { class: 'hits-wrap' },
    h('div', { class: 'eyebrow' }, `Treffer (${hits.length})`),
  );
  for (const [src, group] of Object.entries(bySource)) {
    for (const hit of group) wrap.appendChild(renderHit(hit, personId));
  }
  parent.appendChild(wrap);
}

async function scrapeHits(personId) {
  const body = document.getElementById('ext-sources-body');
  if (!body) return;
  const progress = h('div', { class: 'scrape-progress' },
    h('div', { class: 'meta' }, 'Recherche läuft…'),
    h('div', { id: 'scrape-progress-grid', class: 'source-grid progress-grid' }),
  );
  body.insertBefore(progress, body.firstChild);
  let job;
  try {
    const { job_id } = await api.scrape(personId);
    job = job_id;
  } catch (e) {
    progress.remove();
    alert('Konnte Recherche-Job nicht starten: ' + e.message);
    return;
  }
  // Clear previous poll
  if (activeJobPolls.has(personId)) clearInterval(activeJobPolls.get(personId));
  const interval = setInterval(async () => {
    try {
      const info = await api.scrapeJob(job);
      renderProgressGrid(info);
      if (info.status === 'done' || info.status === 'failed' || info.status === 'cancelled') {
        clearInterval(interval);
        activeJobPolls.delete(personId);
        await loadResearchHits(personId);
      }
    } catch (e) {
      clearInterval(interval);
      activeJobPolls.delete(personId);
    }
  }, 2000);
  activeJobPolls.set(personId, interval);
}

function renderProgressGrid(job) {
  const grid = document.getElementById('scrape-progress-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const statuses = job.source_statuses || {};
  for (const key of (job.sources || [])) {
    const s = statuses[key] || { state: 'queued' };
    const cell = h('div', { class: 'source-cell', 'data-state': s.state },
      h('div', { class: 'source-cell-dot' }),
      h('div', { class: 'source-cell-label' }, key.toUpperCase()),
      h('div', { class: 'source-cell-count' }, s.count ? String(s.count) : (s.state === 'running' ? '…' : '—')),
    );
    grid.appendChild(cell);
  }
}

function renderHit(hit, personId) {
  const row = h('div', { class: 'hit', 'data-status': hit.status || 'pending' },
    h('div', { class: 'hit-src' }, (hit.source || '').toUpperCase()),
    h('div', { class: 'hit-main' },
      hit.url
        ? h('a', { href: hit.url, target: '_blank', rel: 'noopener', class: 'hit-title' }, hit.title || hit.url)
        : h('div', { class: 'hit-title' }, hit.title || '—'),
      h('div', { class: 'hit-snippet' }, hit.snippet || ''),
      h('div', { class: 'hit-conf' },
        h('div', { class: 'hit-conf-bar' },
          h('div', { class: 'hit-conf-fill', style: `width:${Math.round((hit.confidence || 0) * 100)}%` }),
        ),
        h('span', {}, Math.round((hit.confidence || 0) * 100) + '%'),
      ),
    ),
    state.role === 'editor' && (hit.status === 'pending' || !hit.status) ? h('div', { class: 'hit-actions' },
      btnOutline('Notiz', async () => { await api.applyHit(hit.id, 'add_source_note'); await loadResearchHits(personId); await reload(); }, 'small'),
      btnOutline('Verwerfen', async () => { await api.applyHit(hit.id, 'dismiss'); await loadResearchHits(personId); }, 'small btn-danger'),
    ) : h('div'),
  );
  return row;
}

function fmtMarriage(s) {
  const parts = [];
  if (s.since) parts.push(`⚭ ${year(s.since) || fmtDateDisplay(s.since)}`);
  if (s.until) parts.push(`⚮ ${year(s.until) || fmtDateDisplay(s.until)}`);
  return parts.join(' · ');
}

function relationBlock(title, people) {
  if (!people.length) return [];
  return [
    h('div', { class: 'relation', style: 'cursor: default; min-height: unset; padding-top: 12px; padding-bottom: 4px;' },
      h('div'),
      h('div', { class: 'eyebrow', style: 'margin: 0' }, title),
      h('div'),
    ),
    ...people.map(({ p, role }) => {
      const row = h('div', { class: 'relation', 'data-id': p.id },
        h('div', { class: 'avatar' }, initialsOf(p)),
        h('div', {},
          h('div', { class: 'name' }, nameOf(p)),
          h('div', { class: 'dates' }, fmtLifeShort(p)),
        ),
        role ? h('div', { class: 'role' }, role) : h('div'),
      );
      row.onclick = () => select(p.id);
      return row;
    })
  ];
}

function btnOutline(label, onclick, extraClass = '') {
  const b = h('button', { class: `btn-outline ${extraClass}` }, label);
  b.onclick = onclick;
  return b;
}

/* --- Images --------------------------------------------------------- */
async function loadImagesInto(personId, container) {
  try {
    const d = await api.personDetail(personId);
    container.innerHTML = '';
    if (!d.images?.length) {
      container.appendChild(h('div', { class: 'meta' }, 'Noch keine Dokumente verknüpft.'));
      return;
    }
    state.images.set(personId, d.images);
    d.images.forEach((img, idx) => {
      const tile = h('div', { class: 'image-tile', 'data-img': img.id });
      const isPdf = img.mime === 'application/pdf';
      if (isPdf) {
        tile.appendChild(h('div', { class: 'image-pdf' }, '📄 PDF'));
      } else {
        tile.appendChild(h('img', { src: '/api/images/' + img.id, alt: img.caption || img.role || '', loading: 'lazy' }));
      }
      if (img.role) tile.appendChild(h('div', { class: 'image-role' }, img.role));
      if (img.caption) tile.appendChild(h('div', { class: 'image-caption' }, img.caption));
      if (img.role === 'Portrait') tile.classList.add('is-portrait');
      tile.onclick = () => openLightbox(personId, idx);
      if (state.role === 'editor' && !isPdf) {
        const star = h('button', { class: 'image-portrait-btn', 'aria-label': 'als Portrait setzen', title: 'als Portrait setzen' }, img.role === 'Portrait' ? '★' : '☆');
        star.onclick = async (ev) => {
          ev.stopPropagation();
          try {
            await api.setPortrait(personId, img.id);
            await reload();
            const grid = document.getElementById('image-grid-' + personId);
            if (grid) await loadImagesInto(personId, grid);
          } catch (e) { alert('Fehler: ' + e.message); }
        };
        tile.appendChild(star);
      }
      if (state.role === 'editor') {
        const rm = h('button', { class: 'image-rm', 'aria-label': 'Verknüpfung lösen', title: 'Verknüpfung lösen' }, '×');
        rm.onclick = async (ev) => {
          ev.stopPropagation();
          if (!confirm('Verknüpfung zu dieser Person entfernen? (Bild bleibt an anderen Personen bestehen.)')) return;
          try {
            await api.unlinkImage(personId, img.id);
            await loadImagesInto(personId, container);
          } catch (e) { alert('Fehler: ' + e.message); }
        };
        tile.appendChild(rm);
      }
      container.appendChild(tile);
    });
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}

function openImageUpload(personId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,application/pdf';
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const caption = files.length === 1
      ? prompt(`Beschreibung für "${files[0].name}" (optional):`, files[0].name) ?? ''
      : '';
    const role = prompt('Art (Foto, Portrait, Heiratsurkunde, Geburtsurkunde, Sterbeurkunde, Dokument):', 'Foto') ?? 'Foto';
    const grid = document.getElementById('image-grid-' + personId);
    for (const file of files) {
      try {
        const cap = files.length === 1 ? caption : file.name;
        const img = await api.uploadImage(file, cap);
        await api.linkImage(personId, img.id, role || 'Foto');
        if (role === 'Portrait') {
          await api.setPortrait(personId, img.id);
        }
      } catch (e) {
        alert(`Upload fehlgeschlagen (${file.name}): ${e.message}`);
      }
    }
    if (grid) await loadImagesInto(personId, grid);
    await reload();
  };
  input.click();
}

/* --- Lightbox ------------------------------------------------------- */
const lb = { personId: null, idx: 0, zoom: 1, panX: 0, panY: 0 };

function openLightbox(personId, idx) {
  const images = state.images.get(personId) || [];
  if (!images.length) return;
  lb.personId = personId;
  lb.idx = idx;
  showLightbox();
  document.getElementById('lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  document.getElementById('lightbox').hidden = true;
  document.body.style.overflow = '';
}
function showLightbox() {
  const images = state.images.get(lb.personId) || [];
  const img = images[lb.idx];
  if (!img) return;
  const el = document.getElementById('lightbox-img');
  el.src = '/api/images/' + img.id;
  el.alt = img.caption || img.role || '';
  lb.zoom = 1; lb.panX = 0; lb.panY = 0;
  el.style.transform = 'translate(0, 0) scale(1)';
  document.getElementById('lightbox-stage').classList.remove('zoomed');
  document.getElementById('lightbox-caption').textContent = [img.role, img.caption].filter(Boolean).join(' · ');
  document.getElementById('lightbox-prev').style.visibility = lb.idx > 0 ? 'visible' : 'hidden';
  document.getElementById('lightbox-next').style.visibility = lb.idx < images.length - 1 ? 'visible' : 'hidden';
}
function toggleLightboxZoom(ev) {
  const stage = document.getElementById('lightbox-stage');
  const img = document.getElementById('lightbox-img');
  if (lb.zoom === 1) {
    lb.zoom = 2.4;
    const rect = img.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width - 0.5;
    const py = (ev.clientY - rect.top) / rect.height - 0.5;
    lb.panX = -px * rect.width * (lb.zoom - 1);
    lb.panY = -py * rect.height * (lb.zoom - 1);
    stage.classList.add('zoomed');
  } else {
    lb.zoom = 1; lb.panX = 0; lb.panY = 0;
    stage.classList.remove('zoomed');
  }
  img.style.transform = `translate(${lb.panX}px, ${lb.panY}px) scale(${lb.zoom})`;
}

/* --- AI Research ---------------------------------------------------- */
async function loadLatestResearch(personId) {
  const container = document.getElementById('ai-latest');
  if (!container) return;
  container.innerHTML = '';
  container.appendChild(h('div', { class: 'meta' }, 'Lade…'));
  try {
    const r = await api.latestResearch(personId);
    if (!r) {
      container.innerHTML = '';
      if (state.role === 'editor') {
        const b = btnOutline('🤖 KI-Research starten', () => runResearch(personId));
        container.appendChild(h('div', { class: 'meta', style: 'margin-bottom:12px' }, 'Noch keine KI-Recherche.'));
        container.appendChild(b);
      } else {
        container.appendChild(h('div', { class: 'meta' }, 'Keine KI-Recherche vorhanden.'));
      }
      return;
    }
    renderAiRun(container, personId, r);
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}

function renderAiRun(container, personId, r) {
  container.innerHTML = '';
  const run = h('div', { class: 'ai-run' });
  const data = r.data || r;
  const whenDate = fmtDate(r.completed_at || r.created_at);
  run.appendChild(h('div', { class: 'ai-run-head' },
    h('div', { class: 'model' }, r.model || 'Claude'),
    h('div', { class: 'when' }, 'Letzte Recherche · ' + whenDate),
  ));

  if (data.updates?.length) {
    run.appendChild(h('div', { class: 'ai-section-title' }, 'Neue Hinweise zu bekannten Personen'));
    for (const u of data.updates) {
      run.appendChild(h('div', { class: 'ai-update' },
        h('div', { class: 'target' }, u.name || ''),
        h('div', {},
          h('span', { class: 'field-key' }, u.feld || ''),
          h('span', { class: 'field-val' }, u.wert || ''),
        ),
        u.quellenhinweis ? h('div', { class: 'ai-sugg-src' }, u.quellenhinweis) : null,
      ));
    }
  }

  if (data.eltern?.length) {
    run.appendChild(h('div', { class: 'ai-section-title' }, 'Vorgeschlagene Eltern'));
    for (const p of data.eltern) run.appendChild(renderSuggestedPerson(p));
  }

  if (data.geschwister?.length) {
    run.appendChild(h('div', { class: 'ai-section-title' }, 'Vorgeschlagene Geschwister'));
    for (const p of data.geschwister) run.appendChild(renderSuggestedPerson(p));
  }

  if (data.hypothesen?.length) {
    run.appendChild(h('div', { class: 'ai-section-title' }, 'Hypothesen'));
    const ul = h('ul', { class: 'ai-list' });
    for (const hp of data.hypothesen) ul.appendChild(h('li', {}, hp));
    run.appendChild(ul);
  }
  if (data.quellen_vorschlag?.length) {
    run.appendChild(h('div', { class: 'ai-section-title' }, 'Quellen-Vorschläge'));
    const ul = h('ul', { class: 'ai-list' });
    for (const q of data.quellen_vorschlag) ul.appendChild(h('li', {}, q));
    run.appendChild(ul);
  }

  container.appendChild(run);

  if (state.role === 'editor') {
    const b = btnOutline('🔄 Erneut recherchieren', () => runResearch(personId));
    container.appendChild(h('div', { style: 'margin-top: 12px' }, b));
  }
}

function renderSuggestedPerson(s) {
  const sugg = h('div', { class: 'ai-sugg' },
    h('div', {},
      h('div', { class: 'ai-sugg-name' }, s.name || '?'),
      h('div', { class: 'ai-sugg-info' }, [
        s.rolle,
        s.geburt && s.geburt !== '?' ? '* ' + s.geburt : null,
        s.sterbe && s.sterbe !== '?' ? '✝ ' + s.sterbe : null,
        s.ort,
      ].filter(Boolean).join(' · ')),
      s.quellenhinweis ? h('div', { class: 'ai-sugg-src' }, s.quellenhinweis) : null,
    ),
    state.role === 'editor'
      ? btnOutline('+ Übernehmen', () => createPersonFromSuggestion(s))
      : h('div'),
  );
  return sugg;
}

async function runResearch(id) {
  const container = document.getElementById('ai-latest');
  container.innerHTML = '';
  container.appendChild(h('div', { class: 'meta' }, 'Claude denkt nach…'));
  try {
    await api.research(id);
    await loadLatestResearch(id);
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(h('div', { class: 'meta' }, 'Fehler: ' + e.message));
  }
}

async function createPersonFromSuggestion(s) {
  const names = (s.name || '').split(/\s+/);
  const surname = names.pop() || '';
  const given_name = names.join(' ') || '';
  const data = { given_name, surname, birth_date: s.geburt && s.geburt !== '?' ? s.geburt : '', birth_place: s.ort || '', notes: s.quellenhinweis || '' };
  try {
    const created = await api.create(data);
    const parentOrSibling = (s.rolle || '').toLowerCase();
    if (parentOrSibling.includes('vater') || parentOrSibling.includes('mutter') || parentOrSibling === 'eltern') {
      await api.createEdge({ from_id: created.id, to_id: state.selected, type: 'parent' });
    } else if (parentOrSibling.includes('geschwister') || parentOrSibling.includes('bruder') || parentOrSibling.includes('schwester')) {
      const myParents = state.edges.filter(e => e.type === 'parent' && e.to_id === state.selected).map(e => e.from_id);
      for (const pid of myParents) {
        try { await api.createEdge({ from_id: pid, to_id: created.id, type: 'parent' }); }
        catch (_) {}
      }
    }
    await reload();
  } catch (e) { alert('Fehler: ' + e.message); }
}

/* --- Dialogs -------------------------------------------------------- */
function openPersonDialog(p = null) {
  const dlg = document.getElementById('person-dialog');
  const form = document.getElementById('person-form');
  document.getElementById('person-dialog-title').textContent = p ? 'Person bearbeiten' : 'Neue Person';
  for (const f of form.elements) {
    if (!f.name) continue;
    const raw = p?.[f.name] ?? '';
    // Preload existing ISO dates in German display form so the user doesn't see 1941-07-21.
    f.value = /date|_at$/i.test(f.name) ? fmtDateDisplay(raw) : raw;
  }
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const [k, v] of Object.entries(data)) {
      if (/date|_at$/i.test(k)) data[k] = toIsoDate(v);
    }
    try {
      if (p) await api.update(p.id, data);
      else {
        const created = await api.create(data);
        state.selected = created.id;
      }
      dlg.close();
      await reload();
    } catch (e) { alert('Fehler: ' + e.message); }
  };
  wireDateInputs(form);
  dlg.showModal();
}

function openEdgeDialog(existing = null) {
  const dlg = document.getElementById('edge-dialog');
  const form = document.getElementById('edge-form');
  const title = document.getElementById('edge-dialog-title');
  const extra = document.getElementById('edge-spouse-extra');
  const isEdit = !!existing;
  title.textContent = isEdit ? 'Beziehung bearbeiten' : 'Beziehung anlegen';
  const opts = state.persons.map(p => `<option value="${p.id}">${escapeHtml(nameOf(p))}</option>`).join('');
  form.from_id.innerHTML = opts;
  form.to_id.innerHTML = opts;
  if (isEdit) {
    form.type.value = existing.type;
    form.type.disabled = true;
    form.from_id.value = existing.from_id;
    form.from_id.disabled = true;
    form.to_id.value = existing.to_id;
    form.to_id.disabled = true;
    if (form.status) form.status.value = existing.status || 'married';
    if (form.since)  form.since.value  = fmtDateDisplay(existing.since) || '';
    if (form.until)  form.until.value  = fmtDateDisplay(existing.until) || '';
  } else {
    form.type.disabled = false;
    form.from_id.disabled = false;
    form.to_id.disabled = false;
    if (state.selected) form.from_id.value = state.selected;
    if (form.status) form.status.value = 'married';
    if (form.since)  form.since.value  = '';
    if (form.until)  form.until.value  = '';
  }
  function syncExtra() { extra.hidden = form.type.value !== 'spouse'; }
  syncExtra();
  form.type.onchange = syncExtra;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const [k, v] of Object.entries(data)) {
      if (/since|until/i.test(k)) data[k] = toIsoDate(v);
    }
    try {
      if (isEdit) {
        // Only mutate status/since/until on existing edges — endpoints restrict others.
        const patch = {};
        if (existing.type === 'spouse') {
          patch.status = data.status || null;
          patch.since = data.since || null;
          patch.until = data.until || null;
        } else {
          patch.since = data.since || null;
          patch.until = data.until || null;
        }
        await api.updateEdge(existing.id, patch);
      } else {
        // Strip undefined status for parent edges.
        if (data.type !== 'spouse') { delete data.status; delete data.since; delete data.until; }
        await api.createEdge(data);
      }
      dlg.close();
      await reload();
    } catch (e) { alert('Fehler: ' + e.message); }
  };
  wireDateInputs(form);
  dlg.showModal();
}

function findSpouseEdge(a, b) {
  return state.edges.find(e =>
    e.type === 'spouse' &&
    ((e.from_id === a && e.to_id === b) || (e.from_id === b && e.to_id === a))
  );
}

function openImportDialog() {
  const dlg = document.getElementById('import-dialog');
  const form = document.getElementById('import-form');
  const status = document.getElementById('import-status');
  status.hidden = true;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const file = form.file.files?.[0];
    if (!file) return;
    status.textContent = 'Importiere…'; status.hidden = false;
    try {
      const r = await api.importGedcom(file);
      status.textContent = `${r.imported_persons} Personen, ${r.imported_edges} Beziehungen importiert.`;
      await reload();
      setTimeout(() => dlg.close(), 1800);
    } catch (e) {
      status.className = 'banner banner-err';
      status.textContent = 'Fehler: ' + e.message;
    }
  };
  dlg.showModal();
}

/* --- Mobile drawer -------------------------------------------------- */
function openDrawer(which) {
  document.getElementById('drawer-backdrop').hidden = false;
  if (which === 'list') document.querySelector('.pane-list').classList.add('open');
  if (which === 'detail') document.querySelector('.pane-detail').classList.add('open');
}
function closeDrawers() {
  document.getElementById('drawer-backdrop').hidden = true;
  document.querySelector('.pane-list')?.classList.remove('open');
  document.querySelector('.pane-detail')?.classList.remove('open');
}

/* --- Keyboard ------------------------------------------------------- */
function setupKeyboard() {
  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, textarea, select')) return;
    if (ev.key === '/') { ev.preventDefault(); document.getElementById('search').focus(); }
    else if (ev.key === 'n' && state.role === 'editor') { ev.preventDefault(); openPersonDialog(); }
    else if (ev.key === 'e' && state.role === 'editor') { ev.preventDefault(); openEdgeDialog(); }
    else if (ev.key === '?') { ev.preventDefault(); document.getElementById('help-dialog').showModal(); }
    else if (ev.key === 't') { ev.preventDefault(); toggleTheme(); }
    else if (ev.key === '+' || ev.key === '=') { zoomBy(1.3); }
    else if (ev.key === '-') { zoomBy(1/1.3); }
    else if (ev.key === '0') { fitTree(); }
    else if (ev.key === 'Escape') {
      if (!document.getElementById('lightbox').hidden) closeLightbox();
      else closeDrawers();
    }
    else if (ev.key === 'ArrowLeft' && !document.getElementById('lightbox').hidden) { if (lb.idx > 0) { lb.idx--; showLightbox(); } }
    else if (ev.key === 'ArrowRight' && !document.getElementById('lightbox').hidden) {
      const imgs = state.images.get(lb.personId) || [];
      if (lb.idx < imgs.length - 1) { lb.idx++; showLightbox(); }
    }
  });
}

/* --- Boot ----------------------------------------------------------- */
function wireUp() {
  document.addEventListener('click', (ev) => {
    if (ev.target.matches('[data-close]')) ev.target.closest('dialog')?.close();
  });
  document.getElementById('btn-add-person').onclick = () => openPersonDialog();
  document.getElementById('btn-add-edge').onclick = () => openEdgeDialog();
  document.getElementById('btn-import-gedcom').onclick = () => openImportDialog();
  document.getElementById('btn-logout').onclick = () => logout();
  document.getElementById('btn-theme').onclick = () => toggleTheme();
  document.getElementById('btn-help').onclick = () => document.getElementById('help-dialog').showModal();
  document.getElementById('search').oninput = (ev) => { state.filter = ev.target.value; renderList(); };
  document.getElementById('btn-search-mobile').onclick = () => openDrawer('list');
  document.getElementById('fab-list').onclick = () => openDrawer('list');
  document.getElementById('drawer-backdrop').onclick = () => closeDrawers();

  // Lightbox
  document.getElementById('lightbox-close').onclick = closeLightbox;
  document.getElementById('lightbox-stage').onclick = toggleLightboxZoom;
  document.getElementById('lightbox-prev').onclick = () => { if (lb.idx > 0) { lb.idx--; showLightbox(); } };
  document.getElementById('lightbox-next').onclick = () => {
    const imgs = state.images.get(lb.personId) || [];
    if (lb.idx < imgs.length - 1) { lb.idx++; showLightbox(); }
  };

  window.addEventListener('resize', () => renderTree());

  setupPanZoom();
  setupKeyboard();
}

(async function boot() {
  initTheme();
  wireUp();
  try {
    const me = await api.me();
    if (!me) { applyRole(); openLoginDialog(); return; }
    state.role = me.role;
    applyRole();
    await reload();
  } catch (e) {
    console.error(e);
    openLoginDialog();
  }
})();
