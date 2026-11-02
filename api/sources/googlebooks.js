// Google Books — public volumes API. Supports optional GOOGLE_BOOKS_API_KEY
// (free, 1000/day). Without a key we throttle hard to stay under the shared
// anonymous quota.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Google Books', url: 'https://books.google.com' };

// Anonymous throttle: track last call time so we never fire more than one
// Google Books call per 3s process-wide.
let lastCallAt = 0;
const ANON_INTERVAL_MS = 3000;

async function anonWait() {
  if (process.env.GOOGLE_BOOKS_API_KEY) return;
  const now = Date.now();
  const wait = lastCallAt + ANON_INTERVAL_MS - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function fetchVolumes(sourceKey, query) {
  await anonWait();
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`;
  if (key) url += `&key=${encodeURIComponent(key)}`;
  const r = await httpGet(sourceKey, url, { accept: 'json' });
  if (!r.ok) return { ok: false, items: [], error: r.error, url };
  return { ok: true, items: r.body?.items || [], url };
}

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  // Sequential (not parallel) to respect anon-throttle.
  const byAuthor = await fetchVolumes('googlebooks', `inauthor:"${full}"`);
  const byMention = await fetchVolumes('googlebooks', `"${full}"`);

  if (!byAuthor.ok && !byMention.ok) {
    const err = byAuthor.error || byMention.error;
    const needsKey = /HTTP 429|HTTP 403/.test(err || '');
    return [{
      source: 'googlebooks',
      title: 'Google Books',
      url: byAuthor.url,
      snippet: needsKey
        ? `Rate-Limit. API-Key empfohlen (GOOGLE_BOOKS_API_KEY in .env; 1000 Queries/Tag frei).`
        : `Zugriff nicht möglich (${err})`,
      confidence: 0,
      payload: { error: err, needs_key: needsKey, env_var: 'GOOGLE_BOOKS_API_KEY', docs_url: 'https://developers.google.com/books/docs/v1/using#APIKey' },
    }];
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
