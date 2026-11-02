import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const DB_PATH = process.env.DB_PATH || '/data/stammbaum.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('wal_checkpoint(TRUNCATE)');

db.exec(`
  CREATE TABLE IF NOT EXISTS persons (
    id          TEXT PRIMARY KEY,
    given_name  TEXT,
    surname     TEXT,
    birth_name  TEXT,
    nicknames   TEXT,
    gender      TEXT,
    birth_date  TEXT,
    birth_place TEXT,
    death_date  TEXT,
    death_place TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS edges (
    id         TEXT PRIMARY KEY,
    from_id    TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    to_id      TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    type       TEXT NOT NULL CHECK (type IN ('parent','spouse')),
    since      TEXT,
    until      TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id, type);
  CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id, type);

  CREATE TABLE IF NOT EXISTS ai_runs (
    id          TEXT PRIMARY KEY,
    person_id   TEXT REFERENCES persons(id) ON DELETE CASCADE,
    prompt      TEXT NOT NULL,
    model       TEXT,
    response    TEXT,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    caption    TEXT,
    taken_at   TEXT,
    created_at TEXT NOT NULL
  );

  -- Join: ein Bild (z. B. Heiratsurkunde) kann mehreren Personen gehören.
  CREATE TABLE IF NOT EXISTS person_images (
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    image_id   TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    role       TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (person_id, image_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pi_image ON person_images(image_id);

  CREATE TABLE IF NOT EXISTS pins (
    role TEXT PRIMARY KEY,
    hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    role       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL,
    role   TEXT,
    action TEXT NOT NULL,
    detail TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    title      TEXT, employer TEXT,
    start_date TEXT, end_date TEXT,
    place      TEXT, notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_person ON jobs(person_id);

  CREATE TABLE IF NOT EXISTS residences (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    place      TEXT NOT NULL,
    start_date TEXT, end_date TEXT,
    kind       TEXT, notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_res_person ON residences(person_id);

  CREATE TABLE IF NOT EXISTS health_events (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    condition  TEXT NOT NULL,
    date       TEXT,
    hereditary INTEGER DEFAULT 0,
    notes      TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_health_person ON health_events(person_id);

  CREATE TABLE IF NOT EXISTS military_service (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    branch     TEXT, rank TEXT, unit TEXT,
    start_date TEXT, end_date TEXT,
    campaigns  TEXT, notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mil_person ON military_service(person_id);

  CREATE TABLE IF NOT EXISTS anecdotes (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    title      TEXT, text TEXT NOT NULL, source TEXT, year TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_anec_person ON anecdotes(person_id);

  CREATE TABLE IF NOT EXISTS education (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    institution TEXT,
    field       TEXT,
    degree      TEXT,
    place       TEXT,
    start_date  TEXT, end_date TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edu_person ON education(person_id);

  CREATE TABLE IF NOT EXISTS biographies (
    person_id    TEXT PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
    narrative    TEXT NOT NULL,
    model        TEXT,
    generated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS research_hits (
    id         TEXT PRIMARY KEY,
    person_id  TEXT REFERENCES persons(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    url        TEXT, title TEXT, snippet TEXT,
    confidence REAL,
    payload    TEXT,
    status     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hits_person ON research_hits(person_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hits_dedup ON research_hits(person_id, source, url);

  CREATE TABLE IF NOT EXISTS research_jobs (
    id              TEXT PRIMARY KEY,
    person_id       TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
    sources         TEXT NOT NULL,
    source_statuses TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON research_jobs(status, created_at);

  CREATE TABLE IF NOT EXISTS research_cache (
    source     TEXT NOT NULL,
    person_id  TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    payload    TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (source, person_id)
  );

  CREATE TABLE IF NOT EXISTS scrape_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    source      TEXT NOT NULL,
    url         TEXT,
    status      INTEGER,
    duration_ms INTEGER,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_reviews (
    id           TEXT PRIMARY KEY,
    person_id    TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    suggestions  TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending','partially_applied','done','dismissed')),
    model        TEXT,
    context_hash TEXT,
    created_at   TEXT NOT NULL,
    applied_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_person ON ai_reviews(person_id, created_at);
  -- idx_reviews_ctxhash wird nach der context_hash-Migration unten angelegt.

  -- Pro-Vorschlag-State: tracked welche suggestions aus welchem review schon
  -- angewandt oder als duplicate geskippt wurden. Dedup zwischen Reviews.
  CREATE TABLE IF NOT EXISTS ai_review_items (
    review_id          TEXT NOT NULL REFERENCES ai_reviews(id) ON DELETE CASCADE,
    category           TEXT NOT NULL,
    idx                INTEGER NOT NULL,
    suggestion_hash    TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('applied','skipped_duplicate','dismissed','failed')),
    resolved_entity_id TEXT,
    summary            TEXT,
    applied_at         TEXT NOT NULL,
    PRIMARY KEY (review_id, category, idx)
  );
  CREATE INDEX IF NOT EXISTS idx_review_items_hash ON ai_review_items(suggestion_hash);
  CREATE INDEX IF NOT EXISTS idx_review_items_review ON ai_review_items(review_id);
`);

// ai_reviews: context_hash + 'context_unchanged' status (idempotent migration).
const reviewCols = new Set(db.prepare('PRAGMA table_info(ai_reviews)').all().map(c => c.name));
if (!reviewCols.has('context_hash')) {
  db.exec('ALTER TABLE ai_reviews ADD COLUMN context_hash TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_ctxhash ON ai_reviews(person_id, context_hash)');
}

// Idempotente Migration: Spalte in bestehender Tabelle anlegen falls fehlt.
// SQLite kennt kein ADD COLUMN IF NOT EXISTS; wir prüfen via PRAGMA.
const existingCols = new Set(db.prepare('PRAGMA table_info(persons)').all().map(c => c.name));
if (!existingCols.has('nicknames')) {
  db.exec('ALTER TABLE persons ADD COLUMN nicknames TEXT');
}

// edges.status — marriage lifecycle. Default null (treated as 'married' for backward compat).
// Valid values: 'married', 'divorced', 'widowed', 'engaged', 'partner'.
const edgeCols = new Set(db.prepare('PRAGMA table_info(edges)').all().map(c => c.name));
if (!edgeCols.has('status')) {
  db.exec("ALTER TABLE edges ADD COLUMN status TEXT");
}

// residences — strukturierte Adress-Felder. `place` bleibt als Legacy-Freitext.
const resCols = new Set(db.prepare('PRAGMA table_info(residences)').all().map(c => c.name));
const resMigrations = [
  ['street',                  'TEXT'],
  ['city',                    'TEXT'],
  ['district',                'TEXT'],
  ['postal_code',             'TEXT'],
  ['postal_code_historical',  'TEXT'],
  ['region',                  'TEXT'],
  ['country',                 "TEXT DEFAULT 'Deutschland'"],
];
for (const [col, type] of resMigrations) {
  if (!resCols.has(col)) {
    db.exec(`ALTER TABLE residences ADD COLUMN ${col} ${type}`);
  }
}

// --- Date-Precision-Flags (additiv, bestehende Werte unangetastet) ----
// EXACT | MONTH | YEAR | APPROXIMATE | RANGE | UNKNOWN. Default EXACT.
const DATE_PRECISION_TABLES = [
  ['persons',          ['birth_date', 'death_date']],
  ['residences',       ['start_date', 'end_date']],
  ['jobs',             ['start_date', 'end_date']],
  ['education',        ['start_date', 'end_date']],
  ['military_service', ['start_date', 'end_date']],
  ['health_events',    ['date']],
];
for (const [table, fields] of DATE_PRECISION_TABLES) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const f of fields) {
    const col = `${f}_precision`;
    if (!cols.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT DEFAULT 'EXACT'`);
    }
  }
}

// --- Soft-Delete-Spalten auf allen User-Daten-Tabellen ---------------
const SOFT_DELETE_TABLES = [
  'persons', 'edges', 'residences', 'jobs', 'education',
  'military_service', 'health_events', 'anecdotes', 'images', 'person_images',
];
for (const table of SOFT_DELETE_TABLES) {
  const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!cols.has('deleted_at')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_live ON ${table}(deleted_at)`);
  }
  if (!cols.has('deleted_by')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_by TEXT`);
  }
}

// --- Plausibility-Dismissals: User markiert Issue als "ist OK" ---------
db.exec(`
  CREATE TABLE IF NOT EXISTS plausibility_dismissals (
    issue_key   TEXT PRIMARY KEY,
    note        TEXT,
    dismissed_at TEXT NOT NULL,
    dismissed_by TEXT
  );

  -- Life Events: Lebensereignisse die nicht in jobs/residences/military passen
  -- (Konfirmation, Taufe, Auswanderung, Preisverleihung, Ehrenamt, ...)
  CREATE TABLE IF NOT EXISTS life_events (
    id              TEXT PRIMARY KEY,
    person_id       TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    category        TEXT NOT NULL,
    title           TEXT NOT NULL,
    date            TEXT,
    date_precision  TEXT DEFAULT 'EXACT',
    place           TEXT,
    description     TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL,
    deleted_at      TEXT,
    deleted_by      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_le_person ON life_events(person_id);
  CREATE INDEX IF NOT EXISTS idx_le_date ON life_events(date);
  CREATE INDEX IF NOT EXISTS idx_life_events_live ON life_events(deleted_at);

  -- Undo/Redo: Action-Log fuer letzte Mutationen pro Session
  CREATE TABLE IF NOT EXISTS action_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token  TEXT NOT NULL,
    ts             TEXT NOT NULL,
    action         TEXT NOT NULL,
    label          TEXT,
    undone         INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log(session_token, id);
`);

export function nowIso() { return new Date().toISOString(); }
export function newId()  { return randomUUID(); }

/* ---------------------------------------------------------------- PIN hashing */

// scrypt with a per-PIN random salt.  Format: scrypt$<saltHex>$<hashHex>
export function hashPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function setPin(role, pin) {
  db.prepare('INSERT INTO pins (role, hash) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET hash = excluded.hash')
    .run(role, hashPin(pin));
}

export function getPinHash(role) {
  const row = db.prepare('SELECT hash FROM pins WHERE role = ?').get(role);
  return row?.hash || null;
}

/* ------------------------------------------------------------------- sessions */

const SESSION_DAYS = 30;

export function createSession(role) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (token, role, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, role, now.toISOString(), expires.toISOString());
  return { token, expires };
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT role, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { role: row.role };
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteSessionsForRole(role) {
  db.prepare('DELETE FROM sessions WHERE role = ?').run(role);
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

/* ---------------------------------------------------------------------- audit */

export function logAudit(role, action, detail) {
  db.prepare('INSERT INTO audit (ts, role, action, detail) VALUES (?,?,?,?)')
    .run(nowIso(), role || null, action, detail ? String(detail).slice(0, 500) : null);
}

/* ------------------------------------------------------ initial PIN seeding */

// On first start, seed PINs from env.  Later changes to the env are ignored —
// change a PIN via the API (not implemented yet) or by clearing the row.
export function seedInitialPins() {
  const editor = process.env.SB_INIT_EDITOR_PIN;
  const viewer = process.env.SB_INIT_VIEWER_PIN;
  const existing = db.prepare('SELECT role FROM pins').all().map(r => r.role);
  if (editor && !existing.includes('editor')) {
    setPin('editor', editor);
    logAudit(null, 'pin.seed', 'editor');
  }
  if (viewer && !existing.includes('viewer')) {
    setPin('viewer', viewer);
    logAudit(null, 'pin.seed', 'viewer');
  }
}
