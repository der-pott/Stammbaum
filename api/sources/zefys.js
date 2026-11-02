// ZEFYS — Zeitungsinformationssystem der Staatsbibliothek Berlin. HTML scrape.
// robots.txt: open.
import * as cheerio from 'cheerio';
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'ZEFYS Zeitungsarchiv', url: 'https://zefys.staatsbibliothek-berlin.de' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://zefys.staatsbibliothek-berlin.de/suche?tx_dlf%5Bquery%5D=${encodeURIComponent(full)}`;
  const r = await httpGet('zefys', url, { accept: 'text' });
  if (!r.ok) return [{ source: 'zefys', title: 'ZEFYS', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    $('.result-item, .tx-dlf-search-result, .search-hit, .result').slice(0, 8).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('a, h3, h4, .title').first().text() || '').trim().replace(/\s+/g, ' ');
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!title || title.length < 3) return;
      const abs = link.startsWith('http') ? link : (link ? 'https://zefys.staatsbibliothek-berlin.de' + link : url);
      results.push({ source: 'zefys', title: title.slice(0, 120), url: abs, snippet, confidence: 0.25, payload: { newspaper_mention: true } });
    });
    if (!results.length) {
      return [{ source: 'zefys', title: 'ZEFYS', url, snippet: 'Keine Zeitungsnennungen gefunden.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'zefys', title: 'ZEFYS', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
