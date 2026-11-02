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
  const { given, firstGiven, surname, full } = nameParts(person);
  if (!full) return [];

  const location = (person.death_place || person.birth_place || '').trim();
  const params = new URLSearchParams({ name: full });
  if (location) params.set('location', location);
  const url = `https://www.trauer.de/suche?${params.toString()}`;

  const r = await fetchPage('trauer', url, { timeout: 12_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) {
      return [needsFirecrawlCard('trauer', LABEL, url, `HTTP ${r.status}`)];
    }
    return [{
      source: 'trauer',
      title: LABEL,
      url,
      snippet: `Zugriff fehlgeschlagen (${r.error})`,
      confidence: 0,
      payload: { error: r.error },
    }];
  }

  const html = r.html || r.text || '';
  try {
    const $ = cheerio.load(html);
    const birth = yearOf(person.birth_date);
    const death = yearOf(person.death_date);
    const surnameLc = surname.toLowerCase();
    const givenLc = firstGiven.toLowerCase();

    // Alle Links mit "/traueranzeige/" einsammeln, Host egal.
    const seen = new Set();
    const hits = [];
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

      // Nachname exakt nachfiltern (als Wortgrenze)
      const haystack = (linkText + ' ' + snippet).toLowerCase();
      if (!surnameLc) return;
      const surnameRe = new RegExp(`(^|[^a-z\u00e4\u00f6\u00fc\u00df])${surnameLc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z\u00e4\u00f6\u00fc\u00df]|$)`, 'i');
      if (!surnameRe.test(haystack)) return;

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
        payload: { obituary: true, link_text: linkText.slice(0, 160) },
      });
    });

    if (!hits.length) {
      return [{
        source: 'trauer',
        title: LABEL,
        url,
        snippet: 'Keine Nachrufe gefunden (nach Nachnamen-Filter).',
        confidence: 0,
        payload: { empty: true },
      }];
    }

    // Nach Confidence sortieren, Top 10
    hits.sort((a, b) => b.confidence - a.confidence);
    return hits.slice(0, 10);
  } catch (err) {
    return [{
      source: 'trauer',
      title: LABEL,
      url,
      snippet: 'Parsing-Fehler.',
      confidence: 0,
      payload: { error: err.message },
    }];
  }
}
