// BillionGraves — public grave search. HTML scrape with photo URL extraction.
// robots.txt: /search/* is permitted.
import * as cheerio from 'cheerio';
import { httpGet, nameParts, yearOf } from '../http.js';

export const META = { label: 'BillionGraves', url: 'https://billiongraves.com' };

export async function search(person) {
  const { firstGiven, surname } = nameParts(person);
  if (!surname) return [];
  const params = new URLSearchParams({ given_name: firstGiven || '', family_name: surname });
  const dYear = yearOf(person.death_date);
  if (dYear) { params.set('death_year', String(dYear)); params.set('death_year2', String(dYear)); }
  const url = `https://billiongraves.com/search/results?${params.toString()}`;
  const r = await httpGet('billiongraves', url, { accept: 'text', browser: true });
  if (!r.ok) return [{ source: 'billiongraves', title: 'BillionGraves', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    $('.result-item, .search-result, a[href*="/grave/"]').slice(0, 10).each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.name, h3, .title').first().text() || $el.text() || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const link = ($el.is('a') ? $el : $el.find('a[href*="/grave/"]')).attr('href') || '';
      const img = $el.find('img').first().attr('src') || '';
      if (!title || title.length < 3) return;
      const abs = link.startsWith('http') ? link : (link ? 'https://billiongraves.com' + link : url);
      results.push({ source: 'billiongraves', title, url: abs, snippet: ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 200), confidence: 0.35, payload: { grave_photo_url: img || null } });
    });
    if (!results.length) {
      return [{ source: 'billiongraves', title: 'BillionGraves', url, snippet: 'Kein Grabmal gefunden.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'billiongraves', title: 'BillionGraves', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
