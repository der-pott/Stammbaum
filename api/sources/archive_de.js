// Deutsche Archive — Sammel-Scraper für Landesarchive ohne eigenen Scraper
// sowie zentrale Portale (Archivportal-D, Bundesarchiv-Invenio).
//
// Zwei-Stufen-Ansatz:
//  1) Firecrawl-SEARCH mit `"<name>" site:<archiv-host>` je Portal. Liefert
//     Treffer wenn Firecrawl den Host indexiert hat.
//  2) Fallback: Pro Portal eine Verweis-Karte mit Portal-Startseite als URL
//     und Hinweis, dort manuell weiterzusuchen. Hält den Workflow sichtbar
//     ohne Portal-eigene URL-Patterns zu kennen (die ohnehin instabil sind).
//
// Spezielle Scraper mit eigener Parsing-Logik:
//  - landesarchiv_berlin (findbuch.net API)
//  - landesarchiv_nrw (archive.nrw.de Volltextsuche)
//  - arcinsys (Hessen + Niedersachsen+Bremen über geteiltes System)
// Diese BL hier bewusst NICHT doppelt listen.

import { nameParts } from '../http.js';
import { webSearch, noBackendHit } from '../search_backend.js';

export const META = { label: 'Deutsche Archive (BL-Portale)', url: 'https://www.archivportal-d.de' };

// Portale mit öffentlicher Online-Recherche.
// Deep-Link = eine URL die bei manueller Nutzung direkt in die Suche führt
// (soweit stabil). Fallback = Portal-Startseite.
const PORTALS = [
  // Bundesweit
  { key: 'archivportal_d', land: 'Bund',                label: 'Archivportal-D',             host: 'www.archivportal-d.de',       deepLink: name => `https://www.archivportal-d.de/searchresults?query=${encodeURIComponent(name)}` },
  { key: 'bundesarchiv',   land: 'Bund',                label: 'Bundesarchiv (Invenio)',     host: 'invenio.bundesarchiv.de',     deepLink: () => 'https://invenio.bundesarchiv.de/' },
  // Landesarchive (Berlin, NRW, Hessen/Nds/Bremen über eigene Scraper)
  { key: 'la_bw',          land: 'Baden-Württemberg',   label: 'Landesarchiv Baden-Württemberg', host: 'www.landesarchiv-bw.de',  deepLink: () => 'https://www.landesarchiv-bw.de/olf/' },
  { key: 'la_by',          land: 'Bayern',              label: 'Staatliche Archive Bayerns', host: 'www.gda.bayern.de',           deepLink: () => 'https://www.gda.bayern.de/findmittel/' },
  { key: 'la_bb',          land: 'Brandenburg',         label: 'BLHA Brandenburg',           host: 'blha-recherche.brandenburg.de', deepLink: () => 'https://blha-recherche.brandenburg.de/' },
  { key: 'la_hh',          land: 'Hamburg',             label: 'Staatsarchiv Hamburg',       host: 'www.hamburg.de',              deepLink: () => 'https://www.hamburg.de/behoerden/staatsarchiv/' },
  { key: 'la_mv',          land: 'Mecklenburg-Vorpommern', label: 'Landeshauptarchiv Schwerin', host: 'www.landeshauptarchiv.de', deepLink: () => 'https://www.landeshauptarchiv.de/' },
  { key: 'la_rlp',         land: 'Rheinland-Pfalz',     label: 'Landesarchiv Rheinland-Pfalz', host: 'apertus.rlp.de',            deepLink: () => 'https://apertus.rlp.de/' },
  { key: 'la_sl',          land: 'Saarland',            label: 'Landesarchiv Saarland',      host: 'www.saarland.de',             deepLink: () => 'https://www.saarland.de/stk/DE/portale/landesarchiv/_node.html' },
  { key: 'la_sn',          land: 'Sachsen',             label: 'Sächsisches Staatsarchiv',   host: 'archiv.sachsen.de',           deepLink: name => `https://archiv.sachsen.de/suche-?search=${encodeURIComponent(name)}` },
  { key: 'la_st',          land: 'Sachsen-Anhalt',      label: 'Landesarchiv Sachsen-Anhalt', host: 'landesarchiv.sachsen-anhalt.de', deepLink: () => 'https://landesarchiv.sachsen-anhalt.de/' },
  { key: 'la_sh',          land: 'Schleswig-Holstein',  label: 'Landesarchiv Schleswig-Holstein', host: 'www.landesarchiv.sh',    deepLink: () => 'https://www.landesarchiv.sh/' },
  { key: 'la_th',          land: 'Thüringen',           label: 'Landesarchiv Thüringen',     host: 'www.thueringen.de',           deepLink: () => 'https://www.thueringen.de/th2/staatsarchive/' },
];

const MAX_VARIANTS = 2;
const RESULTS_PER_PORTAL = 3;

export async function search(person) {
  const { full, variants, surname } = nameParts(person);
  if (!full) return [];
  if (!surname) return [];
  const queries = (variants.length ? variants : [{ name: full, primary: true }])
    .slice(0, MAX_VARIANTS)
    .map(v => v.name);

  const results = [];
  const seen = new Set();
  const surnameLc = surname.toLowerCase();
  let noBackend = false;

  for (const portal of PORTALS) {
    const portalHits = [];
    for (const q of queries) {
      const r = await webSearch({ query: `"${q}" site:${portal.host}`, limit: 5 });
      if (!r.ok) {
        if (r.error === 'no_backend') { noBackend = true; break; }
        continue;
      }
      for (const h of (r.hits || [])) {
        const u = (h.url || '').toLowerCase();
        if (!u.includes(portal.host.toLowerCase())) continue;
        if (seen.has(u)) continue;
        // Qualitätsfilter: Nachname im Titel/Snippet
        const hay = ((h.title || '') + ' ' + (h.snippet || '')).toLowerCase();
        if (!hay.includes(surnameLc)) continue;
        seen.add(u);
        portalHits.push({
          source: 'archive_de',
          title: `${portal.label}: ${(h.title || '').slice(0, 110)}`,
          url: h.url,
          snippet: (h.snippet || '').slice(0, 300),
          confidence: 0.5,
          payload: {
            archival_reference: true,
            portal: portal.key,
            land: portal.land,
            matched_query: q,
          },
        });
        if (portalHits.length >= RESULTS_PER_PORTAL) break;
      }
      if (portalHits.length >= RESULTS_PER_PORTAL) break;
    }

    if (portalHits.length) {
      results.push(...portalHits);
    } else if (!noBackend) {
      // Portal-Hinweis-Karte: direkt-Link, user kann manuell nachsehen
      const deep = portal.deepLink(full);
      results.push({
        source: 'archive_de',
        title: `${portal.label} — manuelle Suche`,
        url: deep,
        snippet: `Firecrawl-Index hat keinen Treffer für "${full}" auf ${portal.host}. Portal-Suche manuell öffnen (${portal.land}).`,
        confidence: 0.1,
        payload: {
          archival_reference: true,
          portal: portal.key,
          land: portal.land,
          manual_hint: true,
        },
      });
    }
  }

  if (noBackend && !results.length) {
    return [noBackendHit('archive_de', META.label)];
  }
  // Hinweis-Karten (confidence 0.1) nur zeigen wenn gar keine echten Treffer da
  const real = results.filter(r => r.confidence > 0.2);
  const hints = results.filter(r => r.confidence <= 0.2);
  const out = real.length ? real : hints.slice(0, 5);  // bei 0 Treffern nur Top-5 Hint-Karten
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, 20);
}
