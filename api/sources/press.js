// German press releases — DDG site: queries over presseportal.de + openpr.de.
import { nameParts, yearOf } from '../http.js';
import { ddgSearch } from './duckduckgo.js';

export const META = { label: 'Presse (Portal + OpenPR)', url: 'https://presseportal.de' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  const [a, b] = await Promise.all([
    ddgSearch('press', `"${full}" site:presseportal.de`),
    ddgSearch('press', `"${full}" site:openpr.de`),
  ]);

  const combined = [...(a.hits || []), ...(b.hits || [])];
  if (!combined.length) {
    const url = a.url || b.url || 'https://duckduckgo.com';
    return [{ source: 'press', title: 'Presse', url, snippet: 'Keine Presse-Treffer.', confidence: 0, payload: { empty: true } }];
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

  return deduped.slice(0, 10).map(h => {
    const snip = (h.snippet || '').toLowerCase();
    let confidence = 0.3;
    // Date proximity — look for a year in snippet that falls in the person's lifespan.
    const years = [...snip.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => parseInt(m[1], 10));
    for (const y of years) {
      if (birth && y >= birth && (!death || y <= death + 5)) { confidence += 0.2; break; }
    }
    return {
      source: 'press',
      title: h.title.slice(0, 140),
      url: h.url,
      snippet: (h.snippet || '').slice(0, 240),
      confidence: Math.min(1, confidence),
      payload: { href: h.url },
    };
  });
}
