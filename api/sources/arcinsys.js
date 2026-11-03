// Arcinsys — Geteiltes System der Landesarchive Hessen, Niedersachsen+Bremen und Thüringen.
// Durchsucht alle verfügbaren Arcinsys-Instanzen gleichzeitig.
//
// URL-Pattern: https://arcinsys.<land>.de/arcinsys/recherche/overview.action?q=<name>
// Scrape via Firecrawl (Playwright), da serverseitig JS gerendert.
// Nutzt Namens-Varianten (Doppelnamen, Mehrfach-Vornamen, Geburtsname) aus nameParts.

import * as cheerio from 'cheerio';
import { fetchPage, needsFirecrawlCard } from '../scrape_fetcher.js';
import { nameParts } from '../http.js';

export const META = { label: 'Arcinsys (Hessen, Niedersachsen, Thüringen)', url: 'https://arcinsys.hessen.de' };

// Verifiziert erreichbare Arcinsys-Instanzen (2026-11).
// Thüringen (arcinsys.thueringen.de) ist aktuell nicht erreichbar — bei Comeback hier wieder einfügen.
const INSTANCES = [
  { key: 'hessen',       label: 'Hessen',               host: 'arcinsys.hessen.de' },
  { key: 'niedersachsen', label: 'Niedersachsen+Bremen', host: 'www.arcinsys.niedersachsen.de' },
];

const MAX_VARIANTS = 3;
const RESULTS_PER_VARIANT = 8;

export async function search(person) {
  const { surname, full, variants } = nameParts(person);
  if (!surname) return [];
  const queries = (variants.length ? variants : [{ name: full, primary: true }])
    .slice(0, MAX_VARIANTS)
    .map(v => v.name);

  const results = [];
  const seen = new Set();
  let hadBlock = false;

  for (const inst of INSTANCES) {
    for (const q of queries) {
      const url = `https://${inst.host}/arcinsys/recherche/overview.action?q=${encodeURIComponent(q)}`;
      const r = await fetchPage('arcinsys', url, { timeout: 15_000 });
      if (!r.ok) {
        if (r.status === 403 || r.status === 503) hadBlock = true;
        continue;
      }
      const html = r.html || r.text || '';
      if (!html) continue;
      try {
        const $ = cheerio.load(html);
        // Arcinsys HTML: Trefferlinks tragen /arcinsys/detailAction.action?id=... oder ähnlich.
        // Robuste Erkennung: alle Links die /arcinsys/ enthalten und einen Titel haben.
        $('a[href*="/arcinsys/"]').each((_, el) => {
          const $a = $(el);
          const rawHref = ($a.attr('href') || '').trim();
          const title = ($a.text() || '').replace(/\s+/g, ' ').trim();
          if (!rawHref || !title || title.length < 5) return;
          // Nur Treffer-Links, nicht Navigation
          if (!/detail|showcase|verzeichnungseinheit|bestand/i.test(rawHref)) return;
          const abs = rawHref.startsWith('http') ? rawHref : `https://${inst.host}${rawHref}`;
          if (seen.has(abs)) return;
          seen.add(abs);

          // Treffer muss Nachnamen enthalten (grober Qualitätsfilter)
          const haystack = title.toLowerCase();
          if (!haystack.includes(surname.toLowerCase())) return;

          // Snippet aus Umfeld
          let container = $a.closest('li, tr, .hit, .result');
          if (!container.length) container = $a.parent();
          const snippet = (container.text() || title).replace(/\s+/g, ' ').trim().slice(0, 260);

          results.push({
            source: 'arcinsys',
            title: `${inst.label}: ${title.slice(0, 100)}`,
            url: abs,
            snippet,
            confidence: 0.5,
            payload: { archival_reference: true, instance: inst.key, query: q },
          });
        });
      } catch { /* parsing error, continue */ }
      if (results.length >= RESULTS_PER_VARIANT * INSTANCES.length) break;
    }
  }

  if (!results.length) {
    if (hadBlock) {
      return [needsFirecrawlCard('arcinsys', META.label, META.url, 'HTTP 403/503')];
    }
    return [{
      source: 'arcinsys',
      title: META.label,
      url: META.url,
      snippet: 'Keine Treffer in Arcinsys-Portalen.',
      confidence: 0,
      payload: { empty: true, instances: INSTANCES.map(i => i.key) },
    }];
  }

  // Dedup nach URL + sortieren
  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, 20);
}
