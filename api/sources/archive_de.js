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

// archive_de ist bewusst OFFLINE: liefert sofort pro Portal eine Verweis-Karte
// mit Deep-Link zur Portal-Suche (soweit stabil) oder zur Portal-Startseite.
// Grund: 12 Portale × Firecrawl-Suche pro Variante würde das 90s-Timeout
// sprengen, und der Firecrawl-Index deckt die wenigsten Archiv-Hosts gut ab.
// So bleibt die Recherche-Übersicht vollständig und der Nutzer öffnet selbst,
// was ihn interessiert. Spezielle Scraper (Berlin, NRW, Arcinsys) liefern
// weiterhin echte Treffer über ihre eigenen Source-Keys.
export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!full || !surname) return [];

  const results = PORTALS.map(portal => ({
    source: 'archive_de',
    title: `${portal.label} — ${portal.land}`,
    url: portal.deepLink(full),
    snippet: `Portal manuell öffnen und nach "${full}" suchen. Deckt ${portal.land === 'Bund' ? 'bundesweit' : portal.land} ab.`,
    confidence: 0.1,
    payload: {
      archival_reference: true,
      portal: portal.key,
      land: portal.land,
      manual_hint: true,
      host: portal.host,
    },
  }));
  return results;
}

// Dummy-Imports verwenden, damit ESLint/Linter nicht meckert und spätere
// Rück-Aktivierung des Firecrawl-Suchpfads einfach bleibt.
void webSearch; void noBackendHit;
