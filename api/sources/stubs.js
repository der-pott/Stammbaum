// Research-source stubs — placeholders for later integration.
// Each exports a `search(person)` returning [] for now, plus metadata so the
// UI can list them.

export const SOURCES = [
  {
    key: 'familysearch',
    label: 'FamilySearch',
    url: 'https://www.familysearch.org',
    note: 'OAuth-Flow nötig: https://www.familysearch.org/developers',
  },
  {
    key: 'archion',
    label: 'Archion (ev. Kirchenbücher)',
    url: 'https://www.archion.de',
    note: 'Login erforderlich, kein öffentliches API',
  },
  {
    key: 'matricula',
    label: 'Matricula (kath. Kirchenbücher)',
    url: 'https://data.matricula-online.eu',
    note: 'Kein API, Scraping notwendig',
  },
  {
    key: 'gedbas',
    label: 'GEDBAS (compgen.de)',
    url: 'http://gedbas.genealogy.net',
    note: 'Legacy-API, HTML-Suche',
  },
  {
    key: 'zefys',
    label: 'ZEFYS Zeitungsarchiv',
    url: 'https://zefys.staatsbibliothek-berlin.de',
    note: 'OAI-PMH / HTML-Suche',
  },
  {
    key: 'billiongraves',
    label: 'BillionGraves / Find a Grave',
    url: 'https://billiongraves.com',
    note: 'API-Key erforderlich',
  },
  {
    key: 'arcinsys',
    label: 'Arcinsys (Dt. Landesarchive)',
    url: 'https://www.arcinsys.de',
    note: 'HTML-Suche, kein API',
  },
  {
    key: 'ddb',
    label: 'Deutsche Digitale Bibliothek',
    url: 'https://api.deutsche-digitale-bibliothek.de',
    note: 'API-Key empfohlen, offene Suche möglich',
  },
];

export async function search(_person, _source) {
  // All stubs return empty for now.
  return [];
}
