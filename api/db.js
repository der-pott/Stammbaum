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
