// Dossier-orientierte Web-Recherche. Multi-Query gegen Google CSE +
// Firecrawl-Scrape der Top-URLs, so dass die Volltexte für die
// nachgelagerte AI-Review-Analyse zur Verfügung stehen.
//
// Ziel: möglichst vollständiges Dossier aufbauen, nicht nur Treffer-Liste.
// Jede Query zielt auf einen anderen biographischen Aspekt (Beruf,
// Wohnort, Nachruf, Verein, Publikation, Social, Alumni, …).

import { nameParts, yearOf } from '../http.js';
import { webSearch } from '../search_backend.js';
import { fetchPage } from '../scrape_fetcher.js';

export const META = { label: 'Web-Dossier (Multi-Query + Deep-Scrape)', url: 'https://www.google.com' };

const MAX_URLS_TO_SCRAPE = 5;
const MAX_MARKDOWN_CHARS = 10_000;
const SCRAPE_TIMEOUT = 10_000;

// Suchmaschinen-Operator-Hygiene: Facebook/LinkedIn/Xing-Profile oft hinter
// Login-Walls — Snippet reicht, nicht scrapen.
const NO_SCRAPE_HOSTS = /(?:^|\.)(facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|xing\.com|tiktok\.com)$/i;

function buildQueries(person) {
  const { full, firstGiven, surname } = nameParts(person);
  if (!full) return [];
  const name = `"${full}"`;
  const birthPlace = (person.birth_place || '').trim();
  const deathPlace = (person.death_place || '').trim();
  const title = (person.title || '').trim();
  const birth = yearOf(person.birth_date);
  const death = yearOf(person.death_date);
  const residences = (person.residences || [])
    .map(r => (r.city || r.place || '').split(',')[0].trim())
    .filter(Boolean);
  const jobs = (person.jobs || []).filter(j => j.title || j.employer);
  const education = (person.education || []).filter(e => e.institution);

  const queries = new Set();
  queries.add(name);
  if (birthPlace) queries.add(`${name} ${birthPlace}`);
  if (deathPlace && deathPlace !== birthPlace) queries.add(`${name} ${deathPlace}`);
  if (title) queries.add(`${name} ${title}`);
  if (birth) queries.add(`${name} ${birth}`);
  if (death) {
    queries.add(`${name} Nachruf`);
    queries.add(`${name} Traueranzeige`);
    queries.add(`${name} verstorben ${death}`);
  }
  for (const city of residences.slice(0, 3)) queries.add(`${name} ${city}`);
  for (const j of jobs.slice(0, 2)) {
    if (j.employer) queries.add(`${name} ${j.employer}`);
    if (j.title && j.employer) queries.add(`"${j.title}" "${j.employer}" ${firstGiven} ${surname}`);
  }
  for (const e of education.slice(0, 2)) {
    if (e.institution) queries.add(`${name} ${e.institution}`);
  }
  // Generic dossier queries that often surface bios, articles, interviews.
  queries.add(`${name} Biografie`);
  queries.add(`${name} Lebenslauf`);
  // Cap at 6 queries. Firecrawl self-hosted läuft über diese Schwelle in
  // Rate-Caps und droppt still.
  return Array.from(queries).slice(0, 6);
}

async function runSingleQuery(q) {
  const r = await webSearch({ query: q, country: 'DE', limit: 8 });
  if (!r.ok) return [];
  return r.hits || [];
}

// Sequentiell statt Promise.all — Firecrawl self-hosted dropt bei 3+ parallel
// Queries still Richtung Empty-Response. Sequentieller Durchlauf mit
// webSearch's eigenem Rate-Limit (1500ms) ergibt stabile Treffer.
async function runQueriesSequential(queries) {
  const out = [];
  for (const q of queries) {
    const hits = await runSingleQuery(q);
    out.push({ q, hits });
  }
  return out;
}

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

async function scrapeOne(url) {
  const host = hostOf(url);
  if (!host || NO_SCRAPE_HOSTS.test(host)) return null;
  try {
    const r = await fetchPage('web_dossier', url, { timeout: SCRAPE_TIMEOUT });
    if (!r.ok) return null;
    const md = (r.markdown || r.text || '').trim();
    if (md.length < 200) return null; // too thin to be useful
    return md.slice(0, MAX_MARKDOWN_CHARS);
  } catch { return null; }
}

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  const queries = buildQueries(person);
  if (!queries.length) return [];

  // Query-Fanout — sequentiell gegen Firecrawl's Rate-Cap
  const perQuery = await runQueriesSequential(queries);

  // Hat überhaupt irgendeine Query ein Backend?
  const anyBackend = perQuery.some(({ hits }) => hits.length > 0);
  if (!anyBackend) {
    // Erstes Query-Ergebnis hat uns schon die Backend-Fehler-Info gegeben
    const first = await webSearch({ query: `"${full}"`, limit: 1 });
    if (first.error === 'no_backend') {
      return [{
        source: 'web_dossier',
        title: 'Web-Dossier (nicht konfiguriert)',
        url: 'https://brave.com/search/api/',
        snippet: 'Websuche-Backend nicht konfiguriert. Setze BRAVE_SEARCH_API_KEY oder GOOGLE_CSE_API_KEY+GOOGLE_CSE_CX in /srv/projects/stammbaum/.env.',
        confidence: 0,
        payload: { needs_config: true },
      }];
    }
    return [];
  }

  // URL-Scores aggregieren: wie oft wurde dieselbe URL über verschiedene Queries getroffen?
  // Mehrfach-Match = höheres biografisches Signal (verschiedene Facetten der Person
  // zeigen auf dieselbe Quelle).
  const byUrl = new Map();
  for (const { q, hits } of perQuery) {
    for (const h of hits) {
      if (!h.url) continue;
      const prev = byUrl.get(h.url) || { url: h.url, title: h.title, snippet: h.snippet, matches: 0, queries: [] };
      prev.matches += 1;
      prev.queries.push(q);
      // Längeres Snippet beibehalten
      if ((h.snippet || '').length > (prev.snippet || '').length) prev.snippet = h.snippet;
      if (!prev.title) prev.title = h.title;
      byUrl.set(h.url, prev);
    }
  }

  // Scoring: 0.3 Basis + 0.1 pro extra-Query-Match (max +0.4).
  // Kontext-Boost: Birth-Year/Place/Residence im Text → +0.15 je Treffer.
  const birth = yearOf(person.birth_date);
  const death = yearOf(person.death_date);
  const residences = (person.residences || []).map(r => (r.city || r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);
  const employers = (person.jobs || []).map(j => (j.employer || '').toLowerCase()).filter(Boolean);
  const bPlace = (person.birth_place || '').toLowerCase();
  const dPlace = (person.death_place || '').toLowerCase();

  const ranked = Array.from(byUrl.values()).map(entry => {
    const text = ((entry.snippet || '') + ' ' + (entry.title || '')).toLowerCase();
    let score = 0.3 + Math.min(0.4, (entry.matches - 1) * 0.1);
    if (birth && text.includes(String(birth))) score += 0.1;
    if (death && text.includes(String(death))) score += 0.1;
    if (bPlace.length > 2 && text.includes(bPlace)) score += 0.15;
    if (dPlace.length > 2 && text.includes(dPlace)) score += 0.1;
    for (const r of residences) if (r.length > 2 && text.includes(r)) { score += 0.1; break; }
    for (const e of employers) if (e.length > 2 && text.includes(e)) { score += 0.1; break; }
    entry.confidence = Math.min(1, score);
    return entry;
  }).sort((a, b) => b.confidence - a.confidence);

  // Firecrawl-Deep-Scrape der Top-URLs. Markdown landet im Payload und
  // steht damit der nachgelagerten AI-Review zur Verfügung.
  const topToScrape = ranked.slice(0, MAX_URLS_TO_SCRAPE);
  const scraped = await Promise.all(topToScrape.map(async entry => ({
    entry,
    markdown: await scrapeOne(entry.url),
  })));
  const markdownByUrl = new Map(scraped.map(s => [s.entry.url, s.markdown]));

  // Alle Treffer (gescraped + rest) als research_hits zurückliefern. Top-URLs
  // bekommen volltext_markdown im Payload, Rest nur Snippet.
  const out = ranked.slice(0, 15).map(entry => {
    const md = markdownByUrl.get(entry.url) || null;
    const payload = {
      href: entry.url,
      query_matches: entry.matches,
      queries: entry.queries.slice(0, 6),
    };
    if (md) payload.markdown = md;
    return {
      source: 'web_dossier',
      title: (entry.title || entry.url).slice(0, 140),
      url: entry.url,
      snippet: (entry.snippet || '').slice(0, 240) + (md ? ' · [Volltext für KI-Analyse gespeichert]' : ''),
      confidence: entry.confidence,
      payload,
    };
  });

  if (!out.length) {
    return [{
      source: 'web_dossier',
      title: 'Web-Dossier',
      url: `https://www.google.com/search?q=${encodeURIComponent('"' + full + '"')}`,
      snippet: `Keine Multi-Query-Treffer über ${queries.length} Suchvarianten. Prüfe Namensschreibung oder biographischen Kontext (Geburtsjahr, Ort, Beruf).`,
      confidence: 0,
      payload: { empty: true, queries_tried: queries.length },
    }];
  }
  return out;
}
