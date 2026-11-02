// ZEFYS — Zeitungsinformationssystem der Staatsbibliothek Berlin.
// Suche: https://zefys.staatsbibliothek-berlin.de/search/?query="<Name>"
// Die Overview-Seite listet nur Trefferzahlen pro Sammlung (z.B. "DDR-Presse: 1 Treffer")
// mit Link auf /search/<Sammlung>/?query=... — die Sammlungsseiten liefern 404.
// Daher: pro Sammlung mit N>0 EINE Zusammenfassungs-Karte bauen.

import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts } from '../http.js';

export const META = { label: 'ZEFYS Zeitungsarchiv', url: 'https://zefys.staatsbibliothek-berlin.de' };
const LABEL = 'ZEFYS Zeitungsarchiv';
const BASE = 'https://zefys.staatsbibliothek-berlin.de';

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  const quoted = `"${full}"`;
  const url = `${BASE}/search/?query=${encodeURIComponent(quoted)}`;

  const r = await fetchPage('zefys', url, { timeout: 12_000 });
  if (!r.ok) {
    if (r.status === 403 || r.status === 503) {
      return [needsFirecrawlCard('zefys', LABEL, url, `HTTP ${r.status}`)];
    }
    return [{
      source: 'zefys',
      title: LABEL,
      url,
      snippet: `Zugriff nicht moeglich (${r.error})`,
      confidence: 0,
      payload: { error: r.error },
    }];
  }

  const html = r.html || r.text || '';
  try {
    const $ = cheerio.load(html);

    // Pro Sammlung: Link auf /search/<Sammlung>/?query=... + Trefferzahl im Umfeld.
    // Beobachtet: "DDR-Presse (DDR Zeitungen): 1 Treffer" – Zahl liegt im gleichen Element
    // oder als Nachbartext.
    const collections = [];
    const seen = new Set();

    $('a[href*="/search/"]').each((_, el) => {
      const $a = $(el);
      const href = ($a.attr('href') || '').trim();
      if (!href) return;
      // Nur Links auf eine Sammlungs-Suche: /search/<slug>/?query=
      const m = href.match(/\/search\/([^/?]+)\/\?query=/);
      if (!m) return;
      const slug = m[1];
      if (seen.has(slug)) return;

      // Collection-Name = Link-Text ohne nachfolgenden ": N Treffer"
      const linkText = ($a.text() || '').replace(/\s+/g, ' ').trim();
      // Suche Trefferzahl im Link-Text oder im umgebenden Container
      let container = $a.closest('li, p, tr, div');
      if (!container.length) container = $a.parent();
      const ctxText = (container.text() || linkText).replace(/\s+/g, ' ').trim();
      const nmatch = ctxText.match(/(\d+)\s+Treffer/i);
      const n = nmatch ? parseInt(nmatch[1], 10) : 0;
      if (!n) return;

      seen.add(slug);
      // Collection-Name saeubern: alles vor ":" oder vor "(N Treffer)"
      let name = linkText.split(/:\s*\d+\s*Treffer/i)[0].trim();
      if (!name) name = slug;

      const abs = href.startsWith('http') ? href : BASE + href;
      // Confidence: 0.3 base + 0.1 pro zusaetzlichem Treffer, max 0.7
      const confidence = Math.min(0.7, 0.3 + 0.1 * (n - 1));

      collections.push({
        source: 'zefys',
        title: `${n} Treffer in ${name}`,
        url: abs,
        snippet: `${name}: ${n} ${n === 1 ? 'Treffer' : 'Treffer'} fuer ${quoted}. Direkt-Link auf die Sammlungsseite — moeglicherweise 404, dann ueber die ZEFYS-Hauptsuche.`,
        confidence,
        payload: { collection: name, slug, count: n, query: quoted },
      });
    });

    if (!collections.length) {
      return [{
        source: 'zefys',
        title: LABEL,
        url,
        snippet: `Keine Treffer in ZEFYS fuer ${quoted}.`,
        confidence: 0,
        payload: { empty: true, query: quoted },
      }];
    }

    collections.sort((a, b) => (b.payload.count || 0) - (a.payload.count || 0));
    return collections;
  } catch (err) {
    return [{
      source: 'zefys',
      title: LABEL,
      url,
      snippet: 'Parsing-Fehler',
      confidence: 0,
      payload: { error: err.message },
    }];
  }
}
