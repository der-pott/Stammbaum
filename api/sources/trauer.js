// trauer.de — Nachrufe/Traueranzeigen online.
// Online-Zeitalter: post-1990 (vorher: pre_digital skip).
//
// Suche: https://www.trauer.de/suche?name=<Vorname Nachname>&location=<Ort>
// Trefferlinks fuehren auf Partnerportale wie trauer-in-nrw.de/traueranzeige/...
// oder hna.trauer.de/traueranzeige/... — alle "/traueranzeige/"-Links uebernehmen,
// egal welcher Host.
// Nachsuche ist unscharf (findet Potthoff, Poetter): Nachnamen exakt nachfiltern.

import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'Trauer.de', url: 'https://www.trauer.de' };
const LABEL = 'Trauer.de (Nachrufe)';

export async function search(person) {
  if (isPreDigital(person)) {
    return [{
      source: 'trauer',
      title: LABEL,
      url: META.url,
      snippet: 'uebersprungen (vor Online-Nachrufe-Zeitalter).',
      confidence: 0,
      payload: { skipped: 'pre_digital' },
    }];
  }
  const { given, firstGiven, surname, full, variants, birthName } = nameParts(person);
  if (!full) return [];

  const location = (person.death_place || person.birth_place || '').trim();
  // Trauer.de nachsuchen über alle sinnvollen Namensvarianten (Doppelnamen,
  // einzelne Vornamen, Geburtsname). Nachname-Trefferfilter weiter unten
  // akzeptiert sowohl aktuellen Nachnamen als auch Geburtsnamen.
  const queries = variants.slice(0, 5).map(v => v.name);
  if (!queries.length) queries.push(full);

  const birth = yearOf(person.birth_date);
  const death = yearOf(person.death_date);
  const givenLc = firstGiven.toLowerCase();
  const surnameLc = surname.toLowerCase();
  const birthNameLc = (birthName || '').toLowerCase();
  const seen = new Set();
  const hits = [];
  let lastError = null;
  let lastUrl = '';

  for (const q of queries) {
    const params = new URLSearchParams({ name: q });
    if (location) params.set('location', location);
    const url = `https://www.trauer.de/suche?${params.toString()}`;
    lastUrl = url;

    const r = await fetchPage('trauer', url, { timeout: 12_000 });
    if (!r.ok) {
      if (r.status === 403 || r.status === 503) {
        return [needsFirecrawlCard('trauer', LABEL, url, `HTTP ${r.status}`)];
      }
      lastError = r.error;
      continue;
    }
    const html = r.html || r.text || '';
    try {
      const $ = cheerio.load(html);
    // Alle Links mit "/traueranzeige/" einsammeln, Host egal.
    $('a[href*="/traueranzeige/"]').each((_, el) => {
      const $a = $(el);
      const rawHref = ($a.attr('href') || '').trim();
      if (!rawHref) return;
      // Absolute URL ableiten
      let abs = rawHref;
      if (rawHref.startsWith('/')) abs = 'https://www.trauer.de' + rawHref;
      else if (!rawHref.startsWith('http')) return;
      if (seen.has(abs)) return;
      seen.add(abs);

      const linkText = ($a.text() || '').replace(/\s+/g, ' ').trim();
      // Snippet: Umfeld-Container
      let container = $a.closest('article, li, .search-result, .obit, .teaser, .result');
      if (!container.length) container = $a.parent();
      const snippet = (container.text() || linkText).replace(/\s+/g, ' ').trim().slice(0, 280);

      // Nachname (oder Geburtsname) exakt nachfiltern (als Wortgrenze)
      const haystack = (linkText + ' ' + snippet).toLowerCase();
      if (!surnameLc) return;
      const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const surnameRe = new RegExp(`(^|[^a-zäöüß])${escape(surnameLc)}([^a-zäöüß]|$)`, 'i');
      const birthNameRe = birthNameLc
        ? new RegExp(`(^|[^a-zäöüß])${escape(birthNameLc)}([^a-zäöüß]|$)`, 'i')
        : null;
      const nameMatch = surnameRe.test(haystack) || (birthNameRe && birthNameRe.test(haystack));
      if (!nameMatch) return;

      // Confidence
      let confidence = 0.5; // Nachname match
      if (givenLc && haystack.includes(givenLc)) confidence += 0.2;
      const yrs = snippet.match(/\b(1[89]\d{2}|20\d{2})\b/g) || [];
      if (yrs.some(y => (birth && Math.abs(+y - birth) <= 2) || (death && Math.abs(+y - death) <= 2))) {
        confidence += 0.2;
      }
      confidence = Math.min(1, confidence);

      hits.push({
        source: 'trauer',
        title: (linkText || 'Traueranzeige').slice(0, 120),
        url: abs,
        snippet,
        confidence,
        payload: { obituary: true, link_text: linkText.slice(0, 160), matched_query: q },
      });
    });
    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  if (!hits.length) {
    if (lastError) {
      return [{
        source: 'trauer',
        title: LABEL,
        url: lastUrl,
        snippet: `Zugriff fehlgeschlagen (${lastError})`,
        confidence: 0,
        payload: { error: lastError },
      }];
    }
    return [{
      source: 'trauer',
      title: LABEL,
      url: lastUrl,
      snippet: 'Keine Nachrufe gefunden (nach Nachnamen-Filter).',
      confidence: 0,
      payload: { empty: true },
    }];
  }

  hits.sort((a, b) => b.confidence - a.confidence);
  return hits.slice(0, 10);
}
