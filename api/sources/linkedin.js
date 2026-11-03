// LinkedIn public profiles — via the pluggable web search backend (site:).
import { nameParts, yearOf } from '../http.js';
import { webSearch, noBackendHit } from '../search_backend.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'LinkedIn (öffentlich)', url: 'https://linkedin.com' };

export async function search(person) {
  if (isPreDigital(person)) return [];
  const { full, variants } = nameParts(person);
  if (!full) return [];
  // Mehrere Namens-Varianten durchsuchen (Doppelnamen, einzelne Vornamen,
  // Geburtsname), damit "Erich Pott" neben "Erich Herbert Günther Pott"
  // ebenso gefunden wird wie "Anna Mustermann" (geb.) neben "Anna Pott".
  const seen = new Set();
  const allHits = [];
  let lastError = null;
  for (const v of variants.slice(0, 5)) {
    const result = await webSearch({ query: `"${v.name}"`, siteFilter: 'linkedin.com/in', limit: 10 });
    if (!result.ok) {
      if (result.error === 'no_backend') return [noBackendHit('linkedin', 'LinkedIn (öffentlich)')];
      lastError = result.error;
      continue;
    }
    for (const h of (result.hits || [])) {
      const u = (h.url || '').toLowerCase();
      if (seen.has(u)) continue;
      seen.add(u);
      allHits.push(h);
    }
  }
  if (!allHits.length && lastError) {
    return [{ source: 'linkedin', title: 'LinkedIn', url: 'https://linkedin.com', snippet: `Zugriff nicht möglich (${lastError})`, confidence: 0, payload: { error: lastError } }];
  }
  const profiles = allHits.filter(h => /linkedin\.com\/in\//i.test(h.url || ''));
  if (!profiles.length) {
    return [{ source: 'linkedin', title: 'LinkedIn', url: `https://search.brave.com/search?q=${encodeURIComponent('"' + full + '" site:linkedin.com/in')}`, snippet: 'Keine öffentlichen Profile im Index.', confidence: 0, payload: { empty: true } }];
  }

  const birthYear = yearOf(person.birth_date);
  const residences = (person.residences || []).map(r => (r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);
  const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);

  return profiles.slice(0, 8).map(h => {
    const text = ((h.snippet || '') + ' ' + (h.title || '')).toLowerCase();
    let confidence = 0.4;
    if (birthYear && text.includes(String(birthYear))) confidence += 0.2;
    if (text.includes('deutschland') || text.includes('germany')) confidence += 0.05;
    for (const r of residences) if (r.length > 2 && text.includes(r)) { confidence += 0.2; break; }
    for (const e of employers) if (e.length > 2 && text.includes(e)) { confidence += 0.1; break; }
    return {
      source: 'linkedin',
      title: (h.title || '').slice(0, 140),
      url: h.url,
      snippet: (h.snippet || 'LinkedIn-Profil').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { profile_url: h.url, headline: h.snippet, backend: h.backend || 'firecrawl' },
    };
  });
}
