// Matricula — public katholische Kirchenbuch-Suche. HTML scrape.
// robots.txt: open to crawl.
import * as cheerio from 'cheerio';
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Matricula (kath. Kirchenbücher)', url: 'https://data.matricula-online.eu' };

export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!surname) return [];
  const q = full || surname;
  const url = `https://data.matricula-online.eu/de/suchen/?q=${encodeURIComponent(q)}`;
  const r = await httpGet('matricula', url, { accept: 'text' });
  if (!r.ok) return [{ source: 'matricula', title: 'Matricula', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    // Result cards vary; try multiple selectors.
    $('.search-result, article, .result, li.item, .list-group-item').slice(0, 8).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h2, h3, h4, .title, a').first().text() || '').trim();
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      if (!title || title.length < 3) return;
      const abs = link.startsWith('http') ? link : (link ? 'https://data.matricula-online.eu' + link : url);
      let confidence = 0.3;
      if (person.birth_place && snippet.toLowerCase().includes(person.birth_place.toLowerCase().split(/[ ,]/)[0])) confidence += 0.2;
      results.push({ source: 'matricula', title: title.slice(0, 120), url: abs, snippet, confidence, payload: { kirchenbuch: true } });
    });
    if (!results.length) {
      return [{ source: 'matricula', title: 'Matricula', url, snippet: 'Keine öffentlichen Treffer gefunden.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'matricula', title: 'Matricula', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
