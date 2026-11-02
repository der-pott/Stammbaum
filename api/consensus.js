// Consensus — aggregate the (field, value) pairs found across sources' hit payloads.
// Simple rule: if ≥2 sources agree on a date-like field, count it as consensus.

import { db } from './db.js';

function yearFromAny(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : null;
}

function collectFromPayload(sourceKey, payload) {
  if (!payload || typeof payload !== 'object') return [];
  const out = [];
  const push = (field, value) => {
    if (value == null || value === '') return;
    out.push({ field, value: String(value), source: sourceKey });
  };
  // Common keys across our sources' payloads.
  if (payload.birth) push('birth', payload.birth);
  if (payload.death) push('death', payload.death);
  if (payload.summary) {
    // Extract year patterns from the summary text.
    const years = String(payload.summary).match(/\b(1[0-9]{3}|20[0-2][0-9])\b/g) || [];
    for (const y of years.slice(0, 4)) push('mentioned_year', y);
  }
  if (payload.year_display) push('year', payload.year_display);
  if (payload.place) push('place', payload.place);
  if (payload.place_display) push('place', payload.place_display);
  if (Array.isArray(payload.places)) for (const p of payload.places) push('place', p);
  if (Array.isArray(payload.years)) for (const y of payload.years) push('year', yearFromAny(y));
  if (Array.isArray(payload.dates)) for (const d of payload.dates) push('birth_death_hint', d);
  return out;
}

export function computeConsensus(personId) {
  const rows = db.prepare('SELECT source, payload FROM research_hits WHERE person_id=? AND status != ?').all(personId, 'dismissed');
  const buckets = new Map(); // key = `${field}::${value}` → Set(source)
  for (const r of rows) {
    const pl = (() => { try { return JSON.parse(r.payload || '{}'); } catch { return {}; } })();
    for (const { field, value } of collectFromPayload(r.source, pl)) {
      const key = `${field}::${value}`;
      if (!buckets.has(key)) buckets.set(key, new Set());
      buckets.get(key).add(r.source);
    }
  }
  const consensus = [];
  for (const [key, sources] of buckets) {
    if (sources.size < 2) continue;
    const [field, value] = key.split('::');
    consensus.push({ field, value, source_count: sources.size, sources: [...sources] });
  }
  consensus.sort((a, b) => b.source_count - a.source_count);
  return consensus;
}
