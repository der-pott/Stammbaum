// Research dispatcher — fans out a person-lookup to all registered sources,
// honors per-source cache (7 days), reports per-source statuses, and persists
// results via the caller.

import { db, nowIso } from './db.js';

import * as wikidata from './sources/wikidata.js';
import * as familysearch from './sources/familysearch.js';
import * as archion from './sources/archion.js';
import * as matricula from './sources/matricula.js';
import * as gedbas from './sources/gedbas.js';
import * as zefys from './sources/zefys.js';
import * as billiongraves from './sources/billiongraves.js';
import * as arcinsys from './sources/arcinsys.js';
import * as ddb from './sources/ddb.js';
import * as dnb from './sources/dnb.js';
import * as openlibrary from './sources/openlibrary.js';
import * as viaf from './sources/viaf.js';
import * as crossref from './sources/crossref.js';
import * as volksbund from './sources/volksbund.js';
import * as stolpersteine from './sources/stolpersteine.js';
import * as wikipedia_en from './sources/wikipedia_en.js';
import * as archive_org from './sources/archive_org.js';
import * as duckduckgo from './sources/duckduckgo.js';
import * as linkedin from './sources/linkedin.js';
import * as xing from './sources/xing.js';
import * as press from './sources/press.js';
import * as reddit from './sources/reddit.js';
import * as github from './sources/github.js';
import * as googlebooks from './sources/googlebooks.js';
import * as mastodon from './sources/mastodon.js';
import * as googlecse from './sources/googlecse.js';
import * as zlb_adressbuecher from './sources/zlb_adressbuecher.js';
import * as landesarchiv_berlin from './sources/landesarchiv_berlin.js';
import * as trauer from './sources/trauer.js';
import * as gedenkseiten from './sources/gedenkseiten.js';
import * as onlinegedenken from './sources/onlinegedenken.js';
import * as geneanet from './sources/geneanet.js';
import * as europeana from './sources/europeana.js';
import * as web_dossier from './sources/web_dossier.js';
import * as web_images from './sources/web_images.js';
import { activeBackend } from './search_backend.js';

const WEB_SEARCH_AVAILABLE = !!activeBackend();
if (!WEB_SEARCH_AVAILABLE) {
  console.warn('[research] No web-search backend configured. Set BRAVE_SEARCH_API_KEY (or SERPER_API_KEY) in .env to enable duckduckgo/linkedin/xing/press sources.');
}

export const SOURCES = {
  web_dossier:   { label: 'Web-Dossier (Multi-Query + Deep-Scrape)', impl: web_dossier.search, active: true, timeout: 90_000, note: WEB_SEARCH_AVAILABLE ? 'bis zu 12 Queries, Firecrawl-Volltext der Top-5' : 'braucht BRAVE_SEARCH_API_KEY oder GOOGLE_CSE_API_KEY' },
  web_images:    { label: 'Bild-Recherche (Firecrawl)',            impl: web_images.search, active: !!process.env.FIRECRAWL_URL, timeout: 60_000, note: process.env.FIRECRAWL_URL ? 'bis zu 8 Image-Queries, dedupe + Multi-Match-Scoring' : 'braucht FIRECRAWL_URL' },
  wikidata:      { label: 'Wikidata / Wikipedia (DE)', impl: wikidata.search, active: true },
  familysearch:  { label: 'FamilySearch (öffentlich)',   impl: familysearch.search, active: true },
  archion:       { label: 'Archion (ev. Kirchenbücher)', impl: archion.search, active: true, note: 'Paywall' },
  matricula:     { label: 'Matricula (kath. Kirchenbücher)', impl: matricula.search, active: true },
  gedbas:        { label: 'GEDBAS (compgen.de)',         impl: gedbas.search, active: true },
  zefys:         { label: 'ZEFYS Zeitungsarchiv',        impl: zefys.search, active: true },
  billiongraves: { label: 'BillionGraves',               impl: billiongraves.search, active: true },
  arcinsys:      { label: 'Arcinsys (Landesarchive)',    impl: arcinsys.search, active: true },
  ddb:           { label: 'Deutsche Digitale Bibliothek', impl: ddb.search, active: true },
  dnb:           { label: 'Deutsche Nationalbibliothek', impl: dnb.search, active: true },
  openlibrary:   { label: 'Open Library',                impl: openlibrary.search, active: true },
  viaf:          { label: 'VIAF (Authority File)',       impl: viaf.search, active: true },
  crossref:      { label: 'CrossRef (Publikationen)',    impl: crossref.search, active: true },
  volksbund:     { label: 'Volksbund (Kriegsgräber)',    impl: volksbund.search, active: true, note: 'nur bei Kriegsjahr-Datum' },
  stolpersteine: { label: 'Stolpersteine (NS-Opfer)',    impl: stolpersteine.search, active: true, note: 'nur bei NS-Kontext' },
  wikipedia_en:  { label: 'Wikipedia (EN)',              impl: wikipedia_en.search, active: true },
  archive_org:   { label: 'Internet Archive',            impl: archive_org.search, active: true },
  duckduckgo:    { label: 'Web (allgemein)',             impl: duckduckgo.search, active: true, note: WEB_SEARCH_AVAILABLE ? null : 'braucht BRAVE_SEARCH_API_KEY' },
  linkedin:      { label: 'LinkedIn (öffentlich)',       impl: linkedin.search, active: true, note: WEB_SEARCH_AVAILABLE ? 'nur Lebende / nach 1990' : 'braucht BRAVE_SEARCH_API_KEY' },
  xing:          { label: 'Xing (öffentlich)',           impl: xing.search, active: true, note: WEB_SEARCH_AVAILABLE ? 'nur Lebende / nach 1990' : 'braucht BRAVE_SEARCH_API_KEY' },
  press:         { label: 'Presse (Portal + OpenPR)',    impl: press.search, active: true, note: WEB_SEARCH_AVAILABLE ? null : 'braucht BRAVE_SEARCH_API_KEY' },
  googlecse:     { label: 'Google (via CSE)',            impl: googlecse.search, active: googlecse.isConfigured(), note: googlecse.isConfigured() ? null : 'braucht GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX' },
  reddit:        { label: 'Reddit',                      impl: reddit.search, active: true },
  github:        { label: 'GitHub',                      impl: github.search, active: true, note: 'nur Lebende / nach 1990' },
  googlebooks:   { label: 'Google Books',                impl: googlebooks.search, active: true },
  mastodon:      { label: 'Mastodon',                    impl: mastodon.search, active: true, note: 'nur Lebende / nach 1990' },
  // --- Deutsche Archive & Nachrufe (Firecrawl-ready) -----------------------
  zlb_adressbuecher:   { label: 'Berliner Adressbuecher 1799-1943 (ZLB)', impl: zlb_adressbuecher.search, active: true, note: 'nur bei Berlin-Bezug' },
  landesarchiv_berlin: { label: 'Landesarchiv Berlin',                     impl: landesarchiv_berlin.search, active: true, timeout: 75_000, note: 'Session-Suche, langsam (bis 60s)' },
  trauer:              { label: 'Trauer.de (Nachrufe)',                    impl: trauer.search, active: true, note: 'nur nach 1990' },
  gedenkseiten:        { label: 'Gedenkseiten.de',                         impl: gedenkseiten.search, active: true, note: 'nur nach 1990' },
  onlinegedenken:      { label: 'Online Gedenken',                         impl: onlinegedenken.search, active: true, note: 'nur nach 1990' },
  geneanet:            { label: 'Geneanet (oeffentlich)',                  impl: geneanet.search, active: true },
  europeana:           { label: 'Europeana',                               impl: europeana.search, active: !!process.env.EUROPEANA_API_KEY, note: process.env.EUROPEANA_API_KEY ? null : 'braucht EUROPEANA_API_KEY' },
};

// Only active sources are fanned out by default; inactive ones are listed via
// `listSources()` so the UI can show "needs config" cells.
const DEFAULT_SOURCE_KEYS = Object.entries(SOURCES).filter(([, s]) => s.active).map(([k]) => k);
const PER_SOURCE_TIMEOUT = 15_000;
const CACHE_TTL_MS = 7 * 24 * 3600_000;

export function listSources() {
  return Object.entries(SOURCES).map(([key, s]) => ({ key, label: s.label, active: s.active, note: s.note || null }));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label} after ${ms}ms`)), ms)),
  ]);
}

async function callSource(key, person) {
  const src = SOURCES[key];
  if (!src) return { key, hits: [], status: 'unknown' };
  try {
    const timeout = src.timeout || PER_SOURCE_TIMEOUT;
    const hits = await withTimeout(Promise.resolve().then(() => src.impl(person)), timeout, key);
    return { key, hits: (hits || []).map(h => ({ ...h, source: h.source || key })), status: 'done' };
  } catch (err) {
    return { key, hits: [], status: 'failed', error: err?.message || String(err) };
  }
}

function readCache(sourceKey, personId) {
  const row = db.prepare('SELECT payload, fetched_at FROM research_cache WHERE source=? AND person_id=?').get(sourceKey, personId);
  if (!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (age > CACHE_TTL_MS) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

function writeCache(sourceKey, personId, hits) {
  db.prepare('INSERT INTO research_cache (source, person_id, payload, fetched_at) VALUES (?,?,?,?) ON CONFLICT(source, person_id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at')
    .run(sourceKey, personId, JSON.stringify(hits), nowIso());
}

export async function runSingleSource(sourceKey, person, { useCache = true } = {}) {
  if (useCache) {
    const cached = readCache(sourceKey, person.id);
    if (cached) return { key: sourceKey, hits: cached, status: 'cached' };
  }
  const result = await callSource(sourceKey, person);
  if (result.status === 'done') writeCache(sourceKey, person.id, result.hits);
  return result;
}

// Run all configured sources in parallel. onStatus(key, state) called per source
// transitions: 'running' → 'done'|'failed'|'cached'.
export async function dispatchResearch(person, { sourceKeys = DEFAULT_SOURCE_KEYS, onStatus = () => {}, useCache = true } = {}) {
  const results = {};
  await Promise.all(sourceKeys.map(async key => {
    onStatus(key, { state: 'running' });
    const r = await runSingleSource(key, person, { useCache });
    results[key] = r;
    onStatus(key, { state: r.status, count: r.hits.length, error: r.error || null });
  }));
  // Flat list of hits
  const flat = [];
  for (const key of sourceKeys) {
    for (const h of results[key]?.hits || []) flat.push(h);
  }
  flat.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return { results, hits: flat };
}
