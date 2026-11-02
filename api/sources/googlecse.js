// Google Custom Search Engine — only active when both GOOGLE_CSE_API_KEY and
// GOOGLE_CSE_CX are configured. Hidden from the UI grid otherwise.
import { nameParts, yearOf } from '../http.js';

export const META = { label: 'Google (via CSE)', url: 'https://www.google.com' };
const DEFAULT_TIMEOUT = 10_000;
const UA = 'Stammbaum-Pott/1.0 (private family research; contact: maximilian.pott@outlook.com)';

export function isConfigured() {
  return !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX);
}

async function cseFetch(q, num) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  const params = new URLSearchParams({ key, cx, q, num: String(Math.min(num || 10, 10)), hl: 'de', gl: 'de' });
  const url = `https://customsearch.googleapis.com/customsearch/v1?${params}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`CSE HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  } finally {
    clearTimeout(t);
  }
}

export async function search(person) {
  if (!isConfigured()) {
    return [{
      source: 'googlecse',
      title: 'Google (CSE)',
      url: 'https://programmablesearchengine.google.com/',
      snippet: 'Nicht konfiguriert. Setze GOOGLE_CSE_API_KEY und GOOGLE_CSE_CX in /srv/projects/stammbaum/.env.',
      confidence: 0,
      payload: { needs_config: true, env_vars: ['GOOGLE_CSE_API_KEY', 'GOOGLE_CSE_CX'], docs_url: 'https://developers.google.com/custom-search/v1/overview' },
    }];
  }
  const { full } = nameParts(person);
  if (!full) return [];
  const birthYear = yearOf(person.birth_date);
  const parts = [`"${full}"`];
  if (birthYear) parts.push(String(birthYear));
  if (person.birth_place) parts.push(person.birth_place);
  const q = parts.join(' ');
  try {
    const items = await cseFetch(q, 10);
    if (!items.length) {
      return [{ source: 'googlecse', title: 'Google (CSE)', url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, snippet: 'Keine Treffer.', confidence: 0, payload: { empty: true } }];
    }
    const residences = (person.residences || []).map(r => (r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);
    const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);
    return items.map(it => {
      const text = ((it.snippet || '') + ' ' + (it.title || '')).toLowerCase();
      let confidence = 0.35;
      if (birthYear && text.includes(String(birthYear))) confidence += 0.2;
      if ((person.birth_place || '').toLowerCase().length > 2 && text.includes((person.birth_place || '').toLowerCase())) confidence += 0.2;
      for (const r of residences) if (r.length > 2 && text.includes(r)) { confidence += 0.1; break; }
      for (const e of employers) if (e.length > 2 && text.includes(e)) { confidence += 0.1; break; }
      return {
        source: 'googlecse',
        title: (it.title || '').slice(0, 140),
        url: it.link,
        snippet: (it.snippet || '').slice(0, 240),
        confidence: Math.min(1, confidence),
        payload: { href: it.link, display_link: it.displayLink },
      };
    });
  } catch (err) {
    return [{ source: 'googlecse', title: 'Google (CSE)', url: 'https://www.google.com', snippet: `Fehler: ${err.message}`, confidence: 0, payload: { error: err.message } }];
  }
}
