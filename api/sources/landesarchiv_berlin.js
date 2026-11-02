// Landesarchiv Berlin — Findbuch-Suche nach Personen in historischen Berliner Akten.
import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';

export const META = { label: 'Landesarchiv Berlin', url: 'https://content.landesarchiv-berlin.de' };
const LABEL = 'Landesarchiv Berlin';

export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!full) return [];
  const url = `https://content.landesarchiv-berlin.de/suche/formularsuche?suchbegriff=${encodeURIComponent(full)}`;
  const r = await fetchPage('landesarchiv_berlin', url, { timeout: 10_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) {
      return [needsFirecrawlCard('landesarchiv_berlin', LABEL, url, `HTTP ${r.status}`)];
    }
    return [{ source: 'landesarchiv_berlin', title: LABEL, url, snippet: `Zugriff fehlgeschlagen (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const html = r.html || r.text || '';
  if (!html) return [{ source: 'landesarchiv_berlin', title: LABEL, url, snippet: 'Leere Antwort.', confidence: 0, payload: { empty: true } }];
  try {
    const $ = cheerio.load(html);
    const birth = yearOf(person.birth_date);
    const death = yearOf(person.death_date);
    const results = [];
    $('.treffer, .result, .suchergebnis, article, li.hit').slice(0, 10).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h2, h3, h4, .title, a').first().text() || '').trim().replace(/\s+/g, ' ');
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!title || title.length < 5) return;
      if (!snippet.toLowerCase().includes(surname.toLowerCase())) return;
      const abs = link.startsWith('http') ? link : 'https://content.landesarchiv-berlin.de' + link;
      let confidence = 0.4;
      const yrs = snippet.match(/\b(1[7-9]\d{2}|20\d{2})\b/g) || [];
      if (yrs.some(y => (birth && Math.abs(+y - birth) <= 5) || (death && Math.abs(+y - death) <= 5))) {
        confidence = Math.min(1, confidence + 0.3);
      }
      results.push({
        source: 'landesarchiv_berlin',
        title: title.slice(0, 120),
        url: abs,
        snippet,
        confidence,
        payload: { archiv: 'Landesarchiv Berlin' },
      });
    });
    if (!results.length) {
      return [{ source: 'landesarchiv_berlin', title: LABEL, url, snippet: 'Keine Treffer im Landesarchiv-Findbuch.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'landesarchiv_berlin', title: LABEL, url, snippet: 'Parsing-Fehler.', confidence: 0, payload: { error: err.message } }];
  }
}
