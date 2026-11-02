// Deutsche Nationalbibliothek — SRU protocol, no auth. MARC21-XML response.
// robots.txt: /sru/* open.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Deutsche Nationalbibliothek (DNB)', url: 'https://www.dnb.de' };

function marcField(xml, tag, sub) {
  const re = new RegExp(`<datafield[^>]*tag="${tag}"[^>]*>([\\s\\S]*?)</datafield>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1];
    const sre = new RegExp(`<subfield[^>]*code="${sub}"[^>]*>([^<]*)</subfield>`, 'i');
    const sm = sre.exec(inner);
    if (sm) out.push(sm[1].trim());
  }
  return out;
}

export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!surname) return [];
  const q = `per="${full || surname}"`;
  const url = `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=${encodeURIComponent(q)}&maximumRecords=10&recordSchema=MARC21-xml`;
  const r = await httpGet('dnb', url, { accept: 'text' });
  if (!r.ok) return [{ source: 'dnb', title: 'DNB', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  try {
    const xml = r.body;
    const records = xml.split('<record ').slice(1).map(x => '<record ' + x.split('</record>')[0] + '</record>');
    const results = [];
    for (const rec of records.slice(0, 10)) {
      const titles = marcField(rec, '245', 'a');
      const authors = marcField(rec, '100', 'a');
      const dates = marcField(rec, '100', 'd');
      const places = marcField(rec, '260', 'a');
      const years = marcField(rec, '260', 'c');
      const title = titles[0] || authors[0] || '';
      if (!title) continue;
      const snippet = [authors[0], dates[0], places[0], years[0]].filter(Boolean).join(' · ');
      results.push({
        source: 'dnb',
        title: title.slice(0, 140),
        url: `https://portal.dnb.de/opac.htm?query=${encodeURIComponent(full)}`,
        snippet: snippet.slice(0, 220) || 'Als Autor/Beitragender erwähnt',
        confidence: 0.4,
        payload: { authors, dates, places, years, titles },
      });
    }
    if (!results.length) return [{ source: 'dnb', title: 'DNB', url, snippet: 'Keine DNB-Treffer.', confidence: 0, payload: { empty: true } }];
    return results;
  } catch (err) {
    return [{ source: 'dnb', title: 'DNB', url, snippet: 'Parsing-Fehler', confidence: 0, payload: { error: err.message } }];
  }
}
