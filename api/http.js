// HTTP helper for scrapers: hardcoded UA, per-domain rate limiting, logging.

import { db, nowIso } from './db.js';

const UA = 'Stammbaum/1.0 (private family research; contact: maximilian.pott@outlook.com)';
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

export async function httpGet(source, url, { timeout = DEFAULT_TIMEOUT, headers = {}, accept = 'json' } = {}) {
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
        'user-agent': UA,
        'accept-language': 'de,en;q=0.8',
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
  const birthName = (person.birth_name || '').trim();
  const firstGiven = given.split(/\s+/)[0] || '';
  const full = [given, surname].filter(Boolean).join(' ').trim();
  return {
    given,
    firstGiven,
    surname,
    birthName,
    full,
    variants: buildNameVariants({ given, surname, birthName, firstGiven }),
  };
}

// Baut sinnvolle Suchnamen-Kombinationen.
// Deckt ab:
//  - Mehrere Vornamen: "Erich Herbert Günther" → "Erich Pott", "Herbert Pott", "Günther Pott", "Erich Herbert Günther Pott"
//  - Doppelnamen mit Bindestrich: "Hans-Peter" → "Hans-Peter", "Hans Peter", "Hans", "Peter"
//  - Geburtsname (meist bei Frauen): zusätzlich alle Vornamen-Kombinationen mit birth_name als Nachname
// Return: array of {name, kind, primary} — primary ist Haupt-Variante, der Rest Zusatz-Baselines.
export function buildNameVariants({ given, surname, birthName, firstGiven }) {
  if (!given || !surname) return [];
  const out = [];
  const seen = new Set();
  const push = (name, kind, primary = false) => {
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n) return;
    const k = n.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ name: n, kind, primary });
  };

  // Haupt-Variante: alle Vornamen + aktueller Nachname
  push(`${given} ${surname}`, 'full', true);

  // Vornamen-Pool: jeder einzeln + Bindestrich-Splits
  const givenTokens = given.split(/\s+/).filter(Boolean);
  const singleFirsts = new Set();
  for (const tok of givenTokens) {
    singleFirsts.add(tok);
    // Bindestrich-Namen zusätzlich auftrennen: "Hans-Peter" → auch "Hans Peter" und "Hans", "Peter"
    if (/[-]/.test(tok)) {
      const parts = tok.split('-').map(p => p.trim()).filter(Boolean);
      // Komplett ohne Bindestrich
      push(`${parts.join(' ')} ${surname}`, 'hyphen_space');
      for (const p of parts) singleFirsts.add(p);
    }
  }

  // Jeder einzelne Vorname + Nachname (nur wenn Mehrfach-Vornamen)
  if (givenTokens.length > 1 || Array.from(singleFirsts).some(n => n !== firstGiven)) {
    for (const first of singleFirsts) {
      push(`${first} ${surname}`, 'single_given');
    }
  }

  // Geburtsname-Varianten
  if (birthName && birthName.toLowerCase() !== surname.toLowerCase()) {
    push(`${given} ${birthName}`, 'birthname_full');
    push(`${firstGiven} ${birthName}`, 'birthname_first');
    for (const first of singleFirsts) {
      push(`${first} ${birthName}`, 'birthname_single');
    }
    // "geb."-Konvention (bei Trauer- und Standesamt-Dokumenten üblich)
    push(`${firstGiven} ${surname} geb ${birthName}`, 'birthname_geb');
  }

  return out;
}

export function yearOf(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : null;
}
