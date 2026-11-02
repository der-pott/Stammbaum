// LinkedIn public profiles — reached via a DDG site: query. LinkedIn itself
// blocks bots; the DDG index is the practical route.
import { nameParts } from '../http.js';
import { ddgSearch } from './duckduckgo.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'LinkedIn (öffentlich)', url: 'https://linkedin.com' };

export async function search(person) {
  if (isPreDigital(person)) return [];
  const { full } = nameParts(person);
  if (!full) return [];
  const q = `"${full}" site:linkedin.com/in`;
  const result = await ddgSearch('linkedin', q);
  if (!result.ok) {
    return [{ source: 'linkedin', title: 'LinkedIn', url: result.url, snippet: `Zugriff nicht möglich (${result.error})`, confidence: 0, payload: { error: result.error } }];
  }
  const profiles = result.hits.filter(h => /linkedin\.com\/in\//i.test(h.url || ''));
  if (!profiles.length) {
    return [{ source: 'linkedin', title: 'LinkedIn', url: result.url, snippet: 'Keine öffentlichen Profile im DDG-Index gefunden.', confidence: 0, payload: { empty: true } }];
  }
  // Pull context from the person's jobs (if the worker attached them) to boost
  // confidence when a profile snippet references the same employer.
  const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);
  return profiles.slice(0, 8).map(h => {
    const snip = (h.snippet || '').toLowerCase();
    let confidence = 0.4;
    if (snip.includes('deutschland') || snip.includes('germany')) confidence += 0.1;
    for (const e of employers) if (e && snip.includes(e)) { confidence += 0.2; break; }
    return {
      source: 'linkedin',
      title: h.title.slice(0, 140),
      url: h.url,
      snippet: (h.snippet || 'LinkedIn-Profil').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { profile_url: h.url, headline: h.snippet },
    };
  });
}
