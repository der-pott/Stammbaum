// Internet Archive — books, newspapers, films. JSON.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Internet Archive', url: 'https://archive.org' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const q = `"${full}"`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&fl[]=mediatype&rows=10&output=json`;
  const r = await httpGet('archive_org', url, { accept: 'json' });
  if (!r.ok) return [{ source: 'archive_org', title: 'Internet Archive', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  const docs = r.body?.response?.docs || [];
  if (!docs.length) return [{ source: 'archive_org', title: 'Internet Archive', url, snippet: 'Keine Treffer.', confidence: 0, payload: { empty: true } }];
  return docs.map(d => ({
    source: 'archive_org',
    title: (d.title || d.identifier || '').slice(0, 140),
    url: d.identifier ? `https://archive.org/details/${d.identifier}` : url,
    snippet: [d.creator, d.date, d.mediatype].filter(Boolean).join(' · ').slice(0, 220),
    confidence: 0.25,
    payload: { identifier: d.identifier, mediatype: d.mediatype },
  }));
}
