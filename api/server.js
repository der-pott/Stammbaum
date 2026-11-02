import express from 'express';
import cookieParser from 'cookie-parser';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join as pathJoin, dirname as pathDir } from 'node:path';
import {
  db, nowIso, newId,
  verifyPin, getPinHash, seedInitialPins,
  createSession, getSession, deleteSession, purgeExpiredSessions,
  logAudit,
} from './db.js';
import { createAnthropicClient, runResearch } from './research.js';
import { generateBiography } from './biography.js';
import { listSources, runSingleSource, SOURCES } from './research_dispatch.js';
import { startWorker, enqueueJob, getJob } from './scrape_worker.js';
import { computeConsensus } from './consensus.js';
import { createRateLimiter } from './ratelimit.js';
import { gedcomToPayload } from './gedcom.js';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '512kb' }));
app.use(cookieParser());

seedInitialPins();
purgeExpiredSessions();
startWorker();

const anthropic = createAnthropicClient();
const aiLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
const loginLimiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

const COOKIE_NAME = 'sb_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: true,
  path: '/',
  maxAge: 30 * 864e5,
};

const PERSON_FIELDS = [
  'given_name','surname','birth_name','nicknames','gender',
  'birth_date','birth_place','death_date','death_place','notes'
];

function sanitizePerson(body) {
  const out = {};
  for (const f of PERSON_FIELDS) {
    const v = body?.[f];
    if (v == null) continue;
    if (typeof v !== 'string') throw httpErr(400, `${f} must be string`);
    if (v.length > 500) throw httpErr(400, `${f} too long`);
    out[f] = v.trim() || null;
  }
  if (out.gender && !['m','f','x',''].includes(out.gender)) {
    throw httpErr(400, 'gender must be m, f or x');
  }
  return out;
}

function httpErr(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* auth middleware ------------------------------------------------------- */

function readSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  const s = getSession(token);
  return s ? { token, role: s.role } : null;
}

function requireViewer(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'login required' });
  req.auth = s;
  next();
}

function requireEditor(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'login required' });
  if (s.role !== 'editor') return res.status(403).json({ error: 'editor role required' });
  req.auth = s;
  next();
}

/* auth routes ----------------------------------------------------------- */

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { role, pin } = req.body || {};
  if (!['editor','viewer'].includes(role)) return res.status(400).json({ error: 'role must be editor or viewer' });
  if (typeof pin !== 'string' || !pin) return res.status(400).json({ error: 'pin required' });
  const hash = getPinHash(role);
  if (!hash) {
    logAudit(null, 'auth.login.no-pin', role);
    return res.status(503).json({ error: `kein PIN für Rolle "${role}" gesetzt` });
  }
  if (!verifyPin(pin, hash)) {
    logAudit(null, 'auth.login.failed', role);
    return res.status(401).json({ error: 'falscher PIN' });
  }
  const { token } = createSession(role);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  logAudit(role, 'auth.login.ok', null);
  res.json({ role });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    const s = getSession(token);
    deleteSession(token);
    logAudit(s?.role, 'auth.logout', null);
  }
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'login required' });
  res.json({ role: s.role });
});

/* persons --------------------------------------------------------------- */

app.get('/api/persons', requireViewer, (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (
      SELECT pi.image_id FROM person_images pi
      WHERE pi.person_id = p.id AND pi.role = 'Portrait' LIMIT 1
    ) AS portrait_image_id
    FROM persons p
    ORDER BY surname, given_name
  `).all();
  res.json(rows);
});

app.get('/api/persons/:id/portrait', requireViewer, (req, res) => {
  const row = db.prepare(`
    SELECT i.id, i.mime FROM images i
    JOIN person_images pi ON pi.image_id = i.id
    WHERE pi.person_id = ? AND pi.role = 'Portrait' LIMIT 1
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no portrait' });
  const path = pathJoin(IMAGES_DIR, row.id);
  if (!existsSync(path)) return res.status(410).json({ error: 'file gone' });
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(readFileSync(path));
});

// Set an image as THE portrait for a person (demotes previous portrait to 'Foto').
app.post('/api/persons/:id/portrait', requireEditor, (req, res) => {
  const { image_id } = req.body || {};
  if (!image_id) return res.status(400).json({ error: 'image_id required' });
  const link = db.prepare('SELECT role FROM person_images WHERE person_id=? AND image_id=?')
    .get(req.params.id, image_id);
  if (!link) return res.status(404).json({ error: 'image not linked to person' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE person_images SET role='Foto' WHERE person_id=? AND role='Portrait'`).run(req.params.id);
    db.prepare(`UPDATE person_images SET role='Portrait' WHERE person_id=? AND image_id=?`)
      .run(req.params.id, image_id);
  });
  tx();
  logAudit(req.auth.role, 'portrait.set', `${req.params.id} ${image_id}`);
  res.json({ ok: true });
});

app.post('/api/persons', requireEditor, (req, res) => {
  const data = sanitizePerson(req.body || {});
  const id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO persons (id, given_name, surname, birth_name, nicknames, gender,
      birth_date, birth_place, death_date, death_place, notes, created_at, updated_at)
    VALUES (@id,@given_name,@surname,@birth_name,@nicknames,@gender,
      @birth_date,@birth_place,@death_date,@death_place,@notes,@created_at,@updated_at)
  `).run({
    id, given_name:null, surname:null, birth_name:null, nicknames:null, gender:null,
    birth_date:null, birth_place:null, death_date:null, death_place:null, notes:null,
    ...data, created_at: now, updated_at: now,
  });
  logAudit(req.auth.role, 'person.create', id);
  res.status(201).json(db.prepare('SELECT * FROM persons WHERE id=?').get(id));
});

app.get('/api/persons/:id', requireViewer, (req, res) => {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'not found' });
  const edges = db.prepare('SELECT * FROM edges WHERE from_id=? OR to_id=?')
    .all(req.params.id, req.params.id);
  const images = db.prepare(`
    SELECT i.id, i.mime, i.bytes, i.caption, i.taken_at, pi.role
    FROM images i JOIN person_images pi ON pi.image_id = i.id
    WHERE pi.person_id = ? ORDER BY i.created_at
  `).all(req.params.id);
  res.json({ person, edges, images });
});

app.patch('/api/persons/:id', requireEditor, (req, res) => {
  const existing = db.prepare('SELECT id FROM persons WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const data = sanitizePerson(req.body || {});
  if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
  const set = Object.keys(data).map(k => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE persons SET ${set}, updated_at=@updated_at WHERE id=@id`)
    .run({ ...data, id: req.params.id, updated_at: nowIso() });
  logAudit(req.auth.role, 'person.update', req.params.id);
  res.json(db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id));
});

app.delete('/api/persons/:id', requireEditor, (req, res) => {
  const info = db.prepare('DELETE FROM persons WHERE id=?').run(req.params.id);
  logAudit(req.auth.role, 'person.delete', req.params.id);
  res.json({ deleted: info.changes });
});

/* edges ----------------------------------------------------------------- */

app.get('/api/edges', requireViewer, (_req, res) => {
  res.json(db.prepare('SELECT * FROM edges').all());
});

const VALID_SPOUSE_STATUS = new Set(['married', 'divorced', 'widowed', 'engaged', 'partner']);

app.post('/api/edges', requireEditor, (req, res) => {
  const { from_id, to_id, type, since, until, status } = req.body || {};
  if (!from_id || !to_id || from_id === to_id) {
    return res.status(400).json({ error: 'from_id and to_id required, must differ' });
  }
  if (!['parent','spouse'].includes(type)) {
    return res.status(400).json({ error: 'type must be parent or spouse' });
  }
  const a = db.prepare('SELECT id FROM persons WHERE id=?').get(from_id);
  const b = db.prepare('SELECT id FROM persons WHERE id=?').get(to_id);
  if (!a || !b) return res.status(400).json({ error: 'unknown person id' });

  // dedupe: for parent, (from,to) directed; for spouse, treat as unordered.
  let dup;
  if (type === 'parent') {
    dup = db.prepare('SELECT id FROM edges WHERE from_id=? AND to_id=? AND type=?')
      .get(from_id, to_id, 'parent');
  } else {
    dup = db.prepare(`SELECT id FROM edges WHERE type='spouse' AND
      ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))`)
      .get(from_id, to_id, to_id, from_id);
  }
  if (dup) return res.status(409).json({ error: 'edge exists', id: dup.id });

  let edgeStatus = null;
  if (type === 'spouse') {
    const s = status || 'married';
    if (!VALID_SPOUSE_STATUS.has(s)) {
      return res.status(400).json({ error: `status must be one of ${[...VALID_SPOUSE_STATUS].join(', ')}` });
    }
    edgeStatus = s;
  }

  const id = newId();
  db.prepare(`INSERT INTO edges (id, from_id, to_id, type, since, until, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, from_id, to_id, type, since || null, until || null, edgeStatus, nowIso());
  logAudit(req.auth.role, 'edge.create', `${type} ${from_id}->${to_id}`);
  res.status(201).json(db.prepare('SELECT * FROM edges WHERE id=?').get(id));
});

app.patch('/api/edges/:id', requireEditor, (req, res) => {
  const row = db.prepare('SELECT * FROM edges WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'edge not found' });
  const { since, until, status } = req.body || {};
  const fields = [];
  const values = [];
  if (since !== undefined) { fields.push('since=?'); values.push(since || null); }
  if (until !== undefined) { fields.push('until=?'); values.push(until || null); }
  if (status !== undefined) {
    if (row.type !== 'spouse') {
      return res.status(400).json({ error: 'status only valid on spouse edges' });
    }
    if (status !== null && !VALID_SPOUSE_STATUS.has(status)) {
      return res.status(400).json({ error: `status must be one of ${[...VALID_SPOUSE_STATUS].join(', ')}` });
    }
    fields.push('status=?'); values.push(status || null);
  }
  if (!fields.length) return res.json(row);
  values.push(req.params.id);
  db.prepare(`UPDATE edges SET ${fields.join(', ')} WHERE id=?`).run(...values);
  logAudit(req.auth.role, 'edge.update', req.params.id);
  res.json(db.prepare('SELECT * FROM edges WHERE id=?').get(req.params.id));
});

app.delete('/api/edges/:id', requireEditor, (req, res) => {
  const info = db.prepare('DELETE FROM edges WHERE id=?').run(req.params.id);
  logAudit(req.auth.role, 'edge.delete', req.params.id);
  res.json({ deleted: info.changes });
});

/* tree ------------------------------------------------------------------ */

app.get('/api/tree', requireViewer, (_req, res) => {
  const persons = db.prepare(`
    SELECT p.*, (
      SELECT pi.image_id FROM person_images pi
      WHERE pi.person_id = p.id AND pi.role = 'Portrait' LIMIT 1
    ) AS portrait_image_id
    FROM persons p
  `).all();
  const edges = db.prepare('SELECT * FROM edges').all();
  res.json({ persons, edges });
});

/* ai research ----------------------------------------------------------- */

app.post('/api/ai/research', requireEditor, aiLimiter, async (req, res) => {
  const { person_id, prompt } = req.body || {};
  if (!person_id) return res.status(400).json({ error: 'person_id required' });
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(person_id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  if (!anthropic) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY nicht gesetzt — KI-Research deaktiviert. Setze den Key in /srv/projects/stammbaum/.env und rebuild via scripts/deploy.sh --api.',
    });
  }

  const runId = newId();
  const started = nowIso();
  const extraPrompt = String(prompt || '').slice(0, 2000);
  const known = loadKnownRelations(person_id);

  db.prepare(`INSERT INTO ai_runs (id, person_id, prompt, model, response, status, created_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(runId, person_id, extraPrompt, 'claude-opus-4-7', null, 'running', started, null);

  try {
    const result = await runResearch(anthropic, person, extraPrompt, known);
    db.prepare(`UPDATE ai_runs SET model=?, response=?, status='completed', prompt=?, completed_at=? WHERE id=?`)
      .run(result.model, JSON.stringify({ data: result.data, raw: result.raw, usage: result.usage }), result.userPrompt, nowIso(), runId);
    logAudit(req.auth.role, 'ai.research.ok', person_id);
    return res.json({
      id: runId,
      status: 'completed',
      model: result.model,
      person: `${person.given_name || ''} ${person.surname || ''}`.trim() || person.id,
      ...result.data,
      _raw: result.raw,
      _usage: result.usage,
    });
  } catch (err) {
    const detail = err?.code === 'PARSE_FAILED'
      ? { error: 'KI-Antwort war kein gültiges JSON.', raw: err.raw?.slice(0, 2000) }
      : { error: err?.message || 'Anthropic API error', code: err?.status || err?.code };
    db.prepare(`UPDATE ai_runs SET status='failed', response=?, completed_at=? WHERE id=?`)
      .run(JSON.stringify(detail), nowIso(), runId);
    logAudit(req.auth.role, 'ai.research.fail', person_id);
    return res.status(502).json({ id: runId, status: 'failed', ...detail });
  }
});

app.get('/api/ai/runs/:person_id', requireViewer, (req, res) => {
  const rows = db.prepare('SELECT id, prompt, model, status, created_at, completed_at FROM ai_runs WHERE person_id=? ORDER BY created_at DESC LIMIT 20')
    .all(req.params.person_id);
  res.json(rows);
});

// Letzter erfolgreicher Research-Lauf mit geparstem Ergebnis — fürs Frontend,
// damit nicht bei jedem Person-Klick neu angefragt werden muss.
app.get('/api/ai/runs/:person_id/latest', requireViewer, (req, res) => {
  const row = db.prepare(`SELECT id, model, response, created_at, completed_at
    FROM ai_runs WHERE person_id=? AND status='completed' ORDER BY completed_at DESC LIMIT 1`)
    .get(req.params.person_id);
  if (!row) return res.status(404).json({ error: 'no completed run' });
  let data = null, usage = null;
  try {
    const parsed = JSON.parse(row.response || '{}');
    data = parsed.data || null;
    usage = parsed.usage || null;
  } catch (_) {}
  res.json({
    id: row.id, model: row.model, created_at: row.created_at,
    completed_at: row.completed_at, data, usage,
  });
});

function loadKnownRelations(personId) {
  // parent-Edges: Elternteil (from_id) -> Kind (to_id). Also hole:
  //  parents: alle Edges wo to_id = person_id
  //  children: alle Edges wo from_id = person_id, type=parent
  //  spouses: alle Edges wo person_id in from/to und type=spouse
  //  siblings: andere Kinder von meinen Eltern (ohne mich selbst)
  const sel = db.prepare('SELECT * FROM persons WHERE id=?');
  const parentRows = db.prepare(`SELECT from_id FROM edges WHERE to_id=? AND type='parent'`).all(personId);
  const parents = parentRows.map(r => sel.get(r.from_id)).filter(Boolean);
  const childRows = db.prepare(`SELECT to_id FROM edges WHERE from_id=? AND type='parent'`).all(personId);
  const children = childRows.map(r => sel.get(r.to_id)).filter(Boolean);
  const spouseRows = db.prepare(`SELECT from_id, to_id FROM edges WHERE type='spouse' AND (from_id=? OR to_id=?)`).all(personId, personId);
  const spouses = spouseRows.map(r => sel.get(r.from_id === personId ? r.to_id : r.from_id)).filter(Boolean);

  const siblings = [];
  const siblingIds = new Set();
  for (const p of parents) {
    const otherKids = db.prepare(`SELECT to_id FROM edges WHERE from_id=? AND type='parent' AND to_id != ?`).all(p.id, personId);
    for (const r of otherKids) {
      if (siblingIds.has(r.to_id)) continue;
      siblingIds.add(r.to_id);
      const s = sel.get(r.to_id);
      if (s) siblings.push(s);
    }
  }
  return { parents, spouses, children, siblings };
}

/* gedcom import --------------------------------------------------------- */
// Write operation.  When auth lands, wrap this route in the editor-role guard.
// Uses raw body (not multipart) so no extra dep is needed; the frontend posts
// the file as the request body directly.  2 MB cap matches a typical GEDCOM.

const gedcomBody = express.raw({ type: () => true, limit: '2mb' });

app.post('/api/import/gedcom', requireEditor, gedcomBody, (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  if (!raw.trim()) return res.status(400).json({ error: 'empty body' });
  if (!/^\s*0\s+/.test(raw)) return res.status(400).json({ error: 'not a GEDCOM file' });

  let payload;
  try { payload = gedcomToPayload(raw); }
  catch (e) { return res.status(400).json({ error: 'parse failed: ' + (e?.message || 'unknown') }); }

  if (!payload.persons.length) return res.status(400).json({ error: 'no INDI records found' });

  const now = nowIso();
  const insertPerson = db.prepare(`
    INSERT INTO persons (id, given_name, surname, birth_name, gender,
      birth_date, birth_place, death_date, death_place, notes, created_at, updated_at)
    VALUES (@id,@given_name,@surname,@birth_name,@gender,
      @birth_date,@birth_place,@death_date,@death_place,@notes,@created_at,@updated_at)
  `);
  const insertEdge = db.prepare(`INSERT INTO edges (id, from_id, to_id, type, since, until, created_at)
    VALUES (?, ?, ?, 'parent', NULL, NULL, ?)`);
  const insertSpouse = db.prepare(`INSERT INTO edges (id, from_id, to_id, type, since, until, created_at)
    VALUES (?, ?, ?, 'spouse', NULL, NULL, ?)`);

  const run = db.transaction(() => {
    for (const p of payload.persons) {
      insertPerson.run({ ...p, created_at: now, updated_at: now });
    }
    for (const e of payload.edges) {
      if (e.type === 'parent') insertEdge.run(e.id, e.from_id, e.to_id, now);
      else                     insertSpouse.run(e.id, e.from_id, e.to_id, now);
    }
  });
  run();

  logAudit(req.auth.role, 'gedcom.import', `${payload.persons.length} persons, ${payload.edges.length} edges`);
  res.status(201).json({
    imported_persons: payload.persons.length,
    imported_edges: payload.edges.length,
  });
});

/* images ---------------------------------------------------------------- */
// Bytes auf Disk unter /data/images/<id>, Metadaten + Verknüpfungen in SQLite.
// Ein Bild kann an mehreren Personen hängen (Heirats-/Taufurkunden). Upload
// per raw body + Content-Type, keine Multipart-Lib.

const IMAGES_DIR = process.env.IMAGES_DIR
  || pathJoin(pathDir(process.env.DB_PATH || '/data/stammbaum.db'), 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

const IMAGE_MIME_WHITELIST = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf',
]);
const imageBody = express.raw({ type: () => true, limit: '15mb' });

app.post('/api/images', requireEditor, imageBody, (req, res) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_MIME_WHITELIST.has(mime)) {
    return res.status(400).json({ error: 'mime not allowed', mime });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'empty body' });
  }
  const caption = typeof req.query.caption === 'string' ? req.query.caption.slice(0, 500) : null;
  const taken_at = typeof req.query.taken_at === 'string' ? req.query.taken_at.slice(0, 40) : null;
  const id = newId();
  writeFileSync(pathJoin(IMAGES_DIR, id), req.body);
  db.prepare(`INSERT INTO images (id, mime, bytes, caption, taken_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, mime, req.body.length, caption, taken_at, nowIso());
  logAudit(req.auth.role, 'image.upload', `${id} ${mime} ${req.body.length}B`);
  res.status(201).json({ id, mime, bytes: req.body.length, caption, taken_at });
});

app.get('/api/images/:id', requireViewer, (req, res) => {
  const row = db.prepare('SELECT mime FROM images WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const path = pathJoin(IMAGES_DIR, req.params.id);
  if (!existsSync(path)) return res.status(410).json({ error: 'file gone' });
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(readFileSync(path));
});

app.get('/api/images/:id/meta', requireViewer, (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const persons = db.prepare(`SELECT pi.person_id, pi.role, p.given_name, p.surname
    FROM person_images pi JOIN persons p ON p.id = pi.person_id WHERE pi.image_id = ?`)
    .all(req.params.id);
  res.json({ ...row, persons });
});

app.delete('/api/images/:id', requireEditor, (req, res) => {
  const row = db.prepare('SELECT id FROM images WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const path = pathJoin(IMAGES_DIR, req.params.id);
  try { if (existsSync(path)) unlinkSync(path); } catch (_) {}
  db.prepare('DELETE FROM images WHERE id=?').run(req.params.id);
  logAudit(req.auth.role, 'image.delete', req.params.id);
  res.json({ deleted: 1 });
});

app.post('/api/person-images', requireEditor, (req, res) => {
  const { person_id, image_id, role } = req.body || {};
  if (!person_id || !image_id) return res.status(400).json({ error: 'person_id + image_id required' });
  const p = db.prepare('SELECT id FROM persons WHERE id=?').get(person_id);
  const i = db.prepare('SELECT id FROM images WHERE id=?').get(image_id);
  if (!p || !i) return res.status(400).json({ error: 'unknown person_id or image_id' });
  try {
    db.prepare(`INSERT INTO person_images (person_id, image_id, role, created_at)
      VALUES (?, ?, ?, ?)`).run(person_id, image_id, role?.slice(0, 100) || null, nowIso());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'already linked' });
    throw e;
  }
  logAudit(req.auth.role, 'image.link', `${person_id}<->${image_id}`);
  res.status(201).json({ person_id, image_id, role: role || null });
});

app.delete('/api/person-images', requireEditor, (req, res) => {
  const { person_id, image_id } = req.body || {};
  if (!person_id || !image_id) return res.status(400).json({ error: 'person_id + image_id required' });
  const info = db.prepare('DELETE FROM person_images WHERE person_id=? AND image_id=?')
    .run(person_id, image_id);
  res.json({ deleted: info.changes });
});

/* sub-resources (jobs, residences, military, anecdotes, health_events) ---- */
// Generic CRUD mounted at /api/persons/:id/<kind>.
// Health events are editor-only for viewer too (privacy).

const SUB_RESOURCES = {
  jobs:              { table: 'jobs',             cols: ['title','employer','start_date','end_date','place','notes'], order: 'COALESCE(start_date, created_at)' },
  residences:        { table: 'residences',       cols: ['place','start_date','end_date','kind','notes'], order: 'COALESCE(start_date, created_at)' },
  military:          { table: 'military_service', cols: ['branch','rank','unit','start_date','end_date','campaigns','notes'], order: 'COALESCE(start_date, created_at)' },
  anecdotes:         { table: 'anecdotes',        cols: ['title','text','source','year'], order: 'COALESCE(year, created_at)' },
  'health-events':   { table: 'health_events',    cols: ['condition','date','hereditary','notes'], editorOnlyRead: true, order: 'COALESCE(date, created_at)' },
};

function sanitizeSub(cfg, body) {
  const out = {};
  for (const c of cfg.cols) {
    const v = body?.[c];
    if (v == null) continue;
    if (c === 'hereditary') { out[c] = v ? 1 : 0; continue; }
    if (typeof v !== 'string') throw httpErr(400, `${c} must be string`);
    if (v.length > 2000) throw httpErr(400, `${c} too long`);
    out[c] = v.trim() || null;
  }
  return out;
}

for (const [kind, cfg] of Object.entries(SUB_RESOURCES)) {
  const readGuard = cfg.editorOnlyRead ? requireEditor : requireViewer;
  app.get(`/api/persons/:id/${kind}`, readGuard, (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${cfg.table} WHERE person_id=? ORDER BY ${cfg.order || 'created_at'}`).all(req.params.id);
    res.json(rows);
  });
  app.post(`/api/persons/:id/${kind}`, requireEditor, (req, res) => {
    const person = db.prepare('SELECT id FROM persons WHERE id=?').get(req.params.id);
    if (!person) return res.status(404).json({ error: 'person not found' });
    const data = sanitizeSub(cfg, req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
    const id = newId();
    const now = nowIso();
    const colList = ['id', 'person_id', ...cfg.cols, 'created_at'];
    const placeholders = colList.map(c => `@${c}`).join(', ');
    db.prepare(`INSERT INTO ${cfg.table} (${colList.join(', ')}) VALUES (${placeholders})`)
      .run({ id, person_id: req.params.id, created_at: now, ...Object.fromEntries(cfg.cols.map(c => [c, null])), ...data });
    logAudit(req.auth.role, `${kind}.create`, id);
    res.status(201).json(db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(id));
  });
  app.patch(`/api/persons/:id/${kind}/:sid`, requireEditor, (req, res) => {
    const row = db.prepare(`SELECT id FROM ${cfg.table} WHERE id=? AND person_id=?`).get(req.params.sid, req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const data = sanitizeSub(cfg, req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
    const set = Object.keys(data).map(k => `${k}=@${k}`).join(', ');
    db.prepare(`UPDATE ${cfg.table} SET ${set} WHERE id=@id`).run({ ...data, id: req.params.sid });
    logAudit(req.auth.role, `${kind}.update`, req.params.sid);
    res.json(db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(req.params.sid));
  });
  app.delete(`/api/persons/:id/${kind}/:sid`, requireEditor, (req, res) => {
    const info = db.prepare(`DELETE FROM ${cfg.table} WHERE id=? AND person_id=?`).run(req.params.sid, req.params.id);
    logAudit(req.auth.role, `${kind}.delete`, req.params.sid);
    res.json({ deleted: info.changes });
  });
}

/* biography ------------------------------------------------------------- */

function gatherBioContext(personId) {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(personId);
  if (!person) return null;
  const sel = db.prepare('SELECT * FROM persons WHERE id=?');
  const parentRows = db.prepare(`SELECT from_id FROM edges WHERE to_id=? AND type='parent'`).all(personId);
  const parents = parentRows.map(r => sel.get(r.from_id)).filter(Boolean);
  const childRows = db.prepare(`SELECT to_id FROM edges WHERE from_id=? AND type='parent'`).all(personId);
  const children = childRows.map(r => sel.get(r.to_id)).filter(Boolean);
  const spouseRows = db.prepare(`SELECT from_id, to_id FROM edges WHERE type='spouse' AND (from_id=? OR to_id=?)`).all(personId, personId);
  const spouses = spouseRows.map(r => sel.get(r.from_id === personId ? r.to_id : r.from_id)).filter(Boolean);
  const siblings = [];
  const seen = new Set();
  for (const p of parents) {
    for (const r of db.prepare(`SELECT to_id FROM edges WHERE from_id=? AND type='parent' AND to_id != ?`).all(p.id, personId)) {
      if (seen.has(r.to_id)) continue;
      seen.add(r.to_id);
      const s = sel.get(r.to_id);
      if (s) siblings.push(s);
    }
  }
  const jobs       = db.prepare('SELECT * FROM jobs WHERE person_id=? ORDER BY start_date').all(personId);
  const residences = db.prepare('SELECT * FROM residences WHERE person_id=? ORDER BY start_date').all(personId);
  const anecdotes  = db.prepare('SELECT * FROM anecdotes WHERE person_id=? ORDER BY year').all(personId);
  const military   = db.prepare('SELECT * FROM military_service WHERE person_id=? ORDER BY start_date').all(personId);
  const health     = db.prepare('SELECT * FROM health_events WHERE person_id=? ORDER BY date').all(personId);
  const docCaptions = db.prepare(`
    SELECT i.caption, pi.role FROM images i JOIN person_images pi ON pi.image_id=i.id
    WHERE pi.person_id=? AND i.caption IS NOT NULL
  `).all(personId).map(r => [r.role, r.caption].filter(Boolean).join(': '));
  return { person, parents, spouses, children, siblings, jobs, residences, anecdotes, military, health, docCaptions };
}

app.get('/api/persons/:id/biography', requireViewer, (req, res) => {
  const row = db.prepare('SELECT * FROM biographies WHERE person_id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no biography' });
  res.json(row);
});

app.post('/api/persons/:id/biography', requireEditor, aiLimiter, async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY nicht gesetzt' });
  const ctx = gatherBioContext(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'person not found' });
  try {
    const result = await generateBiography(anthropic, ctx);
    const now = nowIso();
    db.prepare(`INSERT INTO biographies (person_id, narrative, model, generated_at)
      VALUES (?,?,?,?)
      ON CONFLICT(person_id) DO UPDATE SET narrative=excluded.narrative, model=excluded.model, generated_at=excluded.generated_at`)
      .run(req.params.id, result.narrative, result.model, now);
    logAudit(req.auth.role, 'bio.generate', req.params.id);
    res.json({ person_id: req.params.id, narrative: result.narrative, model: result.model, generated_at: now, usage: result.usage });
  } catch (err) {
    logAudit(req.auth.role, 'bio.fail', req.params.id);
    res.status(502).json({ error: err?.message || 'biography generation failed' });
  }
});

/* research hits + sources ---------------------------------------------- */

app.get('/api/research/sources', requireViewer, (_req, res) => res.json(listSources()));

app.post('/api/persons/:id/research/scrape', requireEditor, aiLimiter, (req, res) => {
  const person = db.prepare('SELECT id FROM persons WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  const sourceKeys = Array.isArray(req.body?.sources) && req.body.sources.length
    ? req.body.sources.filter(k => SOURCES[k])
    : Object.keys(SOURCES);
  const jobId = enqueueJob(req.params.id, sourceKeys);
  logAudit(req.auth.role, 'research.enqueue', `${req.params.id} ${sourceKeys.length} sources`);
  res.json({ job_id: jobId, person_id: req.params.id, sources: sourceKeys });
});

app.get('/api/research/jobs/:id', requireViewer, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

app.post('/api/persons/:id/research/scrape-source/:key', requireEditor, aiLimiter, async (req, res) => {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  const key = req.params.key;
  if (!SOURCES[key]) return res.status(400).json({ error: 'unknown source' });
  const useCache = req.body?.use_cache !== false;
  try {
    const result = await runSingleSource(key, person, { useCache });
    const now = nowIso();
    const insertHit = db.prepare(`
      INSERT INTO research_hits (id, person_id, source, url, title, snippet, confidence, payload, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id, source, url) DO UPDATE SET
        title=excluded.title, snippet=excluded.snippet, confidence=excluded.confidence,
        payload=excluded.payload,
        status=CASE WHEN research_hits.payload != excluded.payload THEN 'pending' ELSE research_hits.status END
    `);
    const tx = db.transaction(() => {
      for (const h of result.hits) {
        insertHit.run(newId(), person.id, h.source, h.url || null, h.title || null, h.snippet || null, h.confidence || 0, JSON.stringify(h.payload || {}), 'pending', now);
      }
    });
    tx();
    logAudit(req.auth.role, 'research.scrape-source', `${req.params.id} ${key}:${result.hits.length}`);
    res.json({ person_id: req.params.id, source: key, status: result.status, count: result.hits.length });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'scrape failed' });
  }
});

app.get('/api/persons/:id/research/consensus', requireViewer, (req, res) => {
  res.json({ person_id: req.params.id, consensus: computeConsensus(req.params.id) });
});

app.get('/api/persons/:id/research/hits', requireViewer, (req, res) => {
  const rows = db.prepare(`SELECT * FROM research_hits WHERE person_id=? ORDER BY created_at DESC`)
    .all(req.params.id);
  res.json(rows.map(r => ({ ...r, payload: safeJson(r.payload) })));
});

app.post('/api/research/hits/:id/apply', requireEditor, (req, res) => {
  const hit = db.prepare('SELECT * FROM research_hits WHERE id=?').get(req.params.id);
  if (!hit) return res.status(404).json({ error: 'hit not found' });
  const action = String(req.body?.action || '').trim();
  if (!['accept','dismiss','add_source_note'].includes(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }
  let newStatus = action;
  if (action === 'add_source_note' && hit.person_id) {
    // append a short line to the person's notes
    const p = db.prepare('SELECT notes FROM persons WHERE id=?').get(hit.person_id);
    if (p) {
      const line = `\n[Quelle · ${hit.source}] ${hit.title || ''} ${hit.url || ''}`.trim();
      const newNotes = (p.notes ? p.notes + '\n' : '') + line;
      db.prepare('UPDATE persons SET notes=?, updated_at=? WHERE id=?')
        .run(newNotes.slice(0, 2000), nowIso(), hit.person_id);
    }
    newStatus = 'applied';
  }
  if (action === 'accept') newStatus = 'accepted';
  db.prepare('UPDATE research_hits SET status=? WHERE id=?').run(newStatus, req.params.id);
  logAudit(req.auth.role, `research.${action}`, req.params.id);
  res.json({ id: req.params.id, status: newStatus });
});

function safeJson(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }

/* health ---------------------------------------------------------------- */

// Public health check so Caddy / monitoring can probe without auth.
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: nowIso() }));

/* error handling -------------------------------------------------------- */

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'internal error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`stammbaum-api listening on :${PORT}`));
