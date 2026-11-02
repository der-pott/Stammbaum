// Geneanet — grosses europaeisches Genealogie-Portal mit oeffentlichen Stammbaeumen.
import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';

export const META = { label: 'Geneanet Public Trees', url: 'https://en.geneanet.org' };
const LABEL = 'Geneanet (oeffentliche Stammbaeume)';

export async function search(person) {
  const { surname, firstGiven } = nameParts(person);
  if (!surname) return [];
  const url = `https://en.geneanet.org/search/?size=10&name=${encodeURIComponent(surname)}&prenom=${encodeURIComponent(firstGiven)}`;
  const r = await fetchPage('geneanet', url, { timeout: 12_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) return [needsFirecrawlCard('geneanet', LABEL, url, `HTTP ${r.status}`)];
    return [{ source: 'geneanet', title: LABEL, url, snippet: `Zugriff fehlgeschlagen (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const html = r.html || r.text || '';
  try {
    const $ = cheerio.load(html);
    const birth = yearOf(person.birth_date);
    const death = yearOf(person.death_date);
    const results = [];
    $('.search-result, .list-group-item, .arbre-item, article.result').slice(0, 10).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, h4, .name, a').first().text() || '').trim().replace(/\s+/g, ' ');
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!title || title.length < 3) return;
      const abs = link.startsWith('http') ? link : 'https://en.geneanet.org' + link;
      let confidence = 0.5;
      const yrs = snippet.match(/\b(1[6-9]\d{2}|20\d{2})\b/g) || [];
      if (yrs.some(y => (birth && Math.abs(+y - birth) <= 3) || (death && Math.abs(+y - death) <= 3))) {
        confidence = Math.min(1, confidence + 0.2);
      }
      // bonus if "pott" or project-known family name appears in context
      results.push({ source: 'geneanet', title: title.slice(0, 120), url: abs, snippet, confidence, payload: { geneanet: true } });
    });
    if (!results.length) return [{ source: 'geneanet', title: LABEL, url, snippet: 'Keine Treffer in oeffentlichen Baeumen.', confidence: 0, payload: { empty: true } }];
    return results;
  } catch (err) {
    return [{ source: 'geneanet', title: LABEL, url, snippet: 'Parsing-Fehler.', confidence: 0, payload: { error: err.message } }];
  }
}
