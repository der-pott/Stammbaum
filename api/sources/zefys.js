// ZEFYS — Zeitungsinformationssystem der Staatsbibliothek Berlin. HTML scrape.
// robots.txt: open. Nutzt fetchPage (Firecrawl-fallback-ready).
import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';

export const META = { label: 'ZEFYS Zeitungsarchiv', url: 'https://zefys.staatsbibliothek-berlin.de' };
const LABEL = 'ZEFYS Zeitungsarchiv';

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://zefys.staatsbibliothek-berlin.de/suche?tx_dlf%5Bquery%5D=${encodeURIComponent(full)}`;
  const r = await fetchPage('zefys', url, { timeout: 10_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) return [needsFirecrawlCard('zefys', LABEL, url, `HTTP ${r.status}`)];
    return [{ source: 'zefys', title: LABEL, url, snippet: `Zugriff nicht moeglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const html = r.html || r.text || '';
  try {
    const $ = cheerio.load(html);
    const birth = yearOf(person.birth_date);
    const death = yearOf(person.death_date);
    const results = [];
    $('.result-item, .tx-dlf-search-result, .search-hit, .result').slice(0, 8).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('a, h3, h4, .title').first().text() || '').trim().replace(/\s+/g, ' ');
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!title || title.length < 3) return;
      const abs = link.startsWith('http') ? link : (link ? 'https://zefys.staatsbibliothek-berlin.de' + link : url);
      let confidence = 0.25;
      const yrs = snippet.match(/\b(1[7-9]\d{2}|20\d{2})\b/g) || [];
      if (yrs.some(y => (birth && Math.abs(+y - birth) <= 5) || (death && Math.abs(+y - death) <= 5))) {
        confidence = Math.min(1, confidence + 0.2);
      }
      results.push({ source: 'zefys', title: title.slice(0, 120), url: abs, snippet, confidence, payload: { newspaper_mention: true } });
    });
    if (!results.length) {
      return [{ source: 'zefys', title: LABEL, url, snippet: 'Keine Zeitungsnennungen gefunden.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'zefys', title: LABEL, url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
