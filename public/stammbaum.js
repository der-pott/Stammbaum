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
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
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
    openDrawer('detail');
  }
}

/* --- Tree layout: timeline-based ------------------------------------ */
// text metrics cache
const _measureCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(400, 50) : null;
const _measureCtx = _measureCanvas?.getContext('2d');
function measureText(str, font = '600 14px "Instrument Sans", sans-serif') {
  if (!_measureCtx) return str.length * 8;
  _measureCtx.font = font;
  return _measureCtx.measureText(str).width;
}
function nodeSizeFor(person) {
  const label = primaryNameOf(person);
  const dates = fmtLifeShort(person);
  const nameW = measureText(label, '600 14px "Instrument Sans", sans-serif');
  const dateW = measureText(dates, '400 12px "Instrument Sans", sans-serif');
  const inner = Math.max(nameW, dateW);
  const w = Math.min(300, Math.max(140, Math.ceil(inner) + 48 + 16)); // avatar 32 + gap + padding
  return { w, h: 60 };
}

function computeLayout() {
  if (!state.persons.length) return null;

  const parentOf = new Map();
  const childOf = new Map();
  const spouseOf = new Map();
  for (const p of state.persons) { parentOf.set(p.id, []); childOf.set(p.id, []); spouseOf.set(p.id, new Set()); }
  for (const e of state.edges) {
    if (e.type === 'parent') { parentOf.get(e.to_id)?.push(e.from_id); childOf.get(e.from_id)?.push(e.to_id); }
    else if (e.type === 'spouse') { spouseOf.get(e.from_id)?.add(e.to_id); spouseOf.get(e.to_id)?.add(e.from_id); }
  }

  // generation via BFS from roots (no parents)
  const gen = new Map();
  const roots = state.persons.filter(p => parentOf.get(p.id).length === 0).map(p => p.id);
  const queue = roots.map(id => [id, 0]);
  while (queue.length) {
    const [id, g] = queue.shift();
    if (gen.has(id) && gen.get(id) >= g) continue;
    gen.set(id, g);
    for (const c of childOf.get(id) || []) queue.push([c, g + 1]);
    for (const s of spouseOf.get(id) || []) if (!gen.has(s)) queue.push([s, g]);
  }
  for (const p of state.persons) if (!gen.has(p.id)) gen.set(p.id, 0);

  // X-axis = birth year. For missing years, estimate from children's birth - 28 or parents + 28.
  const yearOf = new Map();
  for (const p of state.persons) {
    const y = parseInt(year(p.birth_date), 10);
    if (!isNaN(y)) yearOf.set(p.id, y);
  }
  // iterative propagate
  for (let pass = 0; pass < 5; pass++) {
    for (const p of state.persons) {
      if (yearOf.has(p.id)) continue;
      const kids = childOf.get(p.id)?.map(c => yearOf.get(c)).filter(Boolean) || [];
      const pars = parentOf.get(p.id)?.map(c => yearOf.get(c)).filter(Boolean) || [];
      const spsy = [...(spouseOf.get(p.id) || [])].map(c => yearOf.get(c)).filter(Boolean);
      if (kids.length) yearOf.set(p.id, Math.min(...kids) - 28);
      else if (pars.length) yearOf.set(p.id, Math.max(...pars) + 28);
      else if (spsy.length) yearOf.set(p.id, Math.round(spsy.reduce((a, b) => a + b) / spsy.length));
    }
  }
  // fallback: generation-based year
  const genYears = {};
  for (const [id, y] of yearOf) {
    const g = gen.get(id);
    (genYears[g] ||= []).push(y);
  }
  for (const p of state.persons) {
    if (yearOf.has(p.id)) continue;
    const g = gen.get(p.id);
    const siblings = genYears[g];
    yearOf.set(p.id, siblings?.length ? Math.round(siblings.reduce((a, b) => a + b) / siblings.length) : 1900 + g * 28);
  }

  const years = [...yearOf.values()];
  const minY = Math.min(...years);
  const maxY = Math.max(...years, new Date().getFullYear());
  const yearSpan = Math.max(maxY - minY, 20);

  const marginL = 80, marginR = 80, marginT = 100, marginB = 80;
  const pxPerYear = 10;
  const totalW = yearSpan * pxPerYear + marginL + marginR;
  const rowH = 140;

  // Position: X = year, Y = generation. Resolve collisions within same gen by shifting.
  const genGroups = new Map();
  for (const p of state.persons) {
    const g = gen.get(p.id);
    (genGroups.get(g) ?? genGroups.set(g, []).get(g)).push(p);
  }
  const nodes = [];
  const nodeH = 60;
  for (const [g, people] of [...genGroups].sort((a, b) => a[0] - b[0])) {
    people.sort((a, b) => yearOf.get(a.id) - yearOf.get(b.id));
    const placed = [];
    for (const p of people) {
      const { w, h } = nodeSizeFor(p);
      const yr = yearOf.get(p.id);
      let x = marginL + (yr - minY) * pxPerYear;
      let tries = 0;
      while (placed.some(q => Math.abs(q.x - x) < Math.max(q.w, w) + 24) && tries < 60) {
        x += (w + 24) / 2; tries++;
      }
      const y = marginT + g * rowH;
      nodes.push({ id: p.id, person: p, x, y, w, h, year: yr });
      placed.push({ x, w });
    }
  }
  const posById = new Map(nodes.map(n => [n.id, n]));

  // Edges
  const links = [];
  for (const e of state.edges) {
    const a = posById.get(e.from_id), b = posById.get(e.to_id);
    if (!a || !b) continue;
    links.push({ e, a, b });
  }

  const maxX = Math.max(...nodes.map(n => n.x + n.w), totalW);
  const maxYpx = Math.max(...nodes.map(n => n.y + n.h)) + marginB;

  return { nodes, links, posById, totalW: maxX + marginR, totalH: maxYpx, minY, maxY, pxPerYear, marginL, marginT };
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
    // Mobile default: readable zoom, user pans horizontally. Fit the HEIGHT so a vertical slice is visible.
    state.pz.k = Math.max(0.55, Math.min(1, sy * 0.95));
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
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const t = textEl(0, 0, 'Noch keine Personen angelegt.', { anchor: 'middle', cls: 'tree-empty-text' });
    svg.appendChild(t);
    return;
  }

  const { nodes, links, minY, maxY, pxPerYear, marginL, marginT, totalW, totalH } = state.layout;

  const canvas = document.getElementById('tree-canvas');
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.setAttribute('transform', `translate(${state.pz.x} ${state.pz.y}) scale(${state.pz.k})`);
  svg.appendChild(root);

  // Year axis — decades labelled strongly, individual years lightly
  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (let yr = Math.floor(minY / 10) * 10; yr <= maxY; yr += 10) {
    const x = marginL + (yr - minY) * pxPerYear;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', marginT - 40); line.setAttribute('y2', totalH - 20);
    line.setAttribute('class', 'year-axis-line');
    axis.appendChild(line);
    const t = textEl(x, marginT - 45, String(yr), { anchor: 'middle', cls: 'year-axis-text decade' });
    axis.appendChild(t);
  }
  root.appendChild(axis);

  // Edges (parent lines: Bezier down; spouse lines: short arc)
  const edgeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const { e, a, b } of links) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (e.type === 'parent') {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h;
      const x2 = b.x + b.w / 2, y2 = b.y;
      const dy = y2 - y1;
      path.setAttribute('d', `M${x1},${y1} C${x1},${y1 + dy * 0.6} ${x2},${y2 - dy * 0.6} ${x2},${y2}`);
      path.setAttribute('class', 'edge-parent');
    } else {
      const y = a.y + a.h / 2;
      const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2;
      path.setAttribute('d', `M${x1},${y} Q${(x1 + x2) / 2},${y - 20} ${x2},${y}`);
      path.setAttribute('class', 'edge-spouse');
      // tiny wedding ring at mid
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('cx', (x1 + x2) / 2);
      ring.setAttribute('cy', y - 20);
      ring.setAttribute('r', 2.5);
      ring.setAttribute('class', 'node-wedding-ring');
      edgeG.appendChild(ring);
    }
    edgeG.appendChild(path);
  }
  root.appendChild(edgeG);

  // Nodes
  const nodeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const n of nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node ' + (n.person.gender || ''));
    g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    if (state.selected === n.id) g.classList.add('selected');

    const plate = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    plate.setAttribute('width', n.w); plate.setAttribute('height', n.h);
    plate.setAttribute('rx', 8); plate.setAttribute('ry', 8);
    plate.setAttribute('class', 'node-plate');
    g.appendChild(plate);

    // avatar circle
    const av = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    av.setAttribute('cx', 20); av.setAttribute('cy', n.h / 2);
    av.setAttribute('r', 14);
    av.setAttribute('class', 'node-avatar');
    g.appendChild(av);
    const init = textEl(20, n.h / 2, initialsOf(n.person), { anchor: 'middle', cls: 'node-initials' });
    init.setAttribute('dy', '0');
    g.appendChild(init);

    // name — prefer nickname if present. Node is sized to fit, so no ellipsis.
    const nmText = primaryNameOf(n.person);
    const nameT = textEl(42, n.h / 2 - 6, nmText, { cls: 'node-name' });
    g.appendChild(nameT);

    const dates = fmtLifeShort(n.person);
    if (dates) {
      const dT = textEl(42, n.h / 2 + 12, dates, { cls: 'node-dates' });
      g.appendChild(dT);
    }

    g.onclick = () => select(n.id);
    // Hover preview only on hover-capable devices (not touch).
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
  if (p.birth_date) bits.push(`* ${p.birth_date}${p.birth_place ? ', ' + p.birth_place : ''}`);
  if (p.death_date) bits.push(`✝ ${p.death_date}${p.death_place ? ', ' + p.death_place : ''}`);
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
  const parents = state.edges.filter(e => e.type === 'parent' && e.to_id === id).map(e => state.persons.find(x => x.id === e.from_id)).filter(Boolean);
  const children = state.edges.filter(e => e.type === 'parent' && e.from_id === id).map(e => state.persons.find(x => x.id === e.to_id)).filter(Boolean);
  const spouses = state.edges.filter(e => e.type === 'spouse' && (e.from_id === id || e.to_id === id))
    .map(e => ({ p: state.persons.find(x => x.id === (e.from_id === id ? e.to_id : e.from_id)), since: e.since, until: e.until }))
    .filter(x => x.p);
  // Siblings
  const myParents = parents.map(x => x.id);
  const siblings = myParents.length
    ? [...new Set(state.edges.filter(e => e.type === 'parent' && myParents.includes(e.from_id) && e.to_id !== id).map(e => e.to_id))]
      .map(sid => state.persons.find(x => x.id === sid)).filter(Boolean)
    : [];
  return { parents, children, spouses, siblings };
}

function renderDetail() {
  const emptyEl = document.getElementById('detail-empty');
  const el = document.getElementById('detail');
  if (!state.selected) { emptyEl.hidden = false; el.hidden = true; return; }
  const p = state.persons.find(x => x.id === state.selected);
  if (!p) { emptyEl.hidden = false; el.hidden = true; return; }
  emptyEl.hidden = true; el.hidden = false;

  const { parents, children, spouses, siblings } = relationsOf(p.id);

  el.innerHTML = '';

  const head = h('div', { class: 'detail-head' },
    h('span', { class: 'detail-eyebrow' }, [
      year(p.birth_date) || '?',
      p.birth_place || p.death_place || null,
    ].filter(Boolean).join(' · ')),
    (() => {
      const h2 = h('h2', {}, primaryNameOf(p));
      if (hasAltName(p)) {
        h2.appendChild(h('em', {}, nameOf(p)));
      } else if (p.birth_name && p.birth_name !== p.surname) {
        h2.appendChild(h('em', {}, 'geborene ' + p.birth_name));
      }
      return h2;
    })(),
  );
  el.appendChild(head);

  // Lifespan panel
  if (p.birth_date || p.death_date || p.birth_place || p.death_place) {
    const span = h('div', { class: 'lifespan' },
      h('div', { class: 'born' },
        h('b', {}, p.birth_date || '?'),
        p.birth_place ? h('small', {}, 'geboren in ' + p.birth_place) : null,
      ),
      h('div', { class: 'arc' }, p.death_date ? '→' : 'lebt'),
      h('div', { class: 'died' },
        p.death_date ? h('b', {}, p.death_date) : h('b', {}, '—'),
        p.death_place ? h('small', {}, 'gestorben in ' + p.death_place) : null,
      ),
    );
    el.appendChild(span);
  }

  if (p.notes) {
    el.appendChild(h('div', { class: 'section' },
      h('h3', {}, 'Quellen & Notizen'),
      h('div', { class: 'notes' }, p.notes),
    ));
  }

  const relSection = h('div', { class: 'section' },
    h('h3', {}, 'Verwandtschaft'),
    h('div', { class: 'relations-group' }, [
      ...relationBlock('Eltern', parents.map(x => ({ p: x }))),
      ...relationBlock('Ehepartner', spouses.map(s => ({ p: s.p, role: fmtMarriage(s) }))),
      ...relationBlock('Geschwister', siblings.map(x => ({ p: x }))),
      ...relationBlock('Kinder', children.map(x => ({ p: x }))),
    ].flat()),
  );
  el.appendChild(relSection);

  // Documents section
  const docSection = h('div', { class: 'section' },
    h('h3', {}, 'Dokumente'),
    h('div', { class: 'image-grid', id: 'image-grid-' + p.id }, h('div', { class: 'meta' }, 'Lade…')),
  );
  el.appendChild(docSection);
  loadImagesInto(p.id, docSection.querySelector('.image-grid'));

  // Latest AI run
  const aiSection = h('div', { class: 'section', id: 'ai-section' },
    h('h3', {}, 'KI-Recherche'),
    h('div', { id: 'ai-latest' }, h('div', { class: 'meta' }, 'Lade…')),
  );
  el.appendChild(aiSection);
  loadLatestResearch(p.id);

  // Actions
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
}

function fmtMarriage(s) {
  const parts = [];
  if (s.since) parts.push(`⚭ ${year(s.since) || s.since}`);
  if (s.until) parts.push(`⚮ ${year(s.until) || s.until}`);
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
      tile.onclick = () => openLightbox(personId, idx);
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
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const caption = prompt(`Beschreibung für "${file.name}" (optional):`, file.name) ?? '';
    const role = prompt('Art des Dokuments (z. B. Heiratsurkunde, Geburtsurkunde, Foto):', '') ?? '';
    try {
      const img = await api.uploadImage(file, caption);
      await api.linkImage(personId, img.id, role || null);
      const grid = document.getElementById('image-grid-' + personId);
      if (grid) await loadImagesInto(personId, grid);
    } catch (e) {
      alert('Upload fehlgeschlagen: ' + e.message);
    }
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
  for (const f of form.elements) if (f.name) f.value = p?.[f.name] ?? '';
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
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
  dlg.showModal();
}

function openEdgeDialog() {
  const dlg = document.getElementById('edge-dialog');
  const form = document.getElementById('edge-form');
  const opts = state.persons.map(p => `<option value="${p.id}">${escapeHtml(nameOf(p))}</option>`).join('');
  form.from_id.innerHTML = opts;
  form.to_id.innerHTML = opts;
  if (state.selected) form.from_id.value = state.selected;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try { await api.createEdge(data); dlg.close(); await reload(); }
    catch (e) { alert('Fehler: ' + e.message); }
  };
  dlg.showModal();
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
