// Deutsche Digitale Bibliothek — API. API-Key optional (recommended for throughput).
// robots.txt: /api/* open.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Deutsche Digitale Bibliothek', url: 'https://www.deutsche-digitale-bibliothek.de' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const apiKey = process.env.DDB_API_KEY;
  const url = `https://api.deutsche-digitale-bibliothek.de/search?query=${encodeURIComponent(full)}&rows=10`;
  const headers = { accept: 'application/json' };
  if (apiKey) headers.Authorization = `OAuth oauth_consumer_key="${apiKey}"`;
  const r = await httpGet('ddb', url, { accept: 'json', headers });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return [{ source: 'ddb', title: 'DDB — API-Key empfohlen', url: 'https://www.deutsche-digitale-bibliothek.de/user/apikey', snippet: 'Für Suche einen kostenlosen API-Key eintragen (ENV: DDB_API_KEY).', confidence: 0, payload: { needs_key: true } }];
    }
    return [{ source: 'ddb', title: 'DDB', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const items = r.body?.results?.[0]?.docs || r.body?.results || [];
  const results = [];
  for (const d of items.slice(0, 10)) {
    const id = d.id || d.item?.id || '';
    const title = d.title || d.item?.title || '';
    if (!title) continue;
    results.push({
      source: 'ddb',
      title: String(title).slice(0, 140),
      url: id ? `https://www.deutsche-digitale-bibliothek.de/item/${id}` : url,
      snippet: (d.preview || d.description || '').slice(0, 220),
      confidence: 0.3,
      payload: { ddb_id: id, place: d.place_display, year: d.year_display },
    });
  }
  if (!results.length) return [{ source: 'ddb', title: 'DDB', url, snippet: 'Keine Treffer.', confidence: 0, payload: { empty: true } }];
  return results;
}
