// Stammbaum frontend — vanilla JS, no build step.
// State lives on `state`; everything re-renders from `render()`.

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
};
function postJson(data) { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }; }
function patchJson(data) { return { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }; }
async function j(r) { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); }

const state = { persons: [], edges: [], selected: null, filter: '' };

async function reload() {
  const t = await api.tree();
  state.persons = t.persons;
  state.edges = t.edges;
  render();
}

/* -------- render -------- */

function render() {
  renderList();
  renderTree();
  renderDetail();
}

function nameOf(p) {
  const parts = [p.given_name, p.surname].filter(Boolean);
  return parts.join(' ') || '(ohne Namen)';
}
function sub(p) {
  const y = (s) => (s || '').match(/\d{4}/)?.[0] || '';
  const b = y(p.birth_date), d = y(p.death_date);
  if (!b && !d) return p.birth_place || '';
  return `${b || '?'}${d ? ' – ' + d : ''}`;
}

function renderList() {
  const ul = document.getElementById('person-list');
  const f = state.filter.toLowerCase();
  const items = state.persons
    .filter(p => !f || nameOf(p).toLowerCase().includes(f))
    .map(p => {
      const li = document.createElement('li');
      li.dataset.id = p.id;
      if (state.selected === p.id) li.classList.add('active');
      li.innerHTML = `<span>${escapeHtml(nameOf(p))}</span><span class="meta">${escapeHtml(sub(p))}</span>`;
      li.onclick = () => { state.selected = p.id; render(); };
      return li;
    });
  ul.replaceChildren(...items);
}

/* -------- tree layout -------- */

function computeLayout() {
  const persons = state.persons;
  const edges = state.edges;
  if (!persons.length) return { nodes: [], links: [] };

  const parentOf = new Map(); // child -> [parent]
  const childOf = new Map();  // parent -> [child]
  const spouses = new Map();  // id -> Set(ids)
  for (const p of persons) { parentOf.set(p.id, []); childOf.set(p.id, []); spouses.set(p.id, new Set()); }
  for (const e of edges) {
    if (e.type === 'parent') {
      parentOf.get(e.to_id)?.push(e.from_id);
      childOf.get(e.from_id)?.push(e.to_id);
    } else if (e.type === 'spouse') {
      spouses.get(e.from_id)?.add(e.to_id);
      spouses.get(e.to_id)?.add(e.from_id);
    }
  }

  // generation per person: BFS from roots (no parents).
  const gen = new Map();
  const roots = persons.filter(p => parentOf.get(p.id).length === 0).map(p => p.id);
  const queue = roots.map(id => [id, 0]);
  // Spouses inherit higher gen if partner is set.
  while (queue.length) {
    const [id, g] = queue.shift();
    if (gen.has(id) && gen.get(id) >= g) continue;
    gen.set(id, g);
    for (const c of childOf.get(id) || []) queue.push([c, g + 1]);
    for (const s of spouses.get(id) || []) if (!gen.has(s)) queue.push([s, g]);
  }
  for (const p of persons) if (!gen.has(p.id)) gen.set(p.id, 0);

  // group by gen, sort within gen so spouses adjacent.
  const byGen = new Map();
  for (const p of persons) {
    const g = gen.get(p.id);
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(p);
  }

  // simple sort: by surname first, then group spouses next to each other.
  const nodes = [];
  const rowH = 110, colW = 180, nodeW = 150, nodeH = 60;
  const genKeys = [...byGen.keys()].sort((a, b) => a - b);
  for (const g of genKeys) {
    const list = byGen.get(g).slice().sort((a, b) => (a.surname || '').localeCompare(b.surname || '') || (a.given_name || '').localeCompare(b.given_name || ''));
    // Rebuild: put spouses next to each other.
    const placed = new Set(), ordered = [];
    for (const p of list) {
      if (placed.has(p.id)) continue;
      ordered.push(p); placed.add(p.id);
      for (const sId of spouses.get(p.id) || []) {
        if (!placed.has(sId) && gen.get(sId) === g) {
          const s = persons.find(x => x.id === sId);
          if (s) { ordered.push(s); placed.add(sId); }
        }
      }
    }
    ordered.forEach((p, i) => {
      nodes.push({ id: p.id, person: p, x: i * colW + 40, y: g * rowH + 40, w: nodeW, h: nodeH });
    });
  }

  const posById = new Map(nodes.map(n => [n.id, n]));
  const links = [];
  for (const e of edges) {
    const a = posById.get(e.from_id), b = posById.get(e.to_id);
    if (!a || !b) continue;
    links.push({ e, a, b });
  }
  return { nodes, links };
}

function renderTree() {
  const svg = document.getElementById('tree');
  svg.innerHTML = '';
  const { nodes, links } = computeLayout();

  if (!nodes.length) {
    const t = text(40, 60, 'Noch keine Personen. Oben rechts „+ Person“ klicken.', { fill: '#9aa3b2' });
    svg.appendChild(t);
    return;
  }

  const maxX = Math.max(...nodes.map(n => n.x + n.w)) + 40;
  const maxY = Math.max(...nodes.map(n => n.y + n.h)) + 40;
  const vb = `0 0 ${Math.max(maxX, 400)} ${Math.max(maxY, 300)}`;
  svg.setAttribute('viewBox', vb);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // links first
  for (const { e, a, b } of links) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('edge', e.type);
    if (e.type === 'parent') {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h;
      const x2 = b.x + b.w / 2, y2 = b.y;
      const my = (y1 + y2) / 2;
      path.setAttribute('d', `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`);
    } else {
      const y = (a.y + a.h / 2);
      const x1 = Math.min(a.x + a.w, b.x);
      const x2 = Math.max(a.x, b.x + b.w);
      path.setAttribute('d', `M${a.x + a.w / 2},${y} L${b.x + b.w / 2},${y}`);
    }
    svg.appendChild(path);
  }

  for (const n of nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('node');
    if (state.selected === n.id) g.classList.add('selected');
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('width', n.w); r.setAttribute('height', n.h);
    g.appendChild(r);
    g.appendChild(text(n.w / 2, 25, nameOf(n.person), { anchor: 'middle' }));
    g.appendChild(text(n.w / 2, 44, sub(n.person), { anchor: 'middle', cls: 'sub' }));
    g.onclick = () => { state.selected = n.id; render(); };
    svg.appendChild(g);
  }
}

function text(x, y, str, { anchor = 'start', cls = '', fill } = {}) {
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  if (anchor) t.setAttribute('text-anchor', anchor);
  if (cls) t.setAttribute('class', cls);
  if (fill) t.setAttribute('fill', fill);
  t.textContent = str || '';
  return t;
}

/* -------- detail -------- */

function renderDetail() {
  const emptyEl = document.getElementById('detail-empty');
  const el = document.getElementById('detail');
  if (!state.selected) { emptyEl.hidden = false; el.hidden = true; return; }
  const p = state.persons.find(x => x.id === state.selected);
  if (!p) { emptyEl.hidden = false; el.hidden = true; return; }
  emptyEl.hidden = true; el.hidden = false;

  const parents = state.edges.filter(e => e.type === 'parent' && e.to_id === p.id).map(e => state.persons.find(x => x.id === e.from_id)).filter(Boolean);
  const children = state.edges.filter(e => e.type === 'parent' && e.from_id === p.id).map(e => state.persons.find(x => x.id === e.to_id)).filter(Boolean);
  const spouses = state.edges.filter(e => e.type === 'spouse' && (e.from_id === p.id || e.to_id === p.id)).map(e => state.persons.find(x => x.id === (e.from_id === p.id ? e.to_id : e.from_id))).filter(Boolean);

  el.innerHTML = '';
  el.appendChild(h('h2', {}, nameOf(p)));
  const fields = [
    ['Geburtsname', p.birth_name],
    ['Geschlecht', { m: 'männlich', f: 'weiblich', x: 'divers' }[p.gender] || p.gender],
    ['Geboren', [p.birth_date, p.birth_place].filter(Boolean).join(', ')],
    ['Gestorben', [p.death_date, p.death_place].filter(Boolean).join(', ')],
    ['Notizen', p.notes],
  ].filter(([, v]) => v);
  for (const [k, v] of fields) {
    const f = h('div', { class: 'field' }, h('b', {}, k), h('span', {}, v));
    el.appendChild(f);
  }

  const rel = h('div', { class: 'relations' });
  rel.appendChild(renderRelList('Eltern', parents));
  rel.appendChild(renderRelList('Ehepartner', spouses));
  rel.appendChild(renderRelList('Kinder', children));
  el.appendChild(rel);

  const actions = h('div', { class: 'actions' });
  actions.appendChild(button('Bearbeiten', () => openPersonDialog(p)));
  actions.appendChild(button('🤖 KI-Research', () => runResearch(p.id)));
  actions.appendChild(button('Löschen', async () => {
    if (!confirm(`${nameOf(p)} löschen?`)) return;
    await api.remove(p.id); state.selected = null; await reload();
  }));
  el.appendChild(actions);
}

function renderRelList(title, people) {
  const wrap = h('div');
  wrap.appendChild(h('h3', {}, title));
  if (!people.length) { wrap.appendChild(h('div', { class: 'meta' }, '—')); return wrap; }
  const ul = h('ul');
  for (const p of people) {
    const li = h('li', {}, `${nameOf(p)} ${sub(p) ? '· ' + sub(p) : ''}`);
    li.onclick = () => { state.selected = p.id; render(); };
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

async function runResearch(id) {
  const el = document.getElementById('detail');
  const target = h('div', { class: 'ai-result' }, 'Wird angefragt…');
  el.appendChild(target);
  try {
    const r = await api.research(id);
    target.textContent = `${r.person}\n\n${(r.hinweise || []).join('\n')}\n\nPrompt:\n${r.prompt}`;
  } catch (e) {
    target.textContent = 'Fehler: ' + e.message;
  }
}

/* -------- helpers -------- */

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of kids) el.append(c?.nodeType ? c : document.createTextNode(c ?? ''));
  return el;
}
function button(label, onclick) { const b = h('button', {}, label); b.onclick = onclick; return b; }
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* -------- dialogs -------- */

function openPersonDialog(p = null) {
  const dlg = document.getElementById('person-dialog');
  const form = document.getElementById('person-form');
  document.getElementById('person-dialog-title').textContent = p ? 'Person bearbeiten' : 'Neue Person';
  for (const f of form.elements) if (f.name) f.value = p?.[f.name] ?? '';
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      if (p) await api.update(p.id, data); else {
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

document.addEventListener('click', (ev) => {
  if (ev.target.matches('[data-close]')) ev.target.closest('dialog')?.close();
});
document.getElementById('btn-add-person').onclick = () => openPersonDialog();
document.getElementById('btn-add-edge').onclick = () => openEdgeDialog();
document.getElementById('btn-reload').onclick = () => reload();
document.getElementById('search').oninput = (ev) => { state.filter = ev.target.value; renderList(); };

reload().catch(e => alert('Laden fehlgeschlagen: ' + e.message));
