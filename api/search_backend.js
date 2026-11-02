// Pluggable web-search backend. Dispatches to Brave Search, Serper or
// Google CSE depending on which env var is configured. If none, callers
// get { error: 'no backend' } so they can render a "Konfiguration fehlt"
// Reason-Card in the UI.
//
// This module is the ONLY place that talks to a search provider — all the
// site:-filtered sources (duckduckgo, linkedin, xing, press) go through
// webSearch() so swapping providers only touches this file.

import { db, nowIso } from './db.js';

const UA = 'Stammbaum/1.0 (private family research; contact: maximilian.pott@outlook.com)';
const DEFAULT_TIMEOUT = 10_000;

// Backend selection ------------------------------------------------------
export function activeBackend() {
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (process.env.SERPER_API_KEY) return 'serper';
  if (process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX) return 'googlecse';
  return null;
}

export function missingBackendInfo() {
  return {
    error: 'no_backend',
    message: 'Keine Websuche konfiguriert. Setze BRAVE_SEARCH_API_KEY ODER GOOGLE_CSE_API_KEY+GOOGLE_CSE_CX in /srv/projects/stammbaum/.env.',
    env_vars: ['BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'GOOGLE_CSE_API_KEY'],
    docs: {
      brave: 'https://brave.com/search/api/ (free Tier mit 2000 Queries/Monat)',
      serper: 'https://serper.dev/ (bezahlt)',
      googlecse: 'https://programmablesearchengine.google.com/ (100/Tag free)',
    },
  };
}

// Rate limit: 1 req/s on Brave free tier
const NEXT_ALLOWED = { brave: 0, serper: 0, googlecse: 0 };
const INTERVAL_MS = { brave: 1100, serper: 500, googlecse: 400 };

async function waitRateLimit(backend) {
  const now = Date.now();
  const earliest = NEXT_ALLOWED[backend] || 0;
  if (earliest > now) await new Promise(r => setTimeout(r, earliest - now));
  NEXT_ALLOWED[backend] = Math.max(Date.now(), earliest) + (INTERVAL_MS[backend] || 500);
}

function logSearch(backend, query, status, duration_ms, error) {
  try {
    db.prepare('INSERT INTO scrape_log (ts, source, url, status, duration_ms, error) VALUES (?,?,?,?,?,?)')
      .run(nowIso(), `search:${backend}`, query, status || null, duration_ms || null, error ? String(error).slice(0, 500) : null);
    db.prepare(`DELETE FROM scrape_log WHERE id NOT IN (SELECT id FROM scrape_log ORDER BY id DESC LIMIT 500)`).run();
  } catch { /* ignore */ }
}

/**
 * webSearch — primary entrypoint.
 * @param {object} opts
 * @param {string} opts.query  — free-text query (NOT yet URL-encoded)
 * @param {string} [opts.siteFilter] — e.g. 'linkedin.com/in'; appended as `site:...`
 * @param {string} [opts.country='DE']
 * @param {string} [opts.freshness] — 'py'|'pm'|'pw'|'pd' (Brave)
 * @param {number} [opts.limit=10]
 * @returns {Promise<{ok:boolean, hits?:Array<{title,url,snippet}>, error?:string, backend?:string}>}
 */
export async function webSearch(opts) {
  const backend = activeBackend();
  if (!backend) return { ok: false, error: 'no_backend', hits: [] };

  const q = opts.siteFilter ? `${opts.query} site:${opts.siteFilter}` : opts.query;
  const limit = Math.min(opts.limit || 10, 20);

  await waitRateLimit(backend);
  const start = Date.now();
  try {
    if (backend === 'brave') {
      const hits = await braveSearch(q, { country: opts.country || 'DE', freshness: opts.freshness, limit });
      logSearch(backend, q, 200, Date.now() - start, null);
      return { ok: true, backend, hits };
    }
    if (backend === 'serper') {
      const hits = await serperSearch(q, { gl: (opts.country || 'DE').toLowerCase(), limit });
      logSearch(backend, q, 200, Date.now() - start, null);
      return { ok: true, backend, hits };
    }
    if (backend === 'googlecse') {
      const hits = await googleCseSearch(q, { gl: (opts.country || 'DE').toLowerCase(), limit });
      logSearch(backend, q, 200, Date.now() - start, null);
      return { ok: true, backend, hits };
    }
  } catch (err) {
    logSearch(backend, q, 0, Date.now() - start, err.message);
    return { ok: false, backend, error: err.message, hits: [] };
  }
  return { ok: false, error: 'no_backend_matched', hits: [] };
}

// Brave Search API -------------------------------------------------------
async function braveSearch(q, { country, freshness, limit }) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  const params = new URLSearchParams({ q, country: country || 'DE', count: String(limit) });
  if (freshness) params.set('freshness', freshness);
  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'X-Subscription-Token': key,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'User-Agent': UA,
      },
    });
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
    const data = await res.json();
    const results = data?.web?.results || [];
    return results.map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || r.extra_snippets?.[0] || '',
    }));
  } finally {
    clearTimeout(t);
  }
}

// Serper.dev (Google proxy) ---------------------------------------------
async function serperSearch(q, { gl, limit }) {
  const key = process.env.SERPER_API_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ q, gl: gl || 'de', hl: 'de', num: limit }),
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
    const data = await res.json();
    const results = data?.organic || [];
    return results.map(r => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || '',
    }));
  } finally {
    clearTimeout(t);
  }
}

// Google Custom Search Engine --------------------------------------------
async function googleCseSearch(q, { gl, limit }) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  const params = new URLSearchParams({ key, cx, q, num: String(Math.min(limit, 10)) });
  if (gl) params.set('gl', gl);
  const url = `https://www.googleapis.com/customsearch/v1?${params}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google CSE HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const results = data?.items || [];
    return results.map(r => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || '',
    }));
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build a standard "no backend configured" Reason-Card hit.
 * Sources use this when webSearch returns no_backend.
 */
export function noBackendHit(sourceKey, label) {
  return {
    source: sourceKey,
    title: label || 'Konfiguration fehlt',
    url: 'https://brave.com/search/api/',
    snippet: 'Websuche-Backend nicht konfiguriert. Lege BRAVE_SEARCH_API_KEY in /srv/projects/stammbaum/.env an (2000 Queries/Monat frei) und `docker compose restart api`.',
    confidence: 0,
    payload: { needs_config: true, env_var: 'BRAVE_SEARCH_API_KEY', docs_url: 'https://brave.com/search/api/' },
  };
}
