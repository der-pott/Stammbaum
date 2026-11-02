// DuckDuckGo HTML search — general web results.
// Uses the lite HTML endpoint which does not require JS. No API key.
import * as cheerio from 'cheerio';
import { httpGet, nameParts, yearOf } from '../http.js';

export const META = { label: 'Web (DuckDuckGo)', url: 'https://duckduckgo.com' };

// Internal: run a DDG query and return normalized hits. Shared across other
// site:-filtered sources (linkedin, xing, press).
export async function ddgSearch(sourceKey, queryString, { maxResults = 8 } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryString)}`;
  const r = await httpGet(sourceKey, url, { accept: 'text', timeout: 12_000 });
  if (!r.ok) return { ok: false, hits: [], error: r.error, url };
  const body = r.body || '';
  if (!body || body.length < 200) return { ok: false, hits: [], error: 'empty body', url };
  try {
    const $ = cheerio.load(body);
    const hits = [];
    $('.result').slice(0, maxResults).each((_, el) => {
      const $el = $(el);
      const title = $el.find('.result__title').text().trim().replace(/\s+/g, ' ');
      const rawHref = $el.find('.result__a').attr('href') || '';
      const snippet = $el.find('.result__snippet').text().trim().replace(/\s+/g, ' ');
      if (!title || !rawHref) return;
      // DDG wraps hrefs in a redirect — strip it.
      const href = unwrapDdgRedirect(rawHref);
      hits.push({ title, url: href, snippet });
    });
    return { ok: true, hits, url };
  } catch (err) {
    return { ok: false, hits: [], error: err.message, url };
  }
}

function unwrapDdgRedirect(href) {
  if (!href) return href;
  // DDG uses //duckduckgo.com/l/?uddg=<encoded> or similar.
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* fall through */ }
  }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const birthYear = yearOf(person.birth_date);
  const q = birthYear ? `"${full}" ${birthYear}` : `"${full}"`;
  const result = await ddgSearch('duckduckgo', q);
  if (!result.ok) {
    return [{ source: 'duckduckgo', title: 'DuckDuckGo', url: result.url, snippet: `Zugriff nicht möglich (${result.error})`, confidence: 0, payload: { error: result.error } }];
  }
  if (!result.hits.length) {
    return [{ source: 'duckduckgo', title: 'DuckDuckGo', url: result.url, snippet: 'Keine Web-Treffer.', confidence: 0, payload: { empty: true } }];
  }
  const birthPlace = (person.birth_place || '').toLowerCase();
  return result.hits.map(h => {
    let confidence = 0.3;
    const text = (h.snippet || '').toLowerCase();
    if (birthYear && text.includes(String(birthYear))) confidence += 0.2;
    if (birthPlace && birthPlace.length > 2 && text.includes(birthPlace)) confidence += 0.2;
    return {
      source: 'duckduckgo',
      title: h.title.slice(0, 140),
      url: h.url,
      snippet: h.snippet.slice(0, 240),
      confidence,
      payload: { href: h.url },
    };
  });
}
