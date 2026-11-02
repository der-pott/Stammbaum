// VIAF — Virtual International Authority File. JSON autosuggest.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'VIAF (Authority File)', url: 'https://viaf.org' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://viaf.org/viaf/AutoSuggest?query=${encodeURIComponent(full)}`;
  const r = await httpGet('viaf', url, { accept: 'json' });
  if (!r.ok) return [{ source: 'viaf', title: 'VIAF', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  const results = r.body?.result || [];
  if (!results.length) return [{ source: 'viaf', title: 'VIAF', url, snippet: 'Keine Normdaten-Treffer.', confidence: 0, payload: { empty: true } }];
  return results.slice(0, 8).map(d => ({
    source: 'viaf',
    title: (d.displayForm || d.term || '').slice(0, 140),
    url: `https://viaf.org/viaf/${d.viafid || ''}`,
    snippet: `${d.nametype || ''} · VIAF ${d.viafid || ''} · DNB ${d.dnb || '—'} · LCCN ${d.lc || '—'}`,
    confidence: 0.4,
    payload: { viafid: d.viafid, dnb: d.dnb, lc: d.lc, bnf: d.bnf, nametype: d.nametype },
  }));
}
