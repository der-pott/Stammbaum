// Google Books — public volumes API, no key for low volume.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Google Books', url: 'https://books.google.com' };

async function fetchVolumes(sourceKey, query) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`;
  const r = await httpGet(sourceKey, url, { accept: 'json' });
  if (!r.ok) return { ok: false, items: [], error: r.error, url };
  return { ok: true, items: r.body?.items || [], url };
}

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  const [byAuthor, byMention] = await Promise.all([
    fetchVolumes('googlebooks', `inauthor:"${full}"`),
    fetchVolumes('googlebooks', `"${full}"`),
  ]);

  if (!byAuthor.ok && !byMention.ok) {
    return [{ source: 'googlebooks', title: 'Google Books', url: byAuthor.url, snippet: `Zugriff nicht möglich (${byAuthor.error || byMention.error})`, confidence: 0, payload: { error: byAuthor.error || byMention.error } }];
  }

  const seen = new Set();
  const results = [];
  const push = (v, baseConf) => {
    const id = v.id || '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    const info = v.volumeInfo || {};
    const authors = (info.authors || []).join(', ');
    const published = info.publishedDate || '';
    const descr = (info.description || info.subtitle || '').slice(0, 220);
    results.push({
      source: 'googlebooks',
      title: (info.title || 'Buch').slice(0, 140),
      url: info.canonicalVolumeLink || info.previewLink || `https://books.google.com/books?id=${id}`,
      snippet: [authors, published, descr].filter(Boolean).join(' · ').slice(0, 240),
      confidence: baseConf,
      payload: { id, authors: info.authors, published_date: published, categories: info.categories },
    });
  };
  for (const v of byAuthor.items) push(v, 0.5);
  for (const v of byMention.items) push(v, 0.3);

  if (!results.length) {
    return [{ source: 'googlebooks', title: 'Google Books', url: byAuthor.url, snippet: 'Keine Bücher gefunden.', confidence: 0, payload: { empty: true } }];
  }
  return results.slice(0, 12);
}
