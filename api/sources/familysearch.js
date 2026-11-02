// FamilySearch — public search page. Unauth. HTML scrape.
// robots.txt: /search/* allowed for Googlebot but no explicit stance for others.
// We use the public results page as a user would.
import * as cheerio from 'cheerio';
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'FamilySearch (öffentliche Suche)', url: 'https://www.familysearch.org' };

export async function search(person) {
  const { firstGiven, surname } = nameParts(person);
  if (!surname) return [];
  const params = new URLSearchParams({
    'q.givenName': firstGiven || '',
    'q.surname': surname,
    'q.birthLikePlace': person.birth_place || '',
  });
  const url = `https://www.familysearch.org/search/record/results?${params.toString()}`;
  const r = await httpGet('familysearch', url, { accept: 'text', timeout: 12_000, browser: true });
  if (!r.ok) return [{ source: 'familysearch', title: 'FamilySearch', url, snippet: `Zugriff nicht möglich (${r.error}). Für detaillierte Suche: Login unter familysearch.org`, confidence: 0, payload: { note: 'auth-helpful', error: r.error } }];
  try {
    const $ = cheerio.load(r.body);
    const results = [];
    // The actual markup is a React SPA; look for structured link patterns.
    $('a[href*="/ark:/"]').slice(0, 10).each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim().replace(/\s+/g, ' ');
      if (!text || text.length < 4) return;
      const href = $el.attr('href') || '';
      const full = href.startsWith('http') ? href : 'https://www.familysearch.org' + href;
      results.push({ source: 'familysearch', title: text.slice(0, 120), url: full, snippet: 'FamilySearch-Treffer — für vollständige Daten einloggen', confidence: 0.25, payload: { auth_unlocks_more: true } });
    });
    if (!results.length) {
      return [{ source: 'familysearch', title: 'FamilySearch', url, snippet: 'Keine öffentlichen Treffer. Mit Account unter familysearch.org weitersuchen.', confidence: 0, payload: { note: 'empty-public-results' } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'familysearch', title: 'FamilySearch', url, snippet: 'Parsing-Fehler, bitte manuell prüfen', confidence: 0, payload: { error: err.message } }];
  }
}
