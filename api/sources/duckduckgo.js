// General web search — uses the pluggable search backend (Brave / Serper).
// Named "duckduckgo" for backwards compat with the dispatcher key; actually
// backend-agnostic now.
import { nameParts, yearOf } from '../http.js';
import { webSearch, noBackendHit } from '../search_backend.js';

export const META = { label: 'Web (allgemein)', url: 'https://search.brave.com' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const birthYear = yearOf(person.birth_date);
  const birthPlace = (person.birth_place || '').trim();
  const parts = [`"${full}"`];
  if (birthYear) parts.push(String(birthYear));
  if (birthPlace) parts.push(birthPlace);
  const q = parts.join(' ');

  const result = await webSearch({ query: q, limit: 10 });
  if (!result.ok) {
    if (result.error === 'no_backend') return [noBackendHit('duckduckgo', 'Web (allgemein)')];
    return [{ source: 'duckduckgo', title: 'Web', url: 'https://search.brave.com', snippet: `Zugriff nicht möglich (${result.error})`, confidence: 0, payload: { error: result.error } }];
  }
  if (!result.hits.length) {
    return [{ source: 'duckduckgo', title: 'Web', url: 'https://search.brave.com', snippet: 'Keine Web-Treffer.', confidence: 0, payload: { empty: true } }];
  }

  const residences = (person.residences || []).map(r => (r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);
  const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);
  const birthPlaceLower = birthPlace.toLowerCase();

  return result.hits.map(h => {
    const text = ((h.snippet || '') + ' ' + (h.title || '')).toLowerCase();
    let confidence = 0.3;
    if (birthYear && text.includes(String(birthYear))) confidence += 0.2;
    if (birthPlaceLower.length > 2 && text.includes(birthPlaceLower)) confidence += 0.2;
    for (const r of residences) if (r.length > 2 && text.includes(r)) { confidence += 0.1; break; }
    for (const e of employers) if (e.length > 2 && text.includes(e)) { confidence += 0.1; break; }
    return {
      source: 'duckduckgo',
      title: (h.title || '').slice(0, 140),
      url: h.url,
      snippet: (h.snippet || '').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { href: h.url, backend: result.backend },
    };
  });
}
