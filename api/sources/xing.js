// Xing public profiles — DDG site: filter. Xing's own search needs login.
import { nameParts } from '../http.js';
import { ddgSearch } from './duckduckgo.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'Xing (öffentlich)', url: 'https://xing.com' };

export async function search(person) {
  if (isPreDigital(person)) return [];
  const { full } = nameParts(person);
  if (!full) return [];
  const q = `"${full}" site:xing.com/profile`;
  const result = await ddgSearch('xing', q);
  if (!result.ok) {
    return [{ source: 'xing', title: 'Xing', url: result.url, snippet: `Zugriff nicht möglich (${result.error})`, confidence: 0, payload: { error: result.error } }];
  }
  const profiles = result.hits.filter(h => /xing\.com\/profile\//i.test(h.url || ''));
  if (!profiles.length) {
    return [{ source: 'xing', title: 'Xing', url: result.url, snippet: 'Keine öffentlichen Xing-Profile gefunden.', confidence: 0, payload: { empty: true } }];
  }
  const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);
  return profiles.slice(0, 8).map(h => {
    const snip = (h.snippet || '').toLowerCase();
    // Xing is DE-centric so match on German surname gets a stronger prior.
    let confidence = 0.45;
    for (const e of employers) if (e && snip.includes(e)) { confidence += 0.2; break; }
    return {
      source: 'xing',
      title: h.title.slice(0, 140),
      url: h.url,
      snippet: (h.snippet || 'Xing-Profil').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { profile_url: h.url, headline: h.snippet },
    };
  });
}
