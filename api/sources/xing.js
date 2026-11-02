// Xing public profiles — via the pluggable web search backend (site:).
import { nameParts, yearOf } from '../http.js';
import { webSearch, noBackendHit } from '../search_backend.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'Xing (öffentlich)', url: 'https://xing.com' };

export async function search(person) {
  if (isPreDigital(person)) return [];
  const { full } = nameParts(person);
  if (!full) return [];
  const result = await webSearch({ query: `"${full}"`, siteFilter: 'xing.com/profile', limit: 10 });
  if (!result.ok) {
    if (result.error === 'no_backend') return [noBackendHit('xing', 'Xing (öffentlich)')];
    return [{ source: 'xing', title: 'Xing', url: 'https://xing.com', snippet: `Zugriff nicht möglich (${result.error})`, confidence: 0, payload: { error: result.error } }];
  }
  const profiles = result.hits.filter(h => /xing\.com\/profile\//i.test(h.url || ''));
  if (!profiles.length) {
    return [{ source: 'xing', title: 'Xing', url: `https://search.brave.com/search?q=${encodeURIComponent('"' + full + '" site:xing.com/profile')}`, snippet: 'Keine öffentlichen Xing-Profile.', confidence: 0, payload: { empty: true } }];
  }

  const birthYear = yearOf(person.birth_date);
  const residences = (person.residences || []).map(r => (r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);
  const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);

  return profiles.slice(0, 8).map(h => {
    const text = ((h.snippet || '') + ' ' + (h.title || '')).toLowerCase();
    let confidence = 0.45; // DE-centric prior
    if (birthYear && text.includes(String(birthYear))) confidence += 0.2;
    for (const r of residences) if (r.length > 2 && text.includes(r)) { confidence += 0.2; break; }
    for (const e of employers) if (e.length > 2 && text.includes(e)) { confidence += 0.1; break; }
    return {
      source: 'xing',
      title: (h.title || '').slice(0, 140),
      url: h.url,
      snippet: (h.snippet || 'Xing-Profil').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { profile_url: h.url, headline: h.snippet, backend: result.backend },
    };
  });
}
