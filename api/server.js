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
import { runReview, hashContext, suggestionHash, suggestionSummary } from './ai_review.js';
import { listSources, runSingleSource, SOURCES } from './research_dispatch.js';
import { startWorker, enqueueJob, getJob } from './scrape_worker.js';
import { computeConsensus } from './consensus.js';
import { createRateLimiter } from './ratelimit.js';
import { gedcomToPayload } from './gedcom.js';
import { fetchPage } from './scrape_fetcher.js';
import { runPlausibilityChecks } from './plausibility.js';
import { colognePhonetic } from './phonetic.js';
import sharp from 'sharp';

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
  'given_name','surname','birth_name','nicknames','title','gender',
  'birth_date','birth_place','death_date','death_place','notes',
  'birth_date_precision','death_date_precision',
];

const DATE_PRECISION_VALUES = new Set(['EXACT','MONTH','YEAR','APPROXIMATE','RANGE','UNKNOWN']);

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
  for (const pf of ['birth_date_precision','death_date_precision']) {
    if (out[pf] && !DATE_PRECISION_VALUES.has(out[pf])) {
      throw httpErr(400, `${pf} must be one of ${[...DATE_PRECISION_VALUES].join(', ')}`);
    }
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
      WHERE pi.person_id = p.id AND pi.role = 'Portrait'
        AND pi.deleted_at IS NULL LIMIT 1
    ) AS portrait_image_id
    FROM persons p
    WHERE p.deleted_at IS NULL
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

// Manual portrait crop: user picks square region in UI, we extract + resize + save as new image.
// Body: {image_id, x, y, size} — all relative 0..1 of original image dimensions
// (x,y top-left; size = side length relative to min(W,H), or absolute if --- we use absolute: w*size, h*size won't be square unless we normalize).
// To keep square: size interpreted against min(W,H).
app.post('/api/persons/:id/portrait/crop', requireEditor, async (req, res) => {
  try {
    const { image_id, x, y, size, rotate } = req.body || {};
    if (!image_id || typeof x !== 'number' || typeof y !== 'number' || typeof size !== 'number') {
      return res.status(400).json({ error: 'image_id, x, y, size required (floats 0..1)' });
    }
    if (size <= 0.02 || size > 1) return res.status(400).json({ error: 'size must be 0.02..1' });
    if (x < 0 || x > 1 || y < 0 || y > 1) return res.status(400).json({ error: 'x,y must be 0..1' });
    const rot = Number.isInteger(rotate) && [0, 90, 180, 270].includes(rotate) ? rotate : 0;
    const srcPath = pathJoin(IMAGES_DIR, image_id);
    if (!existsSync(srcPath)) return res.status(404).json({ error: 'source image not found' });

    // Rotation first (0/90/180/270), then read dims of rotated image.
    // sharp.rotate(angle) with explicit angle skips EXIF-based auto-rotation,
    // but we chain .rotate() first to normalise EXIF, then .rotate(angle) to apply user rotation.
    const pre = sharp(srcPath).rotate(); // normalise EXIF orientation
    const preBuf = await pre.toBuffer();
    const rotated = sharp(preBuf).rotate(rot);
    const meta = await rotated.metadata();
    const W = meta.width, H = meta.height;
    if (!W || !H) return res.status(500).json({ error: 'cannot read image dimensions' });

    const sidePx = Math.round(size * Math.min(W, H));
    const leftPx = Math.max(0, Math.min(W - sidePx, Math.round(x * W)));
    const topPx  = Math.max(0, Math.min(H - sidePx, Math.round(y * H)));

    const outBuf = await sharp(preBuf)
      .rotate(rot)
      .extract({ left: leftPx, top: topPx, width: sidePx, height: sidePx })
      .resize(1200, 1200, { fit: 'cover' })
      .jpeg({ quality: 88, progressive: true, mozjpeg: false })
      .toBuffer();

    const newId_ = newId();
    writeFileSync(pathJoin(IMAGES_DIR, newId_), outBuf);
    const now = nowIso();
    db.prepare(`INSERT INTO images (id, mime, bytes, caption, taken_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId_, 'image/jpeg', outBuf.length, 'Portrait (manuell zugeschnitten)', null, now);

    // Link + demote prev portrait, in a transaction
    const tx = db.transaction(() => {
      db.prepare(`UPDATE person_images SET role='Foto' WHERE person_id=? AND role='Portrait'`).run(req.params.id);
      db.prepare(`INSERT INTO person_images (person_id, image_id, role, created_at)
        VALUES (?, ?, 'Portrait', ?)`).run(req.params.id, newId_, now);
    });
    tx();

    logAudit(req.auth.role, 'portrait.crop', `${req.params.id} src=${image_id} new=${newId_} ${sidePx}px`);
    res.status(201).json({
      new_image_id: newId_,
      bytes: outBuf.length,
      crop_px: { left: leftPx, top: topPx, size: sidePx },
      source: { width: W, height: H },
    });
  } catch (err) {
    console.error('portrait crop error:', err);
    res.status(500).json({ error: 'crop failed', detail: String(err.message || err) });
  }
});

app.post('/api/persons', requireEditor, (req, res) => {
  const data = sanitizePerson(req.body || {});
  // Phonetic dedup hint: if a very similar name already exists (same Cologne-code
  // for first given + surname/birth_name), surface the candidates. Client can
  // show them to the user; we still allow the insert.
  let dedupHints = [];
  try {
    const first = (data.given_name || '').split(/\s+/)[0];
    const last  = data.surname || data.birth_name || '';
    const key   = colognePhonetic(first + '|' + last);
    if (key) {
      const candidates = db.prepare(`
        SELECT id, given_name, surname, birth_name, birth_date
        FROM persons WHERE deleted_at IS NULL
      `).all();
      dedupHints = candidates
        .map(p => ({ p, k: colognePhonetic(((p.given_name||'').split(/\s+/)[0]) + '|' + (p.surname || p.birth_name || '')) }))
        .filter(x => x.k === key)
        .slice(0, 5)
        .map(x => x.p);
    }
  } catch { /* non-fatal */ }
  const id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO persons (id, given_name, surname, birth_name, nicknames, title, gender,
      birth_date, birth_date_precision, birth_place, death_date, death_date_precision, death_place,
      notes, created_at, updated_at)
    VALUES (@id,@given_name,@surname,@birth_name,@nicknames,@title,@gender,
      @birth_date,@birth_date_precision,@birth_place,@death_date,@death_date_precision,@death_place,
      @notes,@created_at,@updated_at)
  `).run({
    id, given_name:null, surname:null, birth_name:null, nicknames:null, title:null, gender:null,
    birth_date:null, birth_date_precision:'EXACT',
    birth_place:null, death_date:null, death_date_precision:'EXACT', death_place:null, notes:null,
    ...data, created_at: now, updated_at: now,
  });
  logAudit(req.auth.role, 'person.create', id);
  const created = db.prepare('SELECT * FROM persons WHERE id=?').get(id);
  if (dedupHints.length) created._dedup_hints = dedupHints;
  res.status(201).json(created);
});

app.get('/api/persons/:id', requireViewer, (req, res) => {
  const person = db.prepare('SELECT * FROM persons WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'not found' });
  const edges = db.prepare('SELECT * FROM edges WHERE (from_id=? OR to_id=?) AND deleted_at IS NULL')
    .all(req.params.id, req.params.id);
  const images = db.prepare(`
    SELECT i.id, i.mime, i.bytes, i.caption, i.taken_at, pi.role
    FROM images i JOIN person_images pi ON pi.image_id = i.id
    WHERE pi.person_id = ? AND pi.deleted_at IS NULL AND i.deleted_at IS NULL
    ORDER BY COALESCE(i.taken_at, i.created_at) ASC
  `).all(req.params.id);
  res.json({ person, edges, images });
});

app.patch('/api/persons/:id', requireEditor, (req, res) => {
  const existing = db.prepare('SELECT given_name, surname, birth_name FROM persons WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const data = sanitizePerson(req.body || {});
  if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
  const set = Object.keys(data).map(k => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE persons SET ${set}, updated_at=@updated_at WHERE id=@id`)
    .run({ ...data, id: req.params.id, updated_at: nowIso() });
  logAudit(req.auth.role, 'person.update', req.params.id);
  // Name-Change-Trigger: Wenn given_name/surname/birth_name geändert wurden,
  // alle pending research_hits re-scoren und die ohne Namens-Match
  // automatisch dismissen. Der User hat den Namen explizit korrigiert, also
  // sind Treffer die den alten Namen enthielten und mit dem neuen Namen
  // nicht übereinstimmen irrelevant.
  const nameChanged = ['given_name', 'surname', 'birth_name'].some(
    k => k in data && (data[k] || '') !== (existing[k] || ''));
  let autoDismissed = 0;
  if (nameChanged) {
    autoDismissed = autoDismissPendingHitsOnNameMismatch(req.params.id);
    if (autoDismissed) logAudit(req.auth.role, 'research.auto_dismiss_on_rename', req.params.id);
  }
  const row = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  res.json({ ...row, _meta: { auto_dismissed_hits: autoDismissed } });
});

// Pending-Hits beim Namens-Wechsel re-scoren. Match-Kriterium: Nachname
// (oder Geburtsname) muss im Title ODER Snippet vorkommen (case-insensitive,
// Umlaut-tolerant). Alte Falschschreibweisen gehen damit raus, aber Treffer
// die den neuen Namen auch zufällig enthalten bleiben pending.
function autoDismissPendingHitsOnNameMismatch(personId) {
  const p = db.prepare('SELECT given_name, surname, birth_name FROM persons WHERE id=?').get(personId);
  if (!p) return 0;
  // Nachname + Geburtsname sind die Identitäts-Anker. Vorname zählt NICHT —
  // Vornamen (Michael, Peter, Hans) kommen in zu vielen irrelevanten Quellen
  // vor. Ein Treffer gilt nur als Namens-Match wenn surname ODER birth_name
  // als Teilstring im Text steht.
  const surnames = [p.surname, p.birth_name].filter(x => x && x.length >= 3);
  if (!surnames.length) return 0;
  const norm = s => (s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  const surnameTokens = surnames.map(norm);
  const pending = db.prepare(`SELECT id, title, snippet FROM research_hits
    WHERE person_id=? AND status='pending' AND source != 'manual_url'`).all(personId);
  const upd = db.prepare(`UPDATE research_hits SET status='dismissed' WHERE id=?`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const h of pending) {
      const blob = norm((h.title || '') + ' ' + (h.snippet || ''));
      const matches = surnameTokens.some(t => blob.includes(t));
      if (!matches) { upd.run(h.id); n += 1; }
    }
  });
  tx();
  return n;
}

// Explicit cleanup endpoint for existing hits: User kann manuell triggern
// wenn der Name-Change schon länger her ist und alte Hits noch rumliegen.
app.post('/api/persons/:id/research/cleanup-stale', requireEditor, (req, res) => {
  const person = db.prepare('SELECT id FROM persons WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  const n = autoDismissPendingHitsOnNameMismatch(req.params.id);
  logAudit(req.auth.role, 'research.cleanup_stale', req.params.id);
  res.json({ auto_dismissed: n });
});

app.delete('/api/persons/:id', requireEditor, (req, res) => {
  // Soft-Delete: setzt deleted_at, Daten bleiben recoverable im Recycle Bin.
  // ?hard=1 → endgültig löschen (Recycle Bin → Endgültig löschen).
  const hard = req.query.hard === '1';
  if (hard) {
    const info = db.prepare('DELETE FROM persons WHERE id=?').run(req.params.id);
    logAudit(req.auth.role, 'person.delete.hard', req.params.id);
    return res.json({ deleted: info.changes, hard: true });
  }
  const info = db.prepare('UPDATE persons SET deleted_at=?, deleted_by=? WHERE id=? AND deleted_at IS NULL')
    .run(nowIso(), req.auth.role, req.params.id);
  logAudit(req.auth.role, 'person.delete.soft', req.params.id);
  res.json({ deleted: info.changes, soft: true });
});

/* edges ----------------------------------------------------------------- */

app.get('/api/edges', requireViewer, (_req, res) => {
  res.json(db.prepare('SELECT * FROM edges WHERE deleted_at IS NULL').all());
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
  const hard = req.query.hard === '1';
  if (hard) {
    const info = db.prepare('DELETE FROM edges WHERE id=?').run(req.params.id);
    logAudit(req.auth.role, 'edge.delete.hard', req.params.id);
    return res.json({ deleted: info.changes, hard: true });
  }
  const info = db.prepare('UPDATE edges SET deleted_at=?, deleted_by=? WHERE id=? AND deleted_at IS NULL')
    .run(nowIso(), req.auth.role, req.params.id);
  logAudit(req.auth.role, 'edge.delete.soft', req.params.id);
  res.json({ deleted: info.changes, soft: true });
});

/* tree ------------------------------------------------------------------ */

app.get('/api/tree', requireViewer, (_req, res) => {
  const persons = db.prepare(`
    SELECT p.*, (
      SELECT pi.image_id FROM person_images pi
      WHERE pi.person_id = p.id AND pi.role = 'Portrait'
        AND pi.deleted_at IS NULL LIMIT 1
    ) AS portrait_image_id
    FROM persons p
    WHERE p.deleted_at IS NULL
  `).all();
  const edges = db.prepare('SELECT * FROM edges WHERE deleted_at IS NULL').all();
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
  const rows = db.prepare('SELECT id, prompt, model, status, created_at, completed_at FROM ai_runs WHERE person_id=? ORDER BY created_at ASC LIMIT 20')
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
  jobs:              { table: 'jobs',             cols: ['title','employer','start_date','start_date_precision','end_date','end_date_precision','place','notes'], order: 'COALESCE(start_date, created_at)' },
  residences:        { table: 'residences',       cols: ['place','street','city','district','postal_code','postal_code_historical','region','country','start_date','start_date_precision','end_date','end_date_precision','kind','notes'], order: 'COALESCE(start_date, created_at)' },
  military:          { table: 'military_service', cols: ['branch','rank','unit','start_date','start_date_precision','end_date','end_date_precision','campaigns','notes'], order: 'COALESCE(start_date, created_at)' },
  anecdotes:         { table: 'anecdotes',        cols: ['title','text','source','year'], order: 'COALESCE(year, created_at)' },
  'health-events':   { table: 'health_events',    cols: ['condition','date','date_precision','hereditary','notes'], editorOnlyRead: true, order: 'COALESCE(date, created_at)' },
  education:         { table: 'education',        cols: ['institution','field','degree','place','start_date','start_date_precision','end_date','end_date_precision','notes'], order: 'COALESCE(start_date, created_at)' },
  'life-events':     { table: 'life_events',      cols: ['category','title','date','date_precision','place','description','notes'], order: 'COALESCE(date, created_at)' },
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
  // Validate *_precision columns
  for (const c of Object.keys(out)) {
    if (c.endsWith('_precision') && out[c] && !DATE_PRECISION_VALUES.has(out[c])) {
      throw httpErr(400, `${c} must be one of ${[...DATE_PRECISION_VALUES].join(', ')}`);
    }
  }
  return out;
}

for (const [kind, cfg] of Object.entries(SUB_RESOURCES)) {
  const readGuard = cfg.editorOnlyRead ? requireEditor : requireViewer;
  app.get(`/api/persons/:id/${kind}`, readGuard, (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${cfg.table} WHERE person_id=? AND deleted_at IS NULL ORDER BY ${cfg.order || 'created_at'}`).all(req.params.id);
    res.json(rows);
  });
  app.post(`/api/persons/:id/${kind}`, requireEditor, (req, res) => {
    const person = db.prepare('SELECT id FROM persons WHERE id=?').get(req.params.id);
    if (!person) return res.status(404).json({ error: 'person not found' });
    const data = sanitizeSub(cfg, req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
    // residences.place ist NOT NULL — auto-synthesize aus strukturierten Feldern falls fehlt
    if (kind === 'residences' && !data.place) {
      const parts = [data.street, data.postal_code, data.city, data.district && `(${data.district})`].filter(Boolean);
      data.place = parts.length ? parts.join(' ') : (data.city || data.street || 'unbekannt');
    }
    // life-events: category + title NOT NULL
    if (kind === 'life-events') {
      if (!data.category) return res.status(400).json({ error: 'category required' });
      if (!data.title) return res.status(400).json({ error: 'title required' });
    }
    const id = newId();
    const now = nowIso();
    const colList = ['id', 'person_id', ...cfg.cols, 'created_at'];
    const placeholders = colList.map(c => `@${c}`).join(', ');
    const row = { id, person_id: req.params.id, created_at: now, ...Object.fromEntries(cfg.cols.map(c => [c, null])), ...data };
    db.prepare(`INSERT INTO ${cfg.table} (${colList.join(', ')}) VALUES (${placeholders})`).run(row);
    logAudit(req.auth.role, `${kind}.create`, id);
    const after = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(id);
    logAction(req.cookies?.[COOKIE_NAME], { type: `${cfg.table}.create`, target_id: id, before: null, after }, `${kind} angelegt`);
    res.status(201).json(after);
  });
  app.patch(`/api/persons/:id/${kind}/:sid`, requireEditor, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=? AND person_id=?`).get(req.params.sid, req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const data = sanitizeSub(cfg, req.body || {});
    if (!Object.keys(data).length) return res.status(400).json({ error: 'no fields' });
    const before = { ...row };
    const set = Object.keys(data).map(k => `${k}=@${k}`).join(', ');
    db.prepare(`UPDATE ${cfg.table} SET ${set} WHERE id=@id`).run({ ...data, id: req.params.sid });
    logAudit(req.auth.role, `${kind}.update`, req.params.sid);
    const after = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(req.params.sid);
    logAction(req.cookies?.[COOKIE_NAME], { type: `${cfg.table}.update`, target_id: req.params.sid, before, after }, `${kind} bearbeitet`);
    res.json(after);
  });
  app.delete(`/api/persons/:id/${kind}/:sid`, requireEditor, (req, res) => {
    const hard = req.query.hard === '1';
    const before = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=? AND person_id=?`).get(req.params.sid, req.params.id);
    if (hard) {
      const info = db.prepare(`DELETE FROM ${cfg.table} WHERE id=? AND person_id=?`).run(req.params.sid, req.params.id);
      logAudit(req.auth.role, `${kind}.delete.hard`, req.params.sid);
      if (before) logAction(req.cookies?.[COOKIE_NAME], { type: `${cfg.table}.delete`, target_id: req.params.sid, before, after: null }, `${kind} gelöscht`);
      return res.json({ deleted: info.changes, hard: true });
    }
    const info = db.prepare(`UPDATE ${cfg.table} SET deleted_at=?, deleted_by=? WHERE id=? AND person_id=? AND deleted_at IS NULL`)
      .run(nowIso(), req.auth.role, req.params.sid, req.params.id);
    logAudit(req.auth.role, `${kind}.delete.soft`, req.params.sid);
    if (before) logAction(req.cookies?.[COOKIE_NAME], { type: `${cfg.table}.update`, target_id: req.params.sid, before, after: { ...before, deleted_at: nowIso(), deleted_by: req.auth.role } }, `${kind} in Papierkorb`);
    res.json({ deleted: info.changes, soft: true });
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
  const education  = db.prepare('SELECT * FROM education WHERE person_id=? ORDER BY start_date').all(personId);
  const residences = db.prepare('SELECT * FROM residences WHERE person_id=? ORDER BY start_date').all(personId);
  const anecdotes  = db.prepare('SELECT * FROM anecdotes WHERE person_id=? ORDER BY year').all(personId);
  const military   = db.prepare('SELECT * FROM military_service WHERE person_id=? ORDER BY start_date').all(personId);
  const health     = db.prepare('SELECT * FROM health_events WHERE person_id=? ORDER BY date').all(personId);
  const lifeEvents = db.prepare('SELECT * FROM life_events WHERE person_id=? AND deleted_at IS NULL ORDER BY date').all(personId);
  const docCaptions = db.prepare(`
    SELECT i.caption, pi.role FROM images i JOIN person_images pi ON pi.image_id=i.id
    WHERE pi.person_id=? AND i.caption IS NOT NULL
  `).all(personId).map(r => [r.role, r.caption].filter(Boolean).join(': '));

  // User-bestätigte Treffer: harter Wahrheits-Anker für Research + AI-Review.
  const verifiedRows = db.prepare(`
    SELECT source, url, title, snippet, confidence, payload
    FROM research_hits
    WHERE person_id=? AND status IN ('accepted','applied','imported')
    ORDER BY created_at DESC
    LIMIT 40
  `).all(personId);
  const verifiedFacts = verifiedRows.map(r => {
    let p = null; try { p = JSON.parse(r.payload || 'null'); } catch { /* ignore */ }
    // 15 KB pro bestätigter Quelle — Claude Opus-Context ist riesig, 4 KB
    // hat die Familienstruktur bei CPR-Michael (bei Pos 4014) abgeschnitten.
    return { source: r.source, url: r.url, title: r.title, snippet: r.snippet,
      markdown: p?.markdown ? p.markdown.slice(0, 15000) : null };
  });

  // Web-Dossier-Volltexte (nur solche mit markdown im payload) + sonstige Snippets
  // für die AI-Review. Markdown wird gründlich gelesen, Snippets nur als Hinweise.
  const hitRows = db.prepare(`
    SELECT source, url, title, snippet, confidence, payload
    FROM research_hits
    WHERE person_id=? AND status NOT IN ('dismissed','accepted','applied','imported')
    ORDER BY confidence DESC NULLS LAST, created_at DESC
    LIMIT 60
  `).all(personId);
  const webContent = [];
  const webSnippets = [];
  for (const r of hitRows) {
    let p = null;
    try { p = JSON.parse(r.payload || 'null'); } catch { p = null; }
    const md = p && typeof p.markdown === 'string' ? p.markdown : null;
    const base = {
      source: r.source,
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      confidence: r.confidence,
    };
    if (md && md.length > 200) {
      webContent.push({ ...base, markdown: md.slice(0, 10_000) });
    } else if (r.snippet && !/^Keine Treffer\.$|^Zugriff nicht möglich/.test(r.snippet)) {
      webSnippets.push(base);
    }
  }
  // Volltexte: max 6 — sonst Prompt-Explosion. Snippets: max 20.
  const trimmedWebContent = webContent.slice(0, 6);
  const trimmedWebSnippets = webSnippets.slice(0, 20);
  // Abgelehnte Treffer: Claude bekommt diese Negativ-Liste damit er
  // Personen aus diesen Quellen nicht erneut als new_persons/new_edges
  // vorschlägt (häufigster Fehler: gleichnamige Namensvettern).
  const dismissedHits = db.prepare(`
    SELECT source, url, title FROM research_hits
    WHERE person_id=? AND status='dismissed' AND url IS NOT NULL
    ORDER BY created_at DESC LIMIT 50
  `).all(personId);
  return { person, parents, spouses, children, siblings, jobs, education, residences, anecdotes, military, health, lifeEvents, docCaptions,
    webContent: trimmedWebContent, webSnippets: trimmedWebSnippets, verifiedFacts, dismissedHits };
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

/* AI-Review ------------------------------------------------------------ */

// Analyse: liest Daten + Namensregister, baut Vorschläge, speichert in ai_reviews.
// Dedup-Logik: wenn Context seit letztem Review unverändert, keinen neuen
// Claude-Call machen und den letzten Review zurückgeben. Außerdem werden alle
// bereits applied/skipped suggestions der Person als „bereits verarbeitet"
// Hinweis dem LLM mitgegeben.
app.post('/api/persons/:id/ai-review', requireEditor, aiLimiter, async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY nicht gesetzt' });
  const ctx = gatherBioContext(req.params.id);
  if (!ctx) return res.status(404).json({ error: 'person not found' });

  const ctxHash = hashContext(ctx);

  // Context-Hash-Match: Wenn's einen bestehenden Review (gleicher context_hash,
  // status != dismissed) gibt, Verwende den vorhandenen → keine neuen tokens.
  const existing = db.prepare(`SELECT id, suggestions, status, model, created_at
    FROM ai_reviews
    WHERE person_id=? AND context_hash=? AND status != 'dismissed'
    ORDER BY created_at DESC LIMIT 1`).get(req.params.id, ctxHash);
  if (existing) {
    let suggestions;
    try { suggestions = JSON.parse(existing.suggestions); } catch { suggestions = null; }
    if (suggestions) {
      logAudit(req.auth.role, 'ai_review.cached', req.params.id);
      return res.json({
        review_id: existing.id,
        person_id: req.params.id,
        suggestions,
        model: existing.model,
        created_at: existing.created_at,
        cached: true,
        unchanged: true,
      });
    }
  }

  // Namensregister aller anderen Personen für ID-Lookup
  const register = db.prepare(`SELECT id, given_name, surname, birth_name, birth_date
    FROM persons WHERE id != ? ORDER BY surname, given_name`).all(req.params.id);

  // Bereits verarbeitete Vorschläge dieser Person aus allen vergangenen Reviews
  // (für Prompt-Injection, damit der LLM sie nicht erneut vorschlägt).
  const processed = db.prepare(`SELECT i.category, i.status, i.summary, i.applied_at
    FROM ai_review_items i
    JOIN ai_reviews r ON r.id = i.review_id
    WHERE r.person_id=? AND i.status IN ('applied','skipped_duplicate')
    ORDER BY i.applied_at DESC LIMIT 60`).all(req.params.id);

  try {
    const result = await runReview(anthropic, ctx, register, processed);
    const now = nowIso();
    const reviewId = newId();
    db.prepare(`INSERT INTO ai_reviews (id, person_id, suggestions, status, model, context_hash, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(reviewId, req.params.id, JSON.stringify(result.suggestions), 'pending', result.model, ctxHash, now);
    logAudit(req.auth.role, 'ai_review.generate', req.params.id);
    res.json({ review_id: reviewId, person_id: req.params.id, suggestions: result.suggestions, model: result.model, created_at: now, usage: result.usage });
  } catch (err) {
    logAudit(req.auth.role, 'ai_review.fail', req.params.id);
    console.error('ai-review error:', err?.message, err?.raw ? '— raw:' + err.raw.slice(0, 500) : '');
    res.status(502).json({ error: err?.message || 'ai-review failed' });
  }
});

// List open/partial reviews for one person. Frontend nutzt das, um nach
// einem geschlossenen hit-fokussierten Modal die noch offenen Vorschläge
// wiederzufinden.
app.get('/api/persons/:id/ai-reviews', requireViewer, (req, res) => {
  const rows = db.prepare(`SELECT id, status, model, context_hash, created_at, applied_at
    FROM ai_reviews WHERE person_id=? AND status NOT IN ('done','dismissed')
    ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
  res.json(rows);
});

// Einzelnes Review holen (Suggestions + Status) — für Re-Open.
app.get('/api/ai-reviews/:review_id', requireViewer, (req, res) => {
  const row = db.prepare('SELECT * FROM ai_reviews WHERE id=?').get(req.params.review_id);
  if (!row) return res.status(404).json({ error: 'review not found' });
  let suggestions = null;
  try { suggestions = JSON.parse(row.suggestions); } catch { /* ignore */ }
  res.json({ ...row, suggestions });
});

// Apply: wendet selektierte Vorschläge an. Body: { accepted: { new_persons: [idx...], ... } }
// Dedup: vor jedem INSERT wird gegen DB geprüft ob der Vorschlag bereits
// vorhanden ist. Treffer → skip + resolved_entity_id merken (für Edge-Hints
// die auf einen Duplikat-Person zeigen).
app.post('/api/ai-reviews/:review_id/apply', requireEditor, (req, res) => {
  const row = db.prepare('SELECT * FROM ai_reviews WHERE id=?').get(req.params.review_id);
  if (!row) return res.status(404).json({ error: 'review not found' });
  if (row.status === 'done' || row.status === 'dismissed') {
    return res.status(409).json({ error: `review already ${row.status}` });
  }
  let suggestions;
  try { suggestions = JSON.parse(row.suggestions); }
  catch { return res.status(500).json({ error: 'stored suggestions corrupt' }); }

  const accepted = req.body?.accepted || {};
  const personId = row.person_id;
  const now = nowIso();
  const errors = [];
  const skipped = [];
  let applied = 0;

  // Map from "new_persons index" → resolved id (sowohl frisch angelegt als auch bei dedup auf existing)
  const newPersonIds = new Map();

  // Hilfs-Insert für ai_review_items. Idempotent via PRIMARY KEY (review_id,category,idx).
  const insertItem = db.prepare(`INSERT OR REPLACE INTO ai_review_items
    (review_id, category, idx, suggestion_hash, status, resolved_entity_id, summary, applied_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const recordItem = (category, idx, suggestion, status, resolvedId = null) => {
    try {
      insertItem.run(row.id, category, idx, suggestionHash(category, suggestion), status, resolvedId, suggestionSummary(category, suggestion), now);
    } catch (e) {
      // non-fatal, continue
      console.error('ai_review_items write failed:', e.message);
    }
  };

  const tx = db.transaction(() => {
    // 1) new_persons mit Dedup via (given_name, surname, optional birth_date)
    for (const idx of (accepted.new_persons || [])) {
      const p = suggestions.new_persons?.[idx];
      if (!p || !p.given_name || !p.surname) {
        errors.push({ bucket: 'new_persons', idx, error: 'invalid vorschlag' });
        continue;
      }
      // Dedup: gleicher Name (case-insensitive); wenn beide birth_date haben, müssen sie matchen
      const existing = db.prepare(`
        SELECT id FROM persons
        WHERE LOWER(TRIM(given_name))=LOWER(TRIM(?))
          AND LOWER(TRIM(surname))=LOWER(TRIM(?))
          AND (? IS NULL OR birth_date IS NULL OR birth_date=?)
        LIMIT 1`).get(p.given_name, p.surname, p.birth_date || null, p.birth_date || null);
      if (existing) {
        newPersonIds.set(idx, existing.id);
        skipped.push({ bucket: 'new_persons', idx, reason: 'duplicate', existing_id: existing.id });
        recordItem('new_persons', idx, p, 'skipped_duplicate', existing.id);
        continue;
      }
      const id = newId();
      try {
        db.prepare(`INSERT INTO persons (id, given_name, surname, birth_name, nicknames, gender, birth_date, birth_place, death_date, death_place, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, p.given_name, p.surname, p.birth_name || null, null, p.gender || null,
               p.birth_date || null, p.birth_place || null, p.death_date || null, p.death_place || null,
               p.notes || null, now, now);
        newPersonIds.set(idx, id);
        recordItem('new_persons', idx, p, 'applied', id);
        logAudit(req.auth.role, 'ai_review.apply.person', `${row.id} new=${id}`);
        applied++;
      } catch (e) {
        errors.push({ bucket: 'new_persons', idx, error: e.message });
        recordItem('new_persons', idx, p, 'failed');
      }
    }

    // 2) new_edges mit Dedup: gleicher type + from + to (für spouse auch Umkehrrichtung)
    for (const idx of (accepted.new_edges || [])) {
      const e = suggestions.new_edges?.[idx];
      if (!e || !e.type || !['parent','spouse'].includes(e.type)) {
        errors.push({ bucket: 'new_edges', idx, error: 'invalid type' });
        continue;
      }
      const resolve = (field) => {
        const idVal = e[field];
        if (idVal === 'this') return personId;
        if (!idVal) return null;
        const chk = db.prepare('SELECT id FROM persons WHERE id=?').get(idVal);
        return chk ? chk.id : null;
      };
      let fromId = resolve('from_person_id');
      let toId = resolve('to_person_id');
      const applyHint = (hint) => {
        if (!hint) return null;
        if (hint.new_person_idx !== undefined && newPersonIds.has(hint.new_person_idx)) return newPersonIds.get(hint.new_person_idx);
        if (hint.given_name && hint.surname) {
          const match = db.prepare(`SELECT id FROM persons
            WHERE LOWER(TRIM(given_name))=LOWER(TRIM(?)) AND LOWER(TRIM(surname))=LOWER(TRIM(?)) LIMIT 1`)
            .get(hint.given_name, hint.surname);
          if (match) return match.id;
        }
        return null;
      };
      if (!fromId) fromId = applyHint(e.from_hint);
      if (!toId) toId = applyHint(e.to_hint);
      // Fallback: wenn Claude 'null' setzt und keinen Hint liefert, nimmt er damit implizit
      // "diese Person" (Subject des Reviews). Fülle fehlende Seite mit personId auf.
      // Für parent-edges: wenn die aufgefüllte Seite inhaltlich auf der falschen Seite steht
      // (z.B. Mutter als to_hint, Subject als null-from), tausche die Richtung so dass
      // from=Elternteil und to=Kind. Heuristik: wenn eine Seite via Hint neu/existierend
      // und die andere personId ist, und type=parent, prüfe Hint auf typische Eltern-Hinweise.
      const fromWasNull = !e.from_person_id && !e.from_hint;
      const toWasNull = !e.to_person_id && !e.to_hint;
      if (!fromId && fromWasNull) fromId = personId;
      if (!toId && toWasNull) toId = personId;
      if (e.type === 'parent' && fromWasNull && toId && toId !== personId) {
        // Claude meinte: "diese Person hat Elternteil X". Richtige Richtung: from=X, to=diese.
        fromId = toId;
        toId = personId;
      }
      if (e.type === 'parent' && toWasNull && fromId && fromId === personId && e.from_hint) {
        // Analog umgekehrt: from=diese Person, to_hint war Elternteil-Name — swap
        toId = fromId;
        fromId = applyHint(e.from_hint) || personId;
      }
      if (!fromId || !toId) {
        errors.push({ bucket: 'new_edges', idx, error: 'from/to id not resolvable' });
        recordItem('new_edges', idx, e, 'failed');
        continue;
      }
      if (fromId === toId) {
        errors.push({ bucket: 'new_edges', idx, error: 'self-edge' });
        recordItem('new_edges', idx, e, 'failed');
        continue;
      }
      // Dedup: gleiche Edge schon da?
      let dupEdge = db.prepare('SELECT id FROM edges WHERE type=? AND from_id=? AND to_id=? LIMIT 1')
        .get(e.type, fromId, toId);
      if (!dupEdge && e.type === 'spouse') {
        dupEdge = db.prepare('SELECT id FROM edges WHERE type=? AND from_id=? AND to_id=? LIMIT 1')
          .get('spouse', toId, fromId);
      }
      if (dupEdge) {
        skipped.push({ bucket: 'new_edges', idx, reason: 'duplicate', existing_id: dupEdge.id });
        recordItem('new_edges', idx, e, 'skipped_duplicate', dupEdge.id);
        continue;
      }
      try {
        const edgeId = newId();
        const edgeStatus = e.type === 'spouse' ? (e.status || 'married') : null;
        db.prepare(`INSERT INTO edges (id, from_id, to_id, type, since, until, status, created_at)
          VALUES (?,?,?,?,?,?,?,?)`)
          .run(edgeId, fromId, toId, e.type, e.since || null, e.until || null, edgeStatus, now);
        recordItem('new_edges', idx, e, 'applied', edgeId);
        applied++;
      } catch (e2) {
        errors.push({ bucket: 'new_edges', idx, error: e2.message });
        recordItem('new_edges', idx, e, 'failed');
      }
    }

    // 3) new_residences mit Dedup via place / city+street für diese Person
    for (const idx of (accepted.new_residences || [])) {
      const r = suggestions.new_residences?.[idx];
      if (!r) {
        errors.push({ bucket: 'new_residences', idx, error: 'missing' });
        continue;
      }
      const place = r.place || r.city || null;
      const existing = db.prepare(`
        SELECT id FROM residences
        WHERE person_id=? AND (
          (? IS NOT NULL AND LOWER(TRIM(place))=LOWER(TRIM(?)))
          OR (? IS NOT NULL AND ? IS NOT NULL
              AND LOWER(TRIM(city))=LOWER(TRIM(?))
              AND LOWER(TRIM(COALESCE(street,'')))=LOWER(TRIM(COALESCE(?,''))))
        ) LIMIT 1`).get(personId, place, place, r.city, r.street || '', r.city, r.street || '');
      if (existing) {
        skipped.push({ bucket: 'new_residences', idx, reason: 'duplicate', existing_id: existing.id });
        recordItem('new_residences', idx, r, 'skipped_duplicate', existing.id);
        continue;
      }
      try {
        const id = newId();
        db.prepare(`INSERT INTO residences (id, person_id, place, street, city, district, postal_code, postal_code_historical, region, country, start_date, end_date, kind, notes, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, personId, place, r.street || null, r.city || null, r.district || null,
               r.postal_code || null, r.postal_code_historical || null, r.region || null, r.country || 'Deutschland',
               r.start_date || null, r.end_date || null, r.kind || null, r.notes || null, now);
        recordItem('new_residences', idx, r, 'applied', id);
        applied++;
      } catch (e) {
        errors.push({ bucket: 'new_residences', idx, error: e.message });
        recordItem('new_residences', idx, r, 'failed');
      }
    }

    // 4) residence_updates — nur Felder patchen, die noch leer/null sind. Keine
    //    bestehende Information überschreiben. Keine no-op's.
    for (const idx of (accepted.residence_updates || [])) {
      const u = suggestions.residence_updates?.[idx];
      if (!u?.entry_id || !u.patch) {
        errors.push({ bucket: 'residence_updates', idx, error: 'incomplete' });
        continue;
      }
      const current = db.prepare('SELECT * FROM residences WHERE id=? AND person_id=?').get(u.entry_id, personId);
      if (!current) {
        errors.push({ bucket: 'residence_updates', idx, error: 'row not found' });
        recordItem('residence_updates', idx, u, 'failed');
        continue;
      }
      const allowed = ['place','street','city','district','postal_code','postal_code_historical','region','country','start_date','end_date','kind','notes'];
      // Nur Felder patchen, die noch null/leer sind
      const fields = Object.keys(u.patch).filter(k => allowed.includes(k) && !current[k]);
      if (!fields.length) {
        skipped.push({ bucket: 'residence_updates', idx, reason: 'no-op (all fields already filled)', existing_id: u.entry_id });
        recordItem('residence_updates', idx, u, 'skipped_duplicate', u.entry_id);
        continue;
      }
      const setStr = fields.map(f => `${f}=?`).join(', ');
      const vals = fields.map(f => u.patch[f]);
      try {
        const r = db.prepare(`UPDATE residences SET ${setStr} WHERE id=? AND person_id=?`).run(...vals, u.entry_id, personId);
        if (r.changes) { applied++; recordItem('residence_updates', idx, u, 'applied', u.entry_id); }
        else { errors.push({ bucket: 'residence_updates', idx, error: 'row not updated' }); recordItem('residence_updates', idx, u, 'failed'); }
      } catch (e) {
        errors.push({ bucket: 'residence_updates', idx, error: e.message });
        recordItem('residence_updates', idx, u, 'failed');
      }
    }

    // 5) job_updates — nur null-Felder patchen
    for (const idx of (accepted.job_updates || [])) {
      const u = suggestions.job_updates?.[idx];
      if (!u?.entry_id || !u.patch) {
        errors.push({ bucket: 'job_updates', idx, error: 'incomplete' });
        continue;
      }
      const current = db.prepare('SELECT * FROM jobs WHERE id=? AND person_id=?').get(u.entry_id, personId);
      if (!current) {
        errors.push({ bucket: 'job_updates', idx, error: 'row not found' });
        recordItem('job_updates', idx, u, 'failed');
        continue;
      }
      const allowed = ['title','employer','start_date','end_date','place','notes'];
      const fields = Object.keys(u.patch).filter(k => allowed.includes(k) && !current[k]);
      if (!fields.length) {
        skipped.push({ bucket: 'job_updates', idx, reason: 'no-op (all fields already filled)', existing_id: u.entry_id });
        recordItem('job_updates', idx, u, 'skipped_duplicate', u.entry_id);
        continue;
      }
      const setStr = fields.map(f => `${f}=?`).join(', ');
      const vals = fields.map(f => u.patch[f]);
      try {
        const r = db.prepare(`UPDATE jobs SET ${setStr} WHERE id=? AND person_id=?`).run(...vals, u.entry_id, personId);
        if (r.changes) { applied++; recordItem('job_updates', idx, u, 'applied', u.entry_id); }
        else { errors.push({ bucket: 'job_updates', idx, error: 'row not updated' }); recordItem('job_updates', idx, u, 'failed'); }
      } catch (e) {
        errors.push({ bucket: 'job_updates', idx, error: e.message });
        recordItem('job_updates', idx, u, 'failed');
      }
    }

    // 5b) new_jobs — Dedup via (title, employer) für diese Person
    for (const idx of (accepted.new_jobs || [])) {
      const j = suggestions.new_jobs?.[idx];
      if (!j || (!j.title && !j.employer)) {
        errors.push({ bucket: 'new_jobs', idx, error: 'empty' });
        continue;
      }
      const existing = db.prepare(`
        SELECT id FROM jobs WHERE person_id=?
          AND LOWER(TRIM(COALESCE(title,'')))=LOWER(TRIM(COALESCE(?,'')))
          AND LOWER(TRIM(COALESCE(employer,'')))=LOWER(TRIM(COALESCE(?,'')))
        LIMIT 1
      `).get(personId, j.title || null, j.employer || null);
      if (existing) {
        skipped.push({ bucket: 'new_jobs', idx, reason: 'duplicate', existing_id: existing.id });
        recordItem('new_jobs', idx, j, 'skipped_duplicate', existing.id);
        continue;
      }
      try {
        const id = newId();
        db.prepare(`INSERT INTO jobs (id, person_id, title, employer, start_date, end_date, place, notes, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, personId, j.title || null, j.employer || null, j.start_date || null, j.end_date || null, j.place || null, j.notes || null, now);
        recordItem('new_jobs', idx, j, 'applied', id);
        applied++;
      } catch (e) {
        errors.push({ bucket: 'new_jobs', idx, error: e.message });
        recordItem('new_jobs', idx, j, 'failed');
      }
    }

    // 5c) new_education — Dedup via (institution, field) für diese Person
    for (const idx of (accepted.new_education || [])) {
      const e = suggestions.new_education?.[idx];
      if (!e || (!e.institution && !e.field)) {
        errors.push({ bucket: 'new_education', idx, error: 'empty' });
        continue;
      }
      const existing = db.prepare(`
        SELECT id FROM education WHERE person_id=?
          AND LOWER(TRIM(COALESCE(institution,'')))=LOWER(TRIM(COALESCE(?,'')))
          AND LOWER(TRIM(COALESCE(field,'')))=LOWER(TRIM(COALESCE(?,'')))
        LIMIT 1
      `).get(personId, e.institution || null, e.field || null);
      if (existing) {
        skipped.push({ bucket: 'new_education', idx, reason: 'duplicate', existing_id: existing.id });
        recordItem('new_education', idx, e, 'skipped_duplicate', existing.id);
        continue;
      }
      try {
        const id = newId();
        db.prepare(`INSERT INTO education (id, person_id, institution, field, degree, place, start_date, end_date, notes, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(id, personId, e.institution || null, e.field || null, e.degree || null, e.place || null, e.start_date || null, e.end_date || null, e.notes || null, now);
        recordItem('new_education', idx, e, 'applied', id);
        applied++;
      } catch (err) {
        errors.push({ bucket: 'new_education', idx, error: err.message });
        recordItem('new_education', idx, e, 'failed');
      }
    }

    // 5d) new_anecdotes — Dedup via (title, text-prefix)
    for (const idx of (accepted.new_anecdotes || [])) {
      const a = suggestions.new_anecdotes?.[idx];
      if (!a || !a.text) {
        errors.push({ bucket: 'new_anecdotes', idx, error: 'text required' });
        continue;
      }
      const prefix = (a.text || '').slice(0, 80).toLowerCase().trim();
      const existing = db.prepare(`
        SELECT id FROM anecdotes WHERE person_id=?
          AND LOWER(SUBSTR(text, 1, 80))=? LIMIT 1
      `).get(personId, prefix);
      if (existing) {
        skipped.push({ bucket: 'new_anecdotes', idx, reason: 'duplicate', existing_id: existing.id });
        recordItem('new_anecdotes', idx, a, 'skipped_duplicate', existing.id);
        continue;
      }
      try {
        const id = newId();
        db.prepare(`INSERT INTO anecdotes (id, person_id, title, text, source, year, created_at)
          VALUES (?,?,?,?,?,?,?)`)
          .run(id, personId, a.title || null, a.text, a.source || null, a.year || null, now);
        recordItem('new_anecdotes', idx, a, 'applied', id);
        applied++;
      } catch (err) {
        errors.push({ bucket: 'new_anecdotes', idx, error: err.message });
        recordItem('new_anecdotes', idx, a, 'failed');
      }
    }

    // 6) field_updates — Race-Condition-Check: 'current' muss match
    for (const idx of (accepted.field_updates || [])) {
      const u = suggestions.field_updates?.[idx];
      const allowed = ['given_name','surname','birth_name','nicknames','title','gender','birth_date','birth_place','death_date','death_place','notes'];
      if (!u?.field || !allowed.includes(u.field) || u.suggested === undefined) {
        errors.push({ bucket: 'field_updates', idx, error: 'invalid field' });
        continue;
      }
      const row2 = db.prepare(`SELECT ${u.field} AS val FROM persons WHERE id=?`).get(personId);
      if (!row2) {
        errors.push({ bucket: 'field_updates', idx, error: 'person missing' });
        recordItem('field_updates', idx, u, 'failed');
        continue;
      }
      // Race-Condition: current im Vorschlag muss der aktuelle DB-Wert sein (sonst skip)
      if (u.current !== undefined && u.current !== null && String(row2.val || '') !== String(u.current)) {
        skipped.push({ bucket: 'field_updates', idx, reason: 'current value changed since review' });
        recordItem('field_updates', idx, u, 'skipped_duplicate');
        continue;
      }
      // No-op: schon der Zielwert
      if (String(row2.val || '') === String(u.suggested || '')) {
        skipped.push({ bucket: 'field_updates', idx, reason: 'already set to suggested value' });
        recordItem('field_updates', idx, u, 'skipped_duplicate');
        continue;
      }
      try {
        db.prepare(`UPDATE persons SET ${u.field}=?, updated_at=? WHERE id=?`).run(u.suggested, now, personId);
        applied++;
        recordItem('field_updates', idx, u, 'applied', personId);
      } catch (e) {
        errors.push({ bucket: 'field_updates', idx, error: e.message });
        recordItem('field_updates', idx, u, 'failed');
      }
    }
  });

  try { tx(); }
  catch (txErr) {
    logAudit(req.auth.role, 'ai_review.apply.fail', `${row.id} ${txErr.message}`);
    return res.status(500).json({ error: 'transaction failed: ' + txErr.message, applied: 0, errors });
  }

  // Status: wenn alles akzeptiert ohne Fehler → done, sonst partially_applied
  const total = Object.values(accepted).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
  const newStatus = (applied === 0 && skipped.length === 0) ? 'pending'
    : (errors.length ? 'partially_applied' : 'done');
  db.prepare(`UPDATE ai_reviews SET status=?, applied_at=? WHERE id=?`).run(newStatus, now, row.id);
  logAudit(req.auth.role, 'ai_review.apply', `${row.id} applied=${applied} skipped=${skipped.length} errors=${errors.length}`);
  res.json({ review_id: row.id, applied, skipped, requested: total, errors, status: newStatus });
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
  // Enrich person with structured sub-resources AND verified facts (user-accepted
  // hits), so sources like web_dossier can boost results matching confirmed truth.
  try { person.jobs = db.prepare('SELECT title, employer, place FROM jobs WHERE person_id=?').all(req.params.id); } catch { person.jobs = []; }
  try { person.education = db.prepare('SELECT institution, field, place FROM education WHERE person_id=?').all(req.params.id); } catch { person.education = []; }
  try { person.residences = db.prepare('SELECT place, city, region, country FROM residences WHERE person_id=?').all(req.params.id); } catch { person.residences = []; }
  // Related cities: wenn Person selbst keine Residenzen hat, nutze Städte
  // der Eltern/Ehepartner/Kinder als Proxy-Lokation für Query-Expansion.
  try {
    const neighborIds = db.prepare(`
      SELECT DISTINCT CASE WHEN from_id=? THEN to_id ELSE from_id END AS pid
      FROM edges WHERE (from_id=? OR to_id=?) AND type IN ('parent','spouse')
    `).all(req.params.id, req.params.id, req.params.id).map(r => r.pid);
    const cities = new Set();
    for (const pid of neighborIds.slice(0, 8)) {
      const bp = db.prepare('SELECT birth_place, death_place FROM persons WHERE id=?').get(pid);
      if (bp?.birth_place) cities.add(bp.birth_place.split(',')[0].trim());
      if (bp?.death_place) cities.add(bp.death_place.split(',')[0].trim());
      const rs = db.prepare('SELECT city, place FROM residences WHERE person_id=? LIMIT 3').all(pid);
      for (const r of rs) {
        const c = (r.city || r.place || '').split(',')[0].trim();
        if (c) cities.add(c);
      }
    }
    person.related_cities = Array.from(cities).filter(Boolean).slice(0, 6);
  } catch { person.related_cities = []; }
  try {
    const vrows = db.prepare(`SELECT source, url, title, snippet, payload FROM research_hits
      WHERE person_id=? AND status IN ('accepted','applied','imported') ORDER BY created_at DESC LIMIT 20`).all(req.params.id);
    person.verified_facts = vrows.map(r => {
      let p = null; try { p = JSON.parse(r.payload || 'null'); } catch { /* ignore */ }
      return { source: r.source, url: r.url, title: r.title, snippet: r.snippet,
        markdown: p?.markdown ? p.markdown.slice(0, 10000) : null };
    });
  } catch { person.verified_facts = []; }
  // Abgelehnte URLs: sources sollen sie nicht erneut scrapen und ins Dossier
  // hochrangig zurückbringen. web_dossier filtert sie vor dem Deep-Scrape raus.
  try {
    person.dismissed_urls = db.prepare(`SELECT url FROM research_hits
      WHERE person_id=? AND status='dismissed' AND url IS NOT NULL`).all(req.params.id).map(r => r.url);
  } catch { person.dismissed_urls = []; }
  // Fresh cache for sources that read verified_facts (confidence re-weighting needs re-run)
  const useCache = req.body?.use_cache !== false && !person.verified_facts.length;
  try {
    const result = await runSingleSource(key, person, { useCache });
    const now = nowIso();
    const insertHit = db.prepare(`
      INSERT INTO research_hits (id, person_id, source, url, title, snippet, confidence, payload, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(person_id, source, url) DO UPDATE SET
        title=excluded.title, snippet=excluded.snippet, confidence=excluded.confidence,
        payload=excluded.payload,
        status=CASE
          WHEN research_hits.status IN ('accepted','dismissed','applied','imported') THEN research_hits.status
          WHEN research_hits.payload != excluded.payload THEN 'pending'
          ELSE research_hits.status
        END
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
  const rows = db.prepare(`SELECT * FROM research_hits WHERE person_id=? ORDER BY created_at ASC`)
    .all(req.params.id);
  res.json(rows.map(r => ({ ...r, payload: safeJson(r.payload) })));
});

// Manuelle URL-Ergänzung: User klebt eine URL rein, Backend scraped sie via
// Firecrawl, legt sie als research_hit mit source='manual_url' und markdown
// im payload an. User kann dann wie jeden anderen Treffer bestätigen → löst
// die Hit-fokussierte KI-Analyse aus.
app.post('/api/persons/:id/research/add-url', requireEditor, aiLimiter, async (req, res) => {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(req.params.id);
  if (!person) return res.status(404).json({ error: 'person not found' });
  const url = String(req.body?.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url (http[s]://…) erforderlich' });

  // Duplicate-Check: existiert hit mit dieser URL schon?
  const existing = db.prepare('SELECT id, status FROM research_hits WHERE person_id=? AND url=?')
    .get(req.params.id, url);
  if (existing) {
    return res.status(409).json({ error: 'URL schon vorhanden', hit_id: existing.id, status: existing.status });
  }

  try {
    const r = await fetchPage('manual_url', url, { timeout: 20_000 });
    if (!r.ok) return res.status(502).json({ error: 'Scrape fehlgeschlagen', detail: r.error || r.status });
    const md = (r.markdown || r.text || '').trim();
    if (md.length < 100) return res.status(502).json({ error: 'Seite liefert zu wenig Inhalt (<100 Zeichen)' });

    // Titel aus Markdown-H1 ziehen, Fallback auf URL
    const h1Match = md.match(/^#\s+(.{3,200})/m);
    const title = h1Match ? h1Match[1].trim() : (new URL(url)).host + new URL(url).pathname;
    const snippet = md.replace(/[#*_`\[\]()!>]/g, ' ').replace(/\s+/g, ' ').slice(0, 240);

    const hitId = newId();
    db.prepare(`INSERT INTO research_hits
      (id, person_id, source, url, title, snippet, confidence, payload, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(hitId, req.params.id, 'manual_url', url, title.slice(0, 200), snippet, 0.9,
        JSON.stringify({ markdown: md.slice(0, 20_000), manual: true }), 'pending', nowIso());
    logAudit(req.auth.role, 'research.add_url', req.params.id);
    res.json({ hit_id: hitId, title, snippet, markdown_length: md.length });
  } catch (err) {
    console.error('[add-url] failed:', err?.message);
    res.status(502).json({ error: err?.message || 'add-url failed' });
  }
});

app.post('/api/research/hits/:id/apply', requireEditor, async (req, res) => {
  const hit = db.prepare('SELECT * FROM research_hits WHERE id=?').get(req.params.id);
  if (!hit) return res.status(404).json({ error: 'hit not found' });
  const action = String(req.body?.action || '').trim();
  if (!['accept','dismiss','add_source_note','reset'].includes(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }
  let newStatus = action;
  if (action === 'reset') newStatus = 'pending';
  if (action === 'dismiss') newStatus = 'dismissed';
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

  // Hit-focused AI review: wenn der User einen Treffer bestätigt und
  // der Treffer einen Volltext (markdown) im payload trägt → sofort einen
  // fokussierten Claude-Call starten, der NUR diese eine Quelle gründlich
  // ausliest und Fakten (Ausbildung, Berufe, Residenzen, Eltern etc.) als
  // Vorschläge extrahiert. Die Vorschläge landen im bestehenden
  // ai_reviews-Modell und werden vom User im Review-Modal einzeln bestätigt.
  let review = null;
  if (action === 'accept' && anthropic && hit.person_id) {
    try {
      const payload = JSON.parse(hit.payload || 'null');
      const md = payload?.markdown;
      if (md && md.length >= 300) {
        review = await runHitFocusedReview(hit, md);
      }
    } catch (err) {
      console.error('[hit-focused-review] failed:', err?.message);
    }
  }

  res.json({ id: req.params.id, status: newStatus, review });
});

async function runHitFocusedReview(hit, markdown) {
  const ctx = gatherBioContext(hit.person_id);
  if (!ctx) return null;
  // Replace web content with ONLY this one accepted hit; verified_facts stays
  // (so cross-source consistency still applies).
  ctx.webContent = [{
    source: hit.source,
    url: hit.url,
    title: hit.title,
    confidence: hit.confidence,
    markdown: markdown.slice(0, 10_000),
  }];
  ctx.webSnippets = [];
  const register = db.prepare(`SELECT id, given_name, surname, birth_name, birth_date
    FROM persons WHERE id != ? ORDER BY surname, given_name`).all(hit.person_id);
  const processed = db.prepare(`SELECT i.category, i.status, i.summary, i.applied_at
    FROM ai_review_items i JOIN ai_reviews r ON r.id = i.review_id
    WHERE r.person_id=? AND i.status IN ('applied','skipped_duplicate')
    ORDER BY i.applied_at DESC LIMIT 60`).all(hit.person_id);
  const result = await runReview(anthropic, ctx, register, processed);
  const now = nowIso();
  const reviewId = newId();
  // Context-hash includes the hit id so the hit-review stays distinct from
  // the general ai-review cache.
  const ctxHash = 'hit:' + hit.id;
  db.prepare(`INSERT INTO ai_reviews (id, person_id, suggestions, status, model, context_hash, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(reviewId, hit.person_id, JSON.stringify(result.suggestions), 'pending', result.model, ctxHash, now);
  logAudit('editor', 'ai_review.hit_focused', hit.person_id);
  return {
    review_id: reviewId,
    person_id: hit.person_id,
    suggestions: result.suggestions,
    model: result.model,
    source_hit_id: hit.id,
    source_hit_title: hit.title,
    created_at: now,
  };
}

function safeJson(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }

// Import a web-image hit into the person's gallery. Fetches image_url, stores
// as blob, links via person_images, optionally sets as portrait.
app.post('/api/research/hits/:id/import-image', requireEditor, async (req, res) => {
  const hit = db.prepare('SELECT * FROM research_hits WHERE id=?').get(req.params.id);
  if (!hit) return res.status(404).json({ error: 'hit not found' });
  const payload = safeJson(hit.payload) || {};
  const imageUrl = payload.image_url;
  if (!imageUrl) return res.status(400).json({ error: 'hit has no image_url' });
  const role = String(req.body?.role || 'Foto').slice(0, 80).trim() || 'Foto';
  const setAsPortrait = !!req.body?.set_as_portrait;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const r = await fetch(imageUrl, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'user-agent': 'Stammbaum/1.0 (private family research)', 'accept': 'image/*' } });
    clearTimeout(t);
    if (!r.ok) return res.status(502).json({ error: `Download fehlgeschlagen (HTTP ${r.status})` });
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!/^image\//.test(mime)) return res.status(400).json({ error: `kein Bild (${mime})` });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return res.status(413).json({ error: 'Bild über 15 MB' });
    const imageId = newId();
    const now = nowIso();
    const caption = `${hit.title || 'Web-Fund'} (Quelle: ${payload.page_url || hit.url || hit.source})`.slice(0, 500);
    writeFileSync(pathJoin(IMAGES_DIR, imageId), buf);
    const effectiveRole = setAsPortrait ? 'Portrait' : role;
    db.transaction(() => {
      db.prepare('INSERT INTO images (id, mime, bytes, caption, taken_at, created_at) VALUES (?,?,?,?,?,?)')
        .run(imageId, mime, buf.length, caption, null, now);
      if (setAsPortrait) {
        db.prepare(`UPDATE person_images SET role='Foto' WHERE person_id=? AND role='Portrait'`).run(hit.person_id);
      }
      db.prepare('INSERT INTO person_images (person_id, image_id, role, created_at) VALUES (?,?,?,?)')
        .run(hit.person_id, imageId, effectiveRole, now);
    })();
    db.prepare('UPDATE research_hits SET status=? WHERE id=?').run('imported', req.params.id);
    logAudit(req.auth.role, 'research.import_image', `${req.params.id} → image=${imageId} role=${role}`);
    res.json({ image_id: imageId, role, set_as_portrait: setAsPortrait });
  } catch (err) {
    console.error('import-image failed:', err?.message);
    res.status(502).json({ error: err?.message || 'import fehlgeschlagen' });
  }
});

/* recycle bin ----------------------------------------------------------- */

const SOFT_DELETE_RESOURCES = {
  persons:          { table: 'persons', label: 'Person', summary: p => [p.given_name, p.surname].filter(Boolean).join(' ') || 'unbenannt' },
  edges:            { table: 'edges',   label: 'Beziehung', summary: e => `${e.type} (${(e.from_id||'').slice(0,8)}→${(e.to_id||'').slice(0,8)})` },
  residences:       { table: 'residences', label: 'Wohnort', summary: r => r.place || r.city || 'Wohnort' },
  jobs:             { table: 'jobs', label: 'Beruf', summary: j => j.title || 'Beruf' },
  education:        { table: 'education', label: 'Ausbildung', summary: e => e.institution || e.field || 'Ausbildung' },
  military_service: { table: 'military_service', label: 'Militärdienst', summary: m => m.branch || 'Militär' },
  health_events:    { table: 'health_events', label: 'Gesundheit', summary: h => h.condition || 'Gesundheit' },
  anecdotes:        { table: 'anecdotes', label: 'Anekdote', summary: a => a.title || (a.text || '').slice(0, 60) },
  images:           { table: 'images', label: 'Bild', summary: i => i.caption || 'Bild' },
};

app.get('/api/recycle', requireViewer, (_req, res) => {
  const result = {};
  for (const [key, cfg] of Object.entries(SOFT_DELETE_RESOURCES)) {
    const rows = db.prepare(`SELECT * FROM ${cfg.table} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all();
    result[key] = rows.map(r => ({
      id: r.id,
      resource: key,
      label: cfg.label,
      summary: cfg.summary(r),
      deleted_at: r.deleted_at,
      deleted_by: r.deleted_by,
      row: r,
    }));
  }
  res.json(result);
});

app.post('/api/recycle/:resource/:id/restore', requireEditor, (req, res) => {
  const cfg = SOFT_DELETE_RESOURCES[req.params.resource];
  if (!cfg) return res.status(400).json({ error: 'unknown resource' });
  const info = db.prepare(`UPDATE ${cfg.table} SET deleted_at=NULL, deleted_by=NULL WHERE id=? AND deleted_at IS NOT NULL`)
    .run(req.params.id);
  logAudit(req.auth.role, 'recycle.restore', `${req.params.resource}/${req.params.id}`);
  res.json({ restored: info.changes });
});

app.delete('/api/recycle/:resource/:id', requireEditor, (req, res) => {
  const cfg = SOFT_DELETE_RESOURCES[req.params.resource];
  if (!cfg) return res.status(400).json({ error: 'unknown resource' });
  const info = db.prepare(`DELETE FROM ${cfg.table} WHERE id=? AND deleted_at IS NOT NULL`).run(req.params.id);
  logAudit(req.auth.role, 'recycle.purge', `${req.params.resource}/${req.params.id}`);
  res.json({ purged: info.changes });
});

// Auto-Purge: Items die laenger als N Tage im Recycle Bin liegen werden
// bei Boot endgueltig geloescht. Default 90 Tage; via env RECYCLE_PURGE_DAYS=0 deaktivieren.
const PURGE_DAYS = parseInt(process.env.RECYCLE_PURGE_DAYS || '90', 10);
if (PURGE_DAYS > 0) {
  const cutoff = new Date(Date.now() - PURGE_DAYS * 86400_000).toISOString();
  for (const [key, cfg] of Object.entries(SOFT_DELETE_RESOURCES)) {
    try {
      const info = db.prepare(`DELETE FROM ${cfg.table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(cutoff);
      if (info.changes) console.log(`[recycle] auto-purged ${info.changes} ${key} older than ${PURGE_DAYS}d`);
    } catch (e) { console.warn(`[recycle] purge ${key} failed:`, e.message); }
  }
}

/* places autocomplete --------------------------------------------------- */

// Alle Orte die bereits in Person-/Residenz-/Job-/Education-Feldern vorkommen,
// gruppiert mit Zähler. Für datalist-Autocomplete.
app.get('/api/places', requireViewer, (_req, res) => {
  const sources = [
    'SELECT birth_place AS place FROM persons WHERE deleted_at IS NULL AND birth_place IS NOT NULL AND birth_place <> ""',
    'SELECT death_place AS place FROM persons WHERE deleted_at IS NULL AND death_place IS NOT NULL AND death_place <> ""',
    'SELECT place        FROM residences WHERE deleted_at IS NULL AND place IS NOT NULL AND place <> ""',
    'SELECT city AS place FROM residences WHERE deleted_at IS NULL AND city  IS NOT NULL AND city  <> ""',
    'SELECT place        FROM jobs       WHERE deleted_at IS NULL AND place IS NOT NULL AND place <> ""',
    'SELECT place        FROM education  WHERE deleted_at IS NULL AND place IS NOT NULL AND place <> ""',
  ];
  const counts = new Map();
  for (const sql of sources) {
    try {
      for (const row of db.prepare(sql).all()) {
        const p = (row.place || '').trim();
        if (!p) continue;
        counts.set(p, (counts.get(p) || 0) + 1);
      }
    } catch { /* table may not exist in older DBs */ }
  }
  const list = Array.from(counts.entries())
    .map(([place, count]) => ({ place, count }))
    .sort((a, b) => b.count - a.count || a.place.localeCompare(b.place));
  res.json(list);
});

/* plausibility ---------------------------------------------------------- */

app.get('/api/plausibility', requireViewer, (_req, res) => {
  try {
    const issues = runPlausibilityChecks(db);
    res.json({ issues, generated_at: nowIso() });
  } catch (e) {
    console.error('[plausibility]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plausibility/dismiss', requireEditor, (req, res) => {
  const key = String(req.body?.issue_key || '').trim();
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  if (!key) return res.status(400).json({ error: 'issue_key required' });
  db.prepare(`INSERT OR REPLACE INTO plausibility_dismissals (issue_key, note, dismissed_at, dismissed_by)
              VALUES (?, ?, ?, ?)`).run(key, note, nowIso(), req.auth.role);
  logAudit(req.auth.role, 'plausibility.dismiss', key);
  res.json({ dismissed: key });
});

app.delete('/api/plausibility/dismiss/:key', requireEditor, (req, res) => {
  const info = db.prepare('DELETE FROM plausibility_dismissals WHERE issue_key=?').run(req.params.key);
  logAudit(req.auth.role, 'plausibility.undismiss', req.params.key);
  res.json({ removed: info.changes });
});

/* dashboard: anniversaries + stats -------------------------------------- */

function parseIsoDay(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yr = +m[1], mo = +m[2], da = +m[3];
  if (yr < 1500 || yr > 2500 || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return { year: yr, month: mo, day: da };
}

app.get('/api/dashboard/anniversaries', requireViewer, (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayMs = today.getTime();
  const horizon = todayMs + days * 86400000;

  const items = [];
  // Birth + death
  const persons = db.prepare(`SELECT id, given_name, surname, birth_date, death_date FROM persons WHERE deleted_at IS NULL`).all();
  for (const p of persons) {
    const b = parseIsoDay(p.birth_date);
    const d = parseIsoDay(p.death_date);
    const name = [p.given_name, p.surname].filter(Boolean).join(' ');
    if (b) {
      // next birthday in horizon
      let ny = today.getFullYear();
      let occ = new Date(ny, b.month - 1, b.day).getTime();
      if (occ < todayMs) { ny++; occ = new Date(ny, b.month - 1, b.day).getTime(); }
      if (occ <= horizon) {
        const years = ny - b.year;
        if (!d) {
          items.push({ type: 'birthday', person_id: p.id, when: occ, mmdd: pad2(b.month)+'-'+pad2(b.day), years_since: years, label: `${name} wird ${years}` });
        } else {
          items.push({ type: 'birthday_memorial', person_id: p.id, when: occ, mmdd: pad2(b.month)+'-'+pad2(b.day), years_since: years, label: `${name} wäre ${years} geworden` });
        }
      }
    }
    if (d) {
      let ny = today.getFullYear();
      let occ = new Date(ny, d.month - 1, d.day).getTime();
      if (occ < todayMs) { ny++; occ = new Date(ny, d.month - 1, d.day).getTime(); }
      if (occ <= horizon) {
        const years = ny - d.year;
        items.push({ type: 'death', person_id: p.id, when: occ, mmdd: pad2(d.month)+'-'+pad2(d.day), years_since: years, label: `${years}. Todestag · ${name}` });
      }
    }
  }
  // Wedding
  const spouses = db.prepare(`SELECT e.id, e.from_id, e.to_id, e.since, e.status, p1.given_name as g1, p1.surname as s1, p2.given_name as g2, p2.surname as s2
    FROM edges e
    JOIN persons p1 ON p1.id = e.from_id
    JOIN persons p2 ON p2.id = e.to_id
    WHERE e.type='spouse' AND e.deleted_at IS NULL AND (e.status IS NULL OR e.status IN ('married','partner','engaged')) AND e.since IS NOT NULL`).all();
  for (const e of spouses) {
    const s = parseIsoDay(e.since);
    if (!s) continue;
    let ny = today.getFullYear();
    let occ = new Date(ny, s.month - 1, s.day).getTime();
    if (occ < todayMs) { ny++; occ = new Date(ny, s.month - 1, s.day).getTime(); }
    if (occ <= horizon) {
      const years = ny - s.year;
      const n1 = [e.g1, e.s1].filter(Boolean).join(' ');
      const n2 = [e.g2, e.s2].filter(Boolean).join(' ');
      items.push({ type: 'wedding', edge_id: e.id, person_id: e.from_id, partner_id: e.to_id, when: occ, mmdd: pad2(s.month)+'-'+pad2(s.day), years_since: years, label: `${years}. Hochzeitstag · ${n1} ❤ ${n2}` });
    }
  }
  items.sort((a, b) => a.when - b.when);
  res.json({ days, count: items.length, items });
});

function pad2(n) { return String(n).padStart(2, '0'); }

app.get('/api/dashboard/stats', requireViewer, (_req, res) => {
  const persons = db.prepare(`SELECT * FROM persons WHERE deleted_at IS NULL`).all();
  const edges = db.prepare(`SELECT * FROM edges WHERE deleted_at IS NULL`).all();
  const residences = db.prepare(`SELECT country, city FROM residences WHERE deleted_at IS NULL`).all();

  const total = persons.length;
  const deceased = persons.filter(p => p.death_date).length;
  const living = total - deceased;

  const parentOf = new Map(); // child -> [parents]
  const childrenOf = new Map(); // parent -> [children]
  const spouseOf = new Map();
  for (const e of edges) {
    if (e.type === 'parent') {
      if (!parentOf.has(e.to_id)) parentOf.set(e.to_id, []);
      parentOf.get(e.to_id).push(e.from_id);
      if (!childrenOf.has(e.from_id)) childrenOf.set(e.from_id, []);
      childrenOf.get(e.from_id).push(e.to_id);
    } else if (e.type === 'spouse') {
      if (!spouseOf.has(e.from_id)) spouseOf.set(e.from_id, new Set());
      if (!spouseOf.has(e.to_id)) spouseOf.set(e.to_id, new Set());
      spouseOf.get(e.from_id).add(e.to_id);
      spouseOf.get(e.to_id).add(e.from_id);
    }
  }

  // Portraits
  const portraitIds = new Set(db.prepare(`SELECT DISTINCT person_id FROM person_images WHERE role='Portrait' AND deleted_at IS NULL`).all().map(r => r.person_id));

  const noParents = persons.filter(p => !parentOf.get(p.id)?.length).map(p => p.id);
  const noChildren = persons.filter(p => !childrenOf.get(p.id)?.length).map(p => p.id);
  const noBirthDate = persons.filter(p => !p.birth_date).map(p => p.id);
  const noDeathDate = persons.filter(p => p.death_date == null && !spouseOf.get(p.id)).map(p => p.id); // weak
  const noPortrait = persons.filter(p => !portraitIds.has(p.id)).map(p => p.id);

  // Couples without children: pairs that share no children
  const seenCouples = new Set();
  let couplesWithoutChildren = 0;
  for (const e of edges) {
    if (e.type !== 'spouse') continue;
    const key = [e.from_id, e.to_id].sort().join('|');
    if (seenCouples.has(key)) continue;
    seenCouples.add(key);
    const ca = new Set(childrenOf.get(e.from_id) || []);
    const cb = new Set(childrenOf.get(e.to_id) || []);
    let shared = 0;
    for (const c of ca) if (cb.has(c)) shared++;
    if (shared === 0) couplesWithoutChildren++;
  }

  // Decade histogram
  const eventsByDecade = {};
  for (const p of persons) {
    const y = p.birth_date && /^\d{4}/.test(p.birth_date) ? Math.floor(parseInt(p.birth_date, 10) / 10) * 10 : null;
    if (y) eventsByDecade[y] = (eventsByDecade[y] || 0) + 1;
  }

  // Depth via BFS from roots down
  const depth = {};
  const roots = persons.filter(p => !parentOf.get(p.id)?.length).map(p => p.id);
  for (const r of roots) depth[r] = 0;
  let changed = true, maxDepth = 0;
  while (changed) {
    changed = false;
    for (const p of persons) {
      const parents = parentOf.get(p.id) || [];
      if (!parents.length) continue;
      const parentDepths = parents.map(pid => depth[pid]).filter(x => x != null);
      if (!parentDepths.length) continue;
      const d = Math.max(...parentDepths) + 1;
      if (depth[p.id] !== d) { depth[p.id] = d; changed = true; }
      if (d > maxDepth) maxDepth = d;
    }
  }

  // Name frequency
  const givenFreq = {}, surnameFreq = {};
  for (const p of persons) {
    const g = (p.given_name || '').split(/\s+/)[0];
    if (g) givenFreq[g] = (givenFreq[g] || 0) + 1;
    const s = p.surname;
    if (s) surnameFreq[s] = (surnameFreq[s] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, count: v }));

  // Country distribution
  const byCountry = {};
  for (const r of residences) {
    const c = (r.country || 'Unbekannt').trim();
    byCountry[c] = (byCountry[c] || 0) + 1;
  }

  // Pedigree collapse: persons who appear as ancestor of >1 descendant via different paths
  // Simplified: count how many distinct couples share children with cross-overlap.
  const pedigreeCollapse = []; // skip heavy compute, placeholder empty

  res.json({
    total_persons: total,
    living,
    deceased,
    persons_without_birth_date: { count: noBirthDate.length, ids: noBirthDate.slice(0, 50) },
    persons_without_death_date_if_deceased: { count: 0, ids: [] }, // noDeathDate is weak, skip
    persons_without_parents: { count: noParents.length, ids: noParents.slice(0, 50) },
    persons_without_children: { count: noChildren.length, ids: noChildren.slice(0, 50) },
    persons_without_portrait: { count: noPortrait.length, ids: noPortrait.slice(0, 50) },
    couples_without_children: couplesWithoutChildren,
    events_by_decade: eventsByDecade,
    generations_depth: maxDepth,
    name_frequency: { given: top(givenFreq, 10), surname: top(surnameFreq, 10) },
    pedigree_collapse_indicators: pedigreeCollapse,
    by_country: byCountry,
  });
});

/* undo / redo ----------------------------------------------------------- */

const ACTION_LOG_MAX_PER_SESSION = 100;
const ACTION_LOG_MAX_AGE_DAYS = 7;

function cleanupActionLog() {
  const cutoff = new Date(Date.now() - ACTION_LOG_MAX_AGE_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM action_log WHERE ts < ?').run(cutoff);
}
try { cleanupActionLog(); } catch {}

export function logAction(sessionToken, action, label) {
  if (!sessionToken) return;
  try {
    db.prepare('INSERT INTO action_log (session_token, ts, action, label, undone) VALUES (?,?,?,?,0)')
      .run(sessionToken, nowIso(), JSON.stringify(action), label || null);
    // Trim per session
    const rows = db.prepare('SELECT id FROM action_log WHERE session_token=? ORDER BY id DESC LIMIT 500').all(sessionToken);
    if (rows.length > ACTION_LOG_MAX_PER_SESSION) {
      const toDelete = rows.slice(ACTION_LOG_MAX_PER_SESSION).map(r => r.id);
      const chunk = toDelete.slice(0, 100);
      for (const id of chunk) db.prepare('DELETE FROM action_log WHERE id=?').run(id);
    }
  } catch (e) { /* best-effort */ }
}

app.get('/api/undo/stack', requireViewer, (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.json({ actions: [] });
  const rows = db.prepare('SELECT id, ts, label, action, undone FROM action_log WHERE session_token=? ORDER BY id DESC LIMIT 20').all(token);
  res.json({ actions: rows.map(r => ({ id: r.id, ts: r.ts, label: r.label, undone: !!r.undone, type: safeJsonParse(r.action)?.type })) });
});

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function restoreRow(table, id, before) {
  if (!before) return 0;
  const cols = Object.keys(before);
  const set = cols.map(c => `${c}=@${c}`).join(', ');
  // UPSERT
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
  if (existing) {
    db.prepare(`UPDATE ${table} SET ${set} WHERE id=@id`).run({ ...before, id });
  } else {
    const colList = cols.join(', ');
    const placeholders = cols.map(c => `@${c}`).join(', ');
    db.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`).run(before);
  }
  return 1;
}

function applyUndo(action) {
  const a = typeof action === 'string' ? safeJsonParse(action) : action;
  if (!a || !a.type) return { ok: false, reason: 'invalid action' };
  // type formats: 'persons.create|update|delete', 'edges.create|...', ...
  const [table, op] = String(a.type).split('.');
  if (!table || !op) return { ok: false, reason: 'bad type' };
  try {
    if (op === 'create') {
      // undo create = delete
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(a.target_id);
    } else if (op === 'update') {
      restoreRow(table, a.target_id, a.before);
    } else if (op === 'delete') {
      restoreRow(table, a.target_id, a.before);
    } else return { ok: false, reason: 'unknown op' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function applyRedo(action) {
  const a = typeof action === 'string' ? safeJsonParse(action) : action;
  if (!a || !a.type) return { ok: false, reason: 'invalid action' };
  const [table, op] = String(a.type).split('.');
  try {
    if (op === 'create') restoreRow(table, a.target_id, a.after);
    else if (op === 'update') restoreRow(table, a.target_id, a.after);
    else if (op === 'delete') db.prepare(`DELETE FROM ${table} WHERE id=?`).run(a.target_id);
    else return { ok: false, reason: 'unknown op' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

app.post('/api/undo', requireEditor, (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'no session' });
  const row = db.prepare('SELECT id, action FROM action_log WHERE session_token=? AND undone=0 ORDER BY id DESC LIMIT 1').get(token);
  if (!row) return res.status(404).json({ error: 'nothing to undo' });
  const r = applyUndo(row.action);
  if (!r.ok) return res.status(500).json({ error: r.reason });
  db.prepare('UPDATE action_log SET undone=1 WHERE id=?').run(row.id);
  logAudit(req.auth.role, 'undo', String(row.id));
  res.json({ ok: true, id: row.id });
});

app.post('/api/redo', requireEditor, (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'no session' });
  const row = db.prepare('SELECT id, action FROM action_log WHERE session_token=? AND undone=1 ORDER BY id DESC LIMIT 1').get(token);
  if (!row) return res.status(404).json({ error: 'nothing to redo' });
  const r = applyRedo(row.action);
  if (!r.ok) return res.status(500).json({ error: r.reason });
  db.prepare('UPDATE action_log SET undone=0 WHERE id=?').run(row.id);
  logAudit(req.auth.role, 'redo', String(row.id));
  res.json({ ok: true, id: row.id });
});

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
