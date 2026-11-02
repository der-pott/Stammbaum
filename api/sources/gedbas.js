// GEDBAS — compgen.de genealogical database. HTML scrape.
// robots.txt: open to crawl.
import * as cheerio from 'cheerio';
import { httpGet, nameParts, yearOf } from '../http.js';

export const META = { label: 'GEDBAS (compgen.de)', url: 'http://gedbas.genealogy.net' };

export async function search(person) {
  const { firstGiven, surname } = nameParts(person);
  if (!surname) return [];
  // GEDBAS uses POST + nested name params. We hit the HTML search page.
  const url = `https://gedbas.genealogy.net/search/simple?lastname=${encodeURIComponent(surname)}&firstname=${encodeURIComponent(firstGiven || '')}`;
  const r = await httpGet('gedbas', url, { accept: 'text' });
  if (!r.ok) return [{ source: 'gedbas', title: 'GEDBAS', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    const targetBirth = yearOf(person.birth_date);
    // GEDBAS uses a table layout for results.
    $('table.list tr, table tr').slice(1, 20).each((_, tr) => {
      const $tr = $(tr);
      const cells = $tr.find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      const link = $tr.find('a[href]').first().attr('href') || '';
      const name = cells[0] || '';
      const dates = cells.slice(1).join(' · ');
      if (!name || name.length < 2) return;
      const abs = link.startsWith('http') ? link : (link ? 'http://gedbas.genealogy.net' + link : url);
      const hitBirth = yearOf(dates);
      let confidence = 0.3;
      if (targetBirth && hitBirth && Math.abs(targetBirth - hitBirth) <= 2) confidence += 0.3;
      if (name.toLowerCase().includes(surname.toLowerCase())) confidence += 0.1;
      results.push({ source: 'gedbas', title: name.slice(0, 120), url: abs, snippet: dates.slice(0, 220), confidence, payload: { table: cells } });
    });
    if (!results.length) {
      return [{ source: 'gedbas', title: 'GEDBAS', url, snippet: 'Keine Treffer gefunden.', confidence: 0, payload: { empty: true } }];
    }
    return results.slice(0, 10);
  } catch (err) {
    return [{ source: 'gedbas', title: 'GEDBAS', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
