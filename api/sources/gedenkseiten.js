// gedenkseiten.de — Nachrufe/Traueranzeigen. Analog zu trauer.de.
import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'Gedenkseiten.de', url: 'https://www.gedenkseiten.de' };
const LABEL = 'Gedenkseiten.de';

export async function search(person) {
  if (isPreDigital(person)) {
    return [{ source: 'gedenkseiten', title: LABEL, url: META.url, snippet: 'uebersprungen (vor Online-Nachrufe-Zeitalter).', confidence: 0, payload: { skipped: 'pre_digital' } }];
  }
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://www.gedenkseiten.de/traueranzeigen/suche/?q=${encodeURIComponent(full)}`;
  const r = await fetchPage('gedenkseiten', url, { timeout: 10_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) return [needsFirecrawlCard('gedenkseiten', LABEL, url, `HTTP ${r.status}`)];
    return [{ source: 'gedenkseiten', title: LABEL, url, snippet: `Zugriff fehlgeschlagen (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const html = r.html || r.text || '';
  try {
    const $ = cheerio.load(html);
    const birth = yearOf(person.birth_date);
    const death = yearOf(person.death_date);
    const results = [];
    $('.result, .nachruf, article, li.search-item, .gedenkseite').slice(0, 8).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h2, h3, .name, a').first().text() || '').trim().replace(/\s+/g, ' ');
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!title) return;
      const abs = link.startsWith('http') ? link : 'https://www.gedenkseiten.de' + link;
      let confidence = 0.55;
      const yrs = snippet.match(/\b(1[89]\d{2}|20\d{2})\b/g) || [];
      if (yrs.some(y => (birth && Math.abs(+y - birth) <= 2) || (death && Math.abs(+y - death) <= 2))) {
        confidence = Math.min(1, confidence + 0.2);
      }
      results.push({ source: 'gedenkseiten', title: title.slice(0, 120), url: abs, snippet, confidence, payload: { obituary: true } });
    });
    if (!results.length) return [{ source: 'gedenkseiten', title: LABEL, url, snippet: 'Keine Treffer.', confidence: 0, payload: { empty: true } }];
    return results;
  } catch (err) {
    return [{ source: 'gedenkseiten', title: LABEL, url, snippet: 'Parsing-Fehler.', confidence: 0, payload: { error: err.message } }];
  }
}
