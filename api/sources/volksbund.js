// Volksbund Deutsche Kriegsgräberfürsorge — Gräbersuche für WK1/WK2 Gefallene.
// HTML-Scrape. Nur ausführen, wenn Sterbedatum in Kriegsjahren liegt.
import * as cheerio from 'cheerio';
import { httpGet, nameParts, yearOf } from '../http.js';

export const META = { label: 'Volksbund Gräbersuche (WK1/WK2)', url: 'https://www.volksbund.de' };

export async function search(person) {
  const { firstGiven, surname } = nameParts(person);
  if (!surname) return [];
  const d = yearOf(person.death_date);
  const b = yearOf(person.birth_date);
  // Only run if the person could plausibly have died in WK1 or WK2.
  const inWar = (d && ((d >= 1914 && d <= 1918) || (d >= 1939 && d <= 1950))) ||
                (!d && b && b >= 1870 && b <= 1930);
  if (!inWar) return [];
  const params = new URLSearchParams({ vorname: firstGiven || '', nachname: surname });
  const url = `https://www.volksbund.de/erinnern-gedenken/graebersuche-online?${params.toString()}`;
  const r = await httpGet('volksbund', url, { accept: 'text' });
  if (!r.ok) return [{ source: 'volksbund', title: 'Volksbund Gräbersuche', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    $('.result-item, article, .search-result, tr').slice(0, 8).each((_, el) => {
      const $el = $(el);
      const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 10) return;
      if (!text.toLowerCase().includes(surname.toLowerCase())) return;
      const link = $el.find('a[href]').first().attr('href') || '';
      const abs = link.startsWith('http') ? link : (link ? 'https://www.volksbund.de' + link : url);
      results.push({ source: 'volksbund', title: text.slice(0, 120), url: abs, snippet: text.slice(0, 240), confidence: 0.4, payload: { war_grave: true } });
    });
    if (!results.length) return [{ source: 'volksbund', title: 'Volksbund', url, snippet: 'Kein Eintrag in der Gräberdatenbank.', confidence: 0, payload: { empty: true } }];
    return results;
  } catch (err) {
    return [{ source: 'volksbund', title: 'Volksbund', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
