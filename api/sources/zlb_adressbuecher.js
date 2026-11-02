// ZLB Berliner Adressbuecher 1799-1943 — digitalisierte Namensverzeichnisse.
// Berlin-Fokus: nur sinnvoll wenn Person Berlin-Bezug hat.
import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts, yearOf } from '../http.js';

export const META = { label: 'Berliner Adressbuecher 1799-1943 (ZLB)', url: 'https://digital.zlb.de' };
const LABEL = 'Berliner Adressbuecher (ZLB)';

function hasBerlinContext(person) {
  const bits = [person.birth_place, person.death_place, person.notes || '']
    .filter(Boolean).join(' ').toLowerCase();
  return /berlin|charlottenburg|schoeneberg|schöneberg|tegel|moabit|haselhorst|siemensstadt|spandau|britz|tiergarten/.test(bits);
}

export async function search(person) {
  const { surname, full } = nameParts(person);
  if (!surname) return [];
  if (!hasBerlinContext(person)) {
    return [{
      source: 'zlb_adressbuecher',
      title: LABEL,
      url: META.url,
      snippet: 'uebersprungen (kein Berlin-Bezug in Lebensdaten).',
      confidence: 0,
      payload: { skipped: 'no_berlin_context' },
    }];
  }
  const url = `https://digital.zlb.de/viewer/search/-/${encodeURIComponent(surname)}/1/-/-/`;
  const r = await fetchPage('zlb_adressbuecher', url, { timeout: 10_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) {
      return [needsFirecrawlCard('zlb_adressbuecher', LABEL, url, `HTTP ${r.status}`)];
    }
    return [{ source: 'zlb_adressbuecher', title: LABEL, url, snippet: `Zugriff fehlgeschlagen (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const html = r.html || r.text || '';
  if (!html) return [{ source: 'zlb_adressbuecher', title: LABEL, url, snippet: 'Leere Antwort.', confidence: 0, payload: { empty: true } }];

  try {
    const $ = cheerio.load(html);
    const birth = yearOf(person.birth_date);
    const death = yearOf(person.death_date);
    const results = [];
    // ZLB Viewer renders hits as .hit or .search-list-entry or generic a[href*="/viewer/image/"]
    const hits = $('.hit, .search-list-entry, article.hit, .viewer-hit').slice(0, 8);
    hits.each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, h4, .hit-title, a').first().text() || '').trim().replace(/\s+/g, ' ');
      const link = $el.find('a[href]').first().attr('href') || '';
      const snippet = ($el.text() || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!title) return;
      const abs = link.startsWith('http') ? link : 'https://digital.zlb.de' + link;
      let confidence = 0.5; // Nachname + Berlin
      const yrMatch = snippet.match(/\b(1[7-9]\d{2}|20\d{2})\b/g);
      if (yrMatch && (birth || death)) {
        for (const y of yrMatch) {
          const yi = parseInt(y, 10);
          if ((birth && Math.abs(yi - birth) <= 5) || (death && Math.abs(yi - death) <= 5)) {
            confidence = Math.min(1, confidence + 0.2);
            break;
          }
        }
      }
      results.push({
        source: 'zlb_adressbuecher',
        title: title.slice(0, 120),
        url: abs,
        snippet,
        confidence,
        payload: { adressbuch: true },
      });
    });
    if (!results.length) {
      // Try link anchors as fallback
      $('a[href*="/viewer/image/"]').slice(0, 5).each((_, el) => {
        const $a = $(el);
        const title = ($a.text() || '').trim().replace(/\s+/g, ' ');
        const link = $a.attr('href') || '';
        if (!title || title.length < 3) return;
        results.push({
          source: 'zlb_adressbuecher',
          title: title.slice(0, 120),
          url: link.startsWith('http') ? link : 'https://digital.zlb.de' + link,
          snippet: '',
          confidence: 0.4,
          payload: { adressbuch: true, loose_match: true },
        });
      });
    }
    if (!results.length) {
      return [{ source: 'zlb_adressbuecher', title: LABEL, url, snippet: 'Keine Treffer in Berliner Adressbuechern.', confidence: 0, payload: { empty: true } }];
    }
    return results;
  } catch (err) {
    return [{ source: 'zlb_adressbuecher', title: LABEL, url, snippet: 'Parsing-Fehler.', confidence: 0, payload: { error: err.message } }];
  }
}
