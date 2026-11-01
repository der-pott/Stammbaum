import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
`);

export function nowIso() { return new Date().toISOString(); }
export function newId()  { return randomUUID(); }
