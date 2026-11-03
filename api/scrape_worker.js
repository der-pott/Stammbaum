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
  try {
    person.residences = db.prepare('SELECT place, city, region, country FROM residences WHERE person_id=?').all(job.person_id);
  } catch { person.residences = []; }
  // Related cities (neighbors' places) for query expansion when person has no residences.
  try {
    const neighborIds = db.prepare(`
      SELECT DISTINCT CASE WHEN from_id=? THEN to_id ELSE from_id END AS pid
      FROM edges WHERE (from_id=? OR to_id=?) AND type IN ('parent','spouse')
    `).all(job.person_id, job.person_id, job.person_id).map(r => r.pid);
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
    person.dismissed_urls = db.prepare(`SELECT url FROM research_hits
      WHERE person_id=? AND status='dismissed' AND url IS NOT NULL`).all(job.person_id).map(r => r.url);
  } catch { person.dismissed_urls = []; }
  try {
    const vrows = db.prepare(`SELECT source, url, title, snippet, payload FROM research_hits
      WHERE person_id=? AND status IN ('accepted','applied','imported') ORDER BY created_at DESC LIMIT 20`).all(job.person_id);
    person.verified_facts = vrows.map(r => {
      let p = null; try { p = JSON.parse(r.payload || 'null'); } catch { /* ignore */ }
      return { source: r.source, url: r.url, title: r.title, snippet: r.snippet,
        markdown: p?.markdown ? p.markdown.slice(0, 10000) : null };
    });
  } catch { person.verified_facts = []; }
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
      status=CASE
        WHEN research_hits.status IN ('accepted','dismissed','applied','imported') THEN research_hits.status
        WHEN research_hits.payload != excluded.payload THEN 'pending'
        ELSE research_hits.status
      END
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
