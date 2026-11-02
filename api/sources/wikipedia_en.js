// English Wikipedia — REST summary endpoint for internationally known persons.
import { httpGet, nameParts, yearOf } from '../http.js';

export const META = { label: 'Wikipedia (EN)', url: 'https://en.wikipedia.org' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full || full.split(' ').length < 2) return [];
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(full)}`;
  const r = await httpGet('wikipedia_en', url, { accept: 'json' });
  if (!r.ok) {
    if (r.status === 404) return [{ source: 'wikipedia_en', title: 'Wikipedia (EN)', url, snippet: 'Kein englischer Wikipedia-Eintrag.', confidence: 0, payload: { empty: true } }];
    return [{ source: 'wikipedia_en', title: 'Wikipedia (EN)', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const w = r.body;
  if (!w || w.type === 'disambiguation' || !w.extract) return [];
  const b = yearOf(person.birth_date);
  let confidence = 0.35;
  if (b && (w.extract || '').includes(String(b))) confidence += 0.2;
  return [{
    source: 'wikipedia_en',
    title: w.title,
    url: w.content_urls?.desktop?.page || url,
    snippet: (w.extract || '').slice(0, 300),
    confidence,
    payload: { summary: w.extract, lang: 'en' },
  }];
}
