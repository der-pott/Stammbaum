// HTTP helper for scrapers: hardcoded UA, per-domain rate limiting, logging.

import { db, nowIso } from './db.js';

const UA_BOT = 'Stammbaum-Pott/1.0 (private family research; contact: maximilian.pott@outlook.com)';
// Browser-mimicking UA for sites that 403 obvious bots (familysearch, arcinsys, viaf, ddb).
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DOMAIN_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT = 15_000;

const nextAllowedAt = new Map();

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

async function waitForDomain(host) {
  if (!host) return;
  const now = Date.now();
  const earliest = nextAllowedAt.get(host) || 0;
  if (earliest > now) {
    await new Promise(r => setTimeout(r, earliest - now));
  }
  nextAllowedAt.set(host, Math.max(Date.now(), earliest) + DOMAIN_INTERVAL_MS);
}

function logScrape(source, url, status, duration_ms, error) {
  try {
    db.prepare('INSERT INTO scrape_log (ts, source, url, status, duration_ms, error) VALUES (?,?,?,?,?,?)')
      .run(nowIso(), source, url || null, status || null, duration_ms || null, error ? String(error).slice(0, 500) : null);
    // Keep last 500
    db.prepare(`DELETE FROM scrape_log WHERE id NOT IN (SELECT id FROM scrape_log ORDER BY id DESC LIMIT 500)`).run();
  } catch { /* ignore */ }
}

export async function httpGet(source, url, { timeout = DEFAULT_TIMEOUT, headers = {}, accept = 'json', browser = false } = {}) {
  const host = hostOf(url);
  await waitForDomain(host);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': browser ? UA_BROWSER : UA_BOT,
        'accept-language': 'de,en;q=0.8',
        ...(browser ? {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
        } : {}),
        ...headers,
      },
    });
    const duration = Date.now() - start;
    if (!res.ok) {
      logScrape(source, url, res.status, duration, 'HTTP ' + res.status);
      return { ok: false, status: res.status, error: 'HTTP ' + res.status };
    }
    const body = accept === 'json' ? await res.json()
      : accept === 'text' ? await res.text()
      : accept === 'buffer' ? Buffer.from(await res.arrayBuffer())
      : await res.text();
    logScrape(source, url, res.status, duration, null);
    return { ok: true, status: res.status, body };
  } catch (err) {
    const duration = Date.now() - start;
    const msg = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network error');
    logScrape(source, url, 0, duration, msg);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(t);
  }
}

export function nameParts(person) {
  const given = (person.given_name || '').trim();
  const surname = (person.surname || '').trim();
  const firstGiven = given.split(/\s+/)[0] || '';
  const full = [given, surname].filter(Boolean).join(' ').trim();
  return { given, firstGiven, surname, full };
}

export function yearOf(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : null;
}
