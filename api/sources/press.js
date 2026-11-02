// German press releases — via the pluggable web search backend, site:-filter.
import { nameParts, yearOf } from '../http.js';
import { webSearch, noBackendHit } from '../search_backend.js';

export const META = { label: 'Presse (Portal + OpenPR)', url: 'https://presseportal.de' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  const [a, b] = await Promise.all([
    webSearch({ query: `"${full}"`, siteFilter: 'presseportal.de', limit: 8 }),
    webSearch({ query: `"${full}"`, siteFilter: 'openpr.de', limit: 8 }),
  ]);

  if (!a.ok && !b.ok) {
    if (a.error === 'no_backend' || b.error === 'no_backend') return [noBackendHit('press', 'Presse')];
    return [{ source: 'press', title: 'Presse', url: 'https://presseportal.de', snippet: `Zugriff nicht möglich (${a.error || b.error})`, confidence: 0, payload: { error: a.error || b.error } }];
  }
  const combined = [...(a.hits || []), ...(b.hits || [])];
  if (!combined.length) {
    return [{ source: 'press', title: 'Presse', url: 'https://presseportal.de', snippet: 'Keine Presse-Treffer.', confidence: 0, payload: { empty: true } }];
  }

  const seen = new Set();
  const deduped = [];
  for (const h of combined) {
    if (!h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    deduped.push(h);
  }

  const birth = yearOf(person.birth_date);
  const death = yearOf(person.death_date);
  const residences = (person.residences || []).map(r => (r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);

  return deduped.slice(0, 10).map(h => {
    const text = ((h.snippet || '') + ' ' + (h.title || '')).toLowerCase();
    let confidence = 0.3;
    const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => parseInt(m[1], 10));
    for (const y of years) {
      if (birth && y >= birth && (!death || y <= death + 5)) { confidence += 0.2; break; }
    }
    for (const r of residences) if (r.length > 2 && text.includes(r)) { confidence += 0.1; break; }
    return {
      source: 'press',
      title: (h.title || '').slice(0, 140),
      url: h.url,
      snippet: (h.snippet || '').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { href: h.url, backend: a.backend || b.backend },
    };
  });
}
