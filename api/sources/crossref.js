// CrossRef — academic publications by author. JSON.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'CrossRef (Publikationen)', url: 'https://www.crossref.org' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://api.crossref.org/works?query.author=${encodeURIComponent(full)}&rows=5&select=title,author,published-print,container-title,DOI`;
  const r = await httpGet('crossref', url, { accept: 'json' });
  if (!r.ok) return [{ source: 'crossref', title: 'CrossRef', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  const items = r.body?.message?.items || [];
  if (!items.length) return [{ source: 'crossref', title: 'CrossRef', url, snippet: 'Keine wissenschaftlichen Publikationen gefunden.', confidence: 0, payload: { empty: true } }];
  return items.map(it => ({
    source: 'crossref',
    title: (it.title?.[0] || 'Untitled').slice(0, 140),
    url: it.DOI ? `https://doi.org/${it.DOI}` : url,
    snippet: `${it.author?.map(a => `${a.given || ''} ${a.family || ''}`.trim()).join(', ') || ''} · ${it['container-title']?.[0] || ''} · ${it['published-print']?.['date-parts']?.[0]?.[0] || ''}`.slice(0, 220),
    confidence: 0.3,
    payload: { doi: it.DOI },
  }));
}
