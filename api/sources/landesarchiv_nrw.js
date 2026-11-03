// Landesarchiv NRW — archive.nrw.de Volltextsuche.
// Portal: https://www.archive.nrw.de/archivsuche?search=<name>&sort=order
// Scrape via Firecrawl (Playwright). Volltextindex deckt alle Landesarchiv-NRW-
// Abteilungen + Kommunal-/Stadtarchive in NRW ab. Transkripte von Standesamts-
// und Kirchenbüchern sind durchsuchbar, daher sehr hohe Treffsicherheit für
// Namen aus NRW-Vorfahren.

import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts } from '../http.js';

export const META = { label: 'Landesarchiv NRW', url: 'https://www.archive.nrw.de' };
const LABEL = 'Landesarchiv NRW';
const BASE = 'https://www.archive.nrw.de';

const MAX_VARIANTS = 4;

export async function search(person) {
  const { surname, full, variants, birthName } = nameParts(person);
  if (!surname) return [];
  const queries = (variants.length ? variants : [{ name: full, primary: true }])
    .slice(0, MAX_VARIANTS)
    .map(v => v.name);

  const seen = new Set();
  const results = [];
  let hadBlock = false;
  let lastUrl = BASE;
  const surnameLc = surname.toLowerCase();
  const birthNameLc = (birthName || '').toLowerCase();

  for (const q of queries) {
    const url = `${BASE}/archivsuche?search=${encodeURIComponent(q)}&sort=order`;
    lastUrl = url;
    const r = await fetchPage('landesarchiv_nrw', url, { timeout: 20_000 });
    if (!r.ok) {
      if (r.status === 403 || r.status === 503) hadBlock = true;
      continue;
    }
    const html = r.html || r.text || '';
    const markdown = r.markdown || '';
    if (!html && !markdown) continue;

    // Trefferzahl aus Markdown ziehen ("N Ergebnisse für:")
    let countFromMd = null;
    const mnum = markdown.match(/(\d+)\s+Ergebnisse?\s+f(ü|u)r/i);
    if (mnum) countFromMd = parseInt(mnum[1], 10);

    try {
      const $ = cheerio.load(html || '');
      // Treffer-Erkennung: archive.nrw.de rendert Trefferkarten mit Archiv-Namen
      // + Vorgang/Findbuch-Titel + Volltext-Snippet. Robust: suche Links zum
      // Archiv-Detail (/archivsuche/vorgang/, /archivsuche/verzeichnungseinheit/).
      $('a[href*="/archivsuche/"]').each((_, el) => {
        const $a = $(el);
        const rawHref = ($a.attr('href') || '').trim();
        const linkText = ($a.text() || '').replace(/\s+/g, ' ').trim();
        if (!rawHref || !linkText || linkText.length < 4) return;
        if (!/\/archivsuche\/(vorgang|verzeichnungseinheit|findbuch|archiv)/i.test(rawHref)) return;
        const abs = rawHref.startsWith('http') ? rawHref : BASE + rawHref;
        if (seen.has(abs)) return;
        seen.add(abs);

        // Snippet: Umfeld
        let container = $a.closest('article, li, .result, .hit, .search-result');
        if (!container.length) container = $a.parent();
        const snippet = (container.text() || linkText).replace(/\s+/g, ' ').trim().slice(0, 400);

        // Qualitätsfilter: Nachname (oder Geburtsname) muss im Snippet vorkommen
        const haystack = snippet.toLowerCase();
        const matchesSurname = haystack.includes(surnameLc);
        const matchesBirth = birthNameLc && haystack.includes(birthNameLc);
        if (!matchesSurname && !matchesBirth) return;

        let confidence = 0.45;
        if (matchesSurname && matchesBirth) confidence += 0.1;
        // Direkter Archiv-Treffer (Vorgang/Verzeichnungseinheit) hochwerten
        if (/\/(vorgang|verzeichnungseinheit)/.test(rawHref)) confidence += 0.1;

        results.push({
          source: 'landesarchiv_nrw',
          title: linkText.slice(0, 140),
          url: abs,
          snippet,
          confidence: Math.min(1, confidence),
          payload: { archival_reference: true, matched_query: q, archive: LABEL },
        });
      });
    } catch { /* parsing error, continue */ }
  }

  if (!results.length) {
    if (hadBlock) return [needsFirecrawlCard('landesarchiv_nrw', LABEL, lastUrl, 'HTTP 403/503')];
    return [{
      source: 'landesarchiv_nrw',
      title: LABEL,
      url: lastUrl,
      snippet: `Keine Treffer im Landesarchiv NRW für "${full}".`,
      confidence: 0,
      payload: { empty: true, query: full },
    }];
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, 15);
}
