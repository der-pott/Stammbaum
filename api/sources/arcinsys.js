// Arcinsys — Deutsche Landesarchive. HTML scrape.
// robots.txt: /arcinsys/recherche/* allowed.
import * as cheerio from 'cheerio';
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Arcinsys (Landesarchive)', url: 'https://www.arcinsys.hessen.de' };

export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!surname) return [];
  const q = full || surname;
  const url = `https://www.arcinsys.hessen.de/arcinsys/recherche/overview.action?q=${encodeURIComponent(q)}`;
  const r = await httpGet('arcinsys', url, { accept: 'text', browser: true });
  if (!r.ok) return [{ source: 'arcinsys', title: 'Arcinsys', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    $('.hitlist li, .result-list li, tr.hit, a[href*="/arcinsys/"]').slice(0, 10).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('a, .title, h3').first().text() || $el.text() || '').trim().replace(/\s+/g, ' ').slice(0, 140);
      const link = ($el.is('a') ? $el : $el.find('a[href]')).attr('href') || '';
      if (!title || title.length < 5) return;
      const abs = link.startsWith('http') ? link : (link ? 'https://www.arcinsys.hessen.de' + link : url);
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      results.push({ source: 'arcinsys', title, url: abs, snippet, confidence: 0.25, payload: { archival_reference: true } });
    });
    if (!results.length) {
      return [{ source: 'arcinsys', title: 'Arcinsys', url, snippet: 'Keine Archivalien gefunden.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'arcinsys', title: 'Arcinsys', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
