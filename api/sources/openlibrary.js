// Open Library — JSON author search.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Open Library', url: 'https://openlibrary.org' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://openlibrary.org/search.json?author=${encodeURIComponent(full)}&limit=10`;
  const r = await httpGet('openlibrary', url, { accept: 'json' });
  if (!r.ok) return [{ source: 'openlibrary', title: 'Open Library', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  const docs = r.body?.docs || [];
  if (!docs.length) return [{ source: 'openlibrary', title: 'Open Library', url, snippet: 'Keine Treffer.', confidence: 0, payload: { empty: true } }];
  return docs.slice(0, 10).map(d => ({
    source: 'openlibrary',
    title: (d.title || '').slice(0, 140),
    url: d.key ? `https://openlibrary.org${d.key}` : url,
    snippet: [d.author_name?.join(', '), d.first_publish_year, d.publisher?.slice(0, 2).join(', ')].filter(Boolean).join(' · ').slice(0, 220),
    confidence: 0.3,
    payload: { key: d.key, first_publish_year: d.first_publish_year, isbn: (d.isbn || []).slice(0, 3) },
  }));
}
