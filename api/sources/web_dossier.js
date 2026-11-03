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

// Role-Keyword-Map: wenn die Person wenig strukturierte Daten hat, hilft
// der Titel bei der Query-Expansion. Firecrawl's Index chokt bei quoted
// Full-Name-Queries ("Michael Radtke" → 0 hits), aber findet die relevanten
// Treffer sobald ein Rollen-Keyword mit drinsteht.
function roleKeywords(title) {
  const t = (title || '').toLowerCase();
  const kw = [];
  if (/prof/.test(t)) kw.push('Universität', 'Professor', 'Lehrstuhl');
  if (/dr\.?\s*med/.test(t) || /\bmd\b/.test(t)) kw.push('Facharzt', 'Klinik', 'Praxis', 'Chefarzt', 'Oberarzt');
  else if (/dr\.?\s*(ing|rer|phil|jur|iur|theol)/.test(t)) kw.push('Universität', 'Forschung', 'Publikation');
  else if (/\bdr\.?\b/.test(t)) kw.push('Praxis', 'Kanzlei');
  if (/pfarr|pastor|priester/.test(t)) kw.push('Gemeinde', 'Kirche');
  if (/richter|rechtsanw|notar/.test(t)) kw.push('Gericht', 'Kanzlei');
  if (/ingenieur|dipl.-ing/.test(t)) kw.push('Ingenieur', 'Firma');
  return kw;
}

function buildQueries(person) {
  const { full, firstGiven, surname } = nameParts(person);
  if (!full) return [];
  // Firecrawl Index: Quotes um Full-Name killen Trefferzahl (siehe Test
  // 2026-11-03: `"Michael Radtke" Rostock` → 0 hits, `Michael Radtke
  // Hautklinik Rostock` → 8 hits inkl. cpr.uni-rostock.de). Nackte Namen
  // bevorzugen; nur Quotes bei auffälligen Mehrfach-Vornamen setzen.
  const nameTokens = full.split(/\s+/).filter(Boolean);
  const name = nameTokens.length >= 4 ? `"${firstGiven} ${surname}"` : full;
  const birthPlace = (person.birth_place || '').trim();
  const deathPlace = (person.death_place || '').trim();
  const title = (person.title || '').trim();
  const birth = yearOf(person.birth_date);
  const death = yearOf(person.death_date);
  const residences = (person.residences || [])
    .map(r => (r.city || r.place || '').split(',')[0].trim())
    .filter(Boolean);
  // Edge-Städte: wenn Person keine eigenen Residenzen hat, aber verwandte
  // Personen welche haben, nutze deren Städte als Proxy. Wird vom Caller
  // (server.js / scrape_worker.js) als person.related_cities übergeben.
  const relatedCities = (person.related_cities || []).filter(Boolean);
  const jobs = (person.jobs || []).filter(j => j.title || j.employer);
  const education = (person.education || []).filter(e => e.institution);
  const roleKw = roleKeywords(title);

  const queries = new Set();
  // 1) Nackter Name — Baseline
  queries.add(name);
  // 1b) Titel voranstellen (hochrelevant: "Prof Dr med Michael Radtke"
  // findet die Fachrichtungs-spezifischen Treffer die der nackte Name
  // nicht liefert). Punkte raus — Firecrawl indexiert ohne Punkte besser.
  if (title) {
    const titleStripped = title.replace(/\./g, '').trim();
    if (titleStripped) queries.add(`${titleStripped} ${name}`);
  }
  // 2) Rollen-Keywords (DECISIVE bei datenarmen Personen; Prof. Dr. med.
  // Michael Radtke ohne weitere Daten → Universität/Klinik/Facharzt-Queries)
  for (const kw of roleKw.slice(0, 3)) queries.add(`${name} ${kw}`);
  // 3) Rollen-Keyword + Ort kombiniert (höchste Treffsicherheit)
  const anyCity = birthPlace || residences[0] || relatedCities[0] || '';
  if (anyCity && roleKw[0]) queries.add(`${name} ${roleKw[0]} ${anyCity}`);
  // 4) Orte
  if (birthPlace) queries.add(`${name} ${birthPlace}`);
  if (deathPlace && deathPlace !== birthPlace) queries.add(`${name} ${deathPlace}`);
  for (const city of residences.slice(0, 2)) queries.add(`${name} ${city}`);
  for (const city of relatedCities.slice(0, 2)) queries.add(`${name} ${city}`);
  // 5) Jahre
  if (birth) queries.add(`${name} ${birth}`);
  if (death) {
    queries.add(`${name} Nachruf`);
    queries.add(`${name} Traueranzeige`);
  }
  // 6) Berufliches
  for (const j of jobs.slice(0, 2)) {
    if (j.employer) queries.add(`${name} ${j.employer}`);
  }
  for (const e of education.slice(0, 1)) {
    if (e.institution) queries.add(`${name} ${e.institution}`);
  }
  // 7) Generische Dossier-Queries (nur wenn andere queries schon da sind)
  queries.add(`${name} Biografie`);
  // Cap bei 8 (Firecrawl Rate-Cap sequentiell x 1500ms = 12s pro Lauf)
  return Array.from(queries).slice(0, 8);
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

  // Confirmed-Aware Scoring: User-bestätigte Treffer liefern Vertrauens-Anker.
  // Domains die schon bestätigt wurden → Vertrauensbonus für neue Treffer.
  // Keywords aus bestätigten Snippets → Treffer die sie teilen bekommen Boost.
  const verifiedHosts = new Set((person.verified_facts || [])
    .map(v => { try { return new URL(v.url).host.replace(/^www\./, ''); } catch { return null; } })
    .filter(Boolean));
  const verifiedKeywords = new Set();
  for (const v of (person.verified_facts || [])) {
    const blob = ((v.title || '') + ' ' + (v.snippet || '') + ' ' + (v.markdown || '')).toLowerCase();
    // Extrahiere Wörter mit ≥5 Zeichen, filtere Stop-Wörter grob
    const words = blob.match(/[a-zäöüß]{5,}/gi) || [];
    for (const w of words.slice(0, 200)) verifiedKeywords.add(w.toLowerCase());
  }

  const ranked = Array.from(byUrl.values()).map(entry => {
    const text = ((entry.snippet || '') + ' ' + (entry.title || '')).toLowerCase();
    let score = 0.3 + Math.min(0.4, (entry.matches - 1) * 0.1);
    if (birth && text.includes(String(birth))) score += 0.1;
    if (death && text.includes(String(death))) score += 0.1;
    if (bPlace.length > 2 && text.includes(bPlace)) score += 0.15;
    if (dPlace.length > 2 && text.includes(dPlace)) score += 0.1;
    for (const r of residences) if (r.length > 2 && text.includes(r)) { score += 0.1; break; }
    for (const e of employers) if (e.length > 2 && text.includes(e)) { score += 0.1; break; }
    // Verified-Boost: gleiche Domain wie ein bestätigter Treffer → +0.2
    const entryHost = hostOf(entry.url).replace(/^www\./, '');
    if (entryHost && verifiedHosts.has(entryHost)) { score += 0.2; entry.verified_domain = true; }
    // Verified-Keyword-Overlap: wie viele Keywords teilt der Treffer mit bestätigten?
    if (verifiedKeywords.size) {
      let overlap = 0;
      const textWords = text.match(/[a-zäöüß]{5,}/gi) || [];
      for (const w of textWords) if (verifiedKeywords.has(w.toLowerCase())) overlap += 1;
      if (overlap >= 3) { score += Math.min(0.15, overlap * 0.02); entry.verified_overlap = overlap; }
    }
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
    if (entry.verified_domain) payload.verified_domain = true;
    if (entry.verified_overlap) payload.verified_overlap = entry.verified_overlap;
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
