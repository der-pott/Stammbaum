// Scrape-Backend-Abstraktion.
//
// Direct-fetch jetzt, Firecrawl-Self-Hosted spaeter.
// Umschaltbar via Env:
//   FIRECRAWL_URL + FIRECRAWL_API_KEY → nutzt Firecrawl /v1/scrape, parse markdown
//   Sonst: direkter fetch via httpGet (http.js, mit UA + Rate-Limit + Logging)
//
// Alle Scraper rufen fetchPage() auf. Firecrawl-Umstellung = Env setzen + api restart.

import { httpGet } from './http.js';

const FIRECRAWL_TIMEOUT = 15_000;

/**
 * Hol eine Seite. Returnt normalisierte Payload fuer HTML-Scraper.
 *
 * @param {string} source  — scraper key fuer Logs
 * @param {string} url     — Ziel-URL
 * @param {object} opts
 * @param {number} [opts.timeout=10000]
 * @param {'auto'|'raw'} [opts.mode='auto']  — 'raw' umgeht Firecrawl immer
 * @param {string} [opts.accept='text']
 * @returns {Promise<{ok:boolean,status:number,html?:string,text?:string,markdown?:string,title?:string,error?:string}>}
 */
export async function fetchPage(source, url, { timeout = 10_000, mode = 'auto', accept = 'text' } = {}) {
  const firecrawl = process.env.FIRECRAWL_URL;
  if (firecrawl && mode !== 'raw') {
    const key = process.env.FIRECRAWL_API_KEY || '';
    return await scrapeViaFirecrawl(source, url, firecrawl, key, timeout);
  }
  return await scrapeViaFetch(source, url, { timeout, accept });
}

async function scrapeViaFetch(source, url, { timeout, accept }) {
  const r = await httpGet(source, url, { timeout, accept });
  if (!r.ok) return { ok: false, status: r.status || 0, error: r.error };
  const body = r.body || '';
  const html = accept === 'json' ? null : body;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const title = html ? extractTitle(html) : null;
  return { ok: true, status: r.status, html, text, title };
}

async function scrapeViaFirecrawl(source, url, baseUrl, apiKey, timeout) {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/v1/scrape';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout + FIRECRAWL_TIMEOUT);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'html'],
        onlyMainContent: false,
        waitFor: 1000,
      }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `Firecrawl HTTP ${res.status}` };
    }
    const payload = await res.json();
    const data = payload?.data || payload || {};
    const html = data.html || '';
    const markdown = data.markdown || '';
    const title = data.metadata?.title || extractTitle(html);
    return {
      ok: true,
      status: 200,
      html,
      markdown,
      text: markdown || html,
      title,
    };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'firecrawl timeout' : (err?.message || 'firecrawl error');
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(t);
  }
}

function extractTitle(html) {
  if (!html) return null;
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim() : null;
}

/**
 * JSON-API-Call (fuer Scraper die JSON-APIs nutzen, kein HTML).
 * Immer direkt via httpGet — Firecrawl ist fuer HTML-Scrape-Blocker.
 */
export async function fetchJson(source, url, opts = {}) {
  return httpGet(source, url, { ...opts, accept: 'json' });
}

/**
 * Standard needs_firecrawl Card wenn ein Scraper blockiert.
 * Scraper rufen das auf wenn fetchPage.ok === false mit 403/503/CF-Block.
 */
export function needsFirecrawlCard(sourceKey, label, url, reason = '') {
  const firecrawl = process.env.FIRECRAWL_URL;
  const msg = firecrawl
    ? `Zugriff auch mit Firecrawl blockiert${reason ? ' — ' + reason : ''}.`
    : `Zugriff aus dem VPS blockiert${reason ? ' (' + reason + ')' : ''}. Firecrawl-Self-Hosted aktiviert spaeter diesen Scraper automatisch.`;
  return {
    source: sourceKey,
    title: label,
    url,
    snippet: msg,
    confidence: 0,
    payload: { needs_firecrawl: true, reason },
  };
}
