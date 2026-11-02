// Background worker — drains research_jobs queue.
// One in-process setInterval, 2s cadence. Suitable for private-archive volume.

import { db, newId, nowIso } from './db.js';
import { dispatchResearch, SOURCES } from './research_dispatch.js';

const POLL_INTERVAL_MS = 2000;
let running = false;

export function startWorker() {
  if (running) return;
  running = true;
  setInterval(drainOne, POLL_INTERVAL_MS).unref?.();
  console.log('[scrape-worker] started');
}

function drainOne() {
  const job = db.prepare(`SELECT * FROM research_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1`).get();
  if (!job) return;
  processJob(job).catch(err => console.error('[scrape-worker] job failed:', err));
}

async function processJob(job) {
  const person = db.prepare('SELECT * FROM persons WHERE id=?').get(job.person_id);
  if (!person) {
    db.prepare(`UPDATE research_jobs SET status='failed', completed_at=? WHERE id=?`).run(nowIso(), job.id);
    return;
  }
  // Attach contextual data that some sources (LinkedIn, Xing) use to boost
  // confidence (employer / institution matches in snippets).
  try {
    person.jobs = db.prepare('SELECT title, employer, place FROM jobs WHERE person_id=?').all(job.person_id);
  } catch { person.jobs = []; }
  try {
    person.education = db.prepare('SELECT institution, field, place FROM education WHERE person_id=?').all(job.person_id);
  } catch { person.education = []; }
  const sourceKeys = JSON.parse(job.sources || '[]');
  const statuses = {};
  for (const k of sourceKeys) statuses[k] = { state: 'queued', count: 0 };
  db.prepare(`UPDATE research_jobs SET status='running', started_at=?, source_statuses=? WHERE id=?`)
    .run(nowIso(), JSON.stringify(statuses), job.id);

  const insertHit = db.prepare(`
    INSERT INTO research_hits (id, person_id, source, url, title, snippet, confidence, payload, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(person_id, source, url) DO UPDATE SET
      title=excluded.title,
      snippet=excluded.snippet,
      confidence=excluded.confidence,
      payload=excluded.payload,
      status=CASE WHEN research_hits.payload != excluded.payload THEN 'pending' ELSE research_hits.status END
  `);

  const onStatus = (key, info) => {
    statuses[key] = { ...info, count: info.count ?? statuses[key]?.count ?? 0 };
    db.prepare('UPDATE research_jobs SET source_statuses=? WHERE id=?')
      .run(JSON.stringify(statuses), job.id);
  };

  try {
    const { hits } = await dispatchResearch(person, { sourceKeys, onStatus, useCache: true });
    const now = nowIso();
    const tx = db.transaction(() => {
      for (const h of hits) {
        insertHit.run(newId(), person.id, h.source, h.url || null, h.title || null, h.snippet || null, h.confidence || 0, JSON.stringify(h.payload || {}), 'pending', now);
      }
    });
    tx();
    db.prepare(`UPDATE research_jobs SET status='done', completed_at=?, source_statuses=? WHERE id=?`)
      .run(nowIso(), JSON.stringify(statuses), job.id);
  } catch (err) {
    console.error('[scrape-worker] dispatch failed:', err);
    db.prepare(`UPDATE research_jobs SET status='failed', completed_at=? WHERE id=?`)
      .run(nowIso(), job.id);
  }
}

export function enqueueJob(personId, sourceKeys) {
  const id = newId();
  const keys = sourceKeys?.length ? sourceKeys : Object.keys(SOURCES);
  db.prepare(`INSERT INTO research_jobs (id, person_id, status, sources, source_statuses, created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, personId, 'queued', JSON.stringify(keys), JSON.stringify({}), nowIso());
  return id;
}

export function getJob(id) {
  const row = db.prepare('SELECT * FROM research_jobs WHERE id=?').get(id);
  if (!row) return null;
  return {
    ...row,
    sources: safeJson(row.sources),
    source_statuses: safeJson(row.source_statuses),
  };
}

function safeJson(s) { try { return JSON.parse(s || 'null'); } catch { return null; } }
