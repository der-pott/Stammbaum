// Europeana — paneuropaeisches Kulturerbe-API. Dokumente, Fotos, Zeitungen aus Archiven.
import { fetchJson } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';

export const META = { label: 'Europeana', url: 'https://api.europeana.eu' };
const LABEL = 'Europeana';

export async function search(person) {
  const key = process.env.EUROPEANA_API_KEY;
  const { full, surname } = nameParts(person);
  if (!full) return [];
  if (!key) {
    return [{
      source: 'europeana',
      title: LABEL,
      url: 'https://pro.europeana.eu/get-api',
      snippet: 'API-Key fehlt. Kostenlos registrieren und EUROPEANA_API_KEY in .env setzen.',
      confidence: 0,
      payload: { needs_config: true, env_var: 'EUROPEANA_API_KEY' },
    }];
  }
  const query = `who:"${full}"`;
  const url = `https://api.europeana.eu/record/v2/search.json?wskey=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}&profile=minimal&rows=10`;
  const r = await fetchJson('europeana', url, { timeout: 10_000 });
  if (!r.ok) {
    return [{ source: 'europeana', title: LABEL, url: META.url, snippet: `API-Fehler (${r.error || 'HTTP ' + r.status})`, confidence: 0, payload: { error: r.error } }];
  }
  const data = r.body || {};
  const items = data.items || [];
  if (!items.length) {
    return [{ source: 'europeana', title: LABEL, url: META.url, snippet: 'Keine Treffer.', confidence: 0, payload: { empty: true } }];
  }
  const birth = yearOf(person.birth_date);
  const death = yearOf(person.death_date);
  return items.slice(0, 8).map(it => {
    const title = (Array.isArray(it.title) ? it.title[0] : it.title) || LABEL;
    const link = it.guid || it.edmPreview || `https://www.europeana.eu/en/item${it.id || ''}`;
    const snippet = [it.dataProvider, it.country, it.dcCreator].flat().filter(Boolean).join(' · ').slice(0, 240);
    let confidence = 0.4;
    const txt = JSON.stringify(it).toLowerCase();
    if (surname && txt.includes(surname.toLowerCase())) confidence += 0.2;
    const yrs = (JSON.stringify(it).match(/\b(1[6-9]\d{2}|20\d{2})\b/g) || []).map(Number);
    if (yrs.some(y => (birth && Math.abs(y - birth) <= 3) || (death && Math.abs(y - death) <= 3))) {
      confidence = Math.min(1, confidence + 0.2);
    }
    return { source: 'europeana', title: String(title).slice(0, 120), url: link, snippet, confidence, payload: { europeana_id: it.id } };
  });
}
