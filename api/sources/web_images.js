// Bild-Recherche: Multi-Query Image-Search über Firecrawl.
// Nutzer wählt in der UI aus welche Bilder in die Personen-Galerie
// übernommen werden. Rein private Familien-Nutzung — Einverständnis der
// lebenden Verwandten liegt vor, laut CLAUDE.md des Projekts.

import { nameParts, yearOf } from '../http.js';
import { firecrawlImageSearch } from '../search_backend.js';

export const META = { label: 'Bild-Recherche (Firecrawl)', url: 'https://www.google.com/images' };

function buildImageQueries(person) {
  const { full, firstGiven, surname } = nameParts(person);
  if (!full) return [];
  const title = (person.title || '').trim();
  const birthPlace = (person.birth_place || '').trim();
  const deathPlace = (person.death_place || '').trim();
  const residences = (person.residences || [])
    .map(r => (r.city || r.place || '').split(',')[0].trim())
    .filter(Boolean);
  const employers = (person.jobs || []).map(j => j.employer).filter(Boolean);
  const death = yearOf(person.death_date);

  const queries = new Set();
  queries.add(`"${full}"`);
  if (title) queries.add(`"${title} ${full}"`);
  if (birthPlace) queries.add(`"${full}" ${birthPlace}`);
  if (deathPlace && deathPlace !== birthPlace) queries.add(`"${full}" ${deathPlace}`);
  for (const city of residences.slice(0, 2)) queries.add(`"${full}" ${city}`);
  for (const emp of employers.slice(0, 2)) queries.add(`"${full}" ${emp}`);
  if (death) queries.add(`"${full}" Nachruf`);
  queries.add(`"${full}" Portrait`);
  return Array.from(queries).slice(0, 8);
}

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  if (!process.env.FIRECRAWL_URL) {
    return [{
      source: 'web_images',
      title: 'Bild-Recherche (nicht konfiguriert)',
      url: 'https://www.firecrawl.dev',
      snippet: 'Benötigt FIRECRAWL_URL für Image-Search über das self-hosted Firecrawl.',
      confidence: 0,
      payload: { needs_config: true },
    }];
  }

  const queries = buildImageQueries(person);
  const perQuery = await Promise.all(queries.map(q => firecrawlImageSearch(q, { limit: 10 }).then(hits => ({ q, hits }))));

  // Dedupe per image_url; multi-match über Queries = Score-Boost.
  const byUrl = new Map();
  for (const { q, hits } of perQuery) {
    for (const h of hits) {
      if (!h.image_url) continue;
      const prev = byUrl.get(h.image_url) || { ...h, matches: 0, queries: [] };
      prev.matches += 1;
      prev.queries.push(q);
      if ((h.snippet || '').length > (prev.snippet || '').length) prev.snippet = h.snippet;
      if (!prev.title && h.title) prev.title = h.title;
      byUrl.set(h.image_url, prev);
    }
  }

  if (!byUrl.size) {
    return [{
      source: 'web_images',
      title: 'Bild-Recherche',
      url: `https://www.google.com/images?q=${encodeURIComponent('"' + full + '"')}`,
      snippet: `Keine Bild-Treffer über ${queries.length} Suchvarianten.`,
      confidence: 0,
      payload: { empty: true, queries_tried: queries.length },
    }];
  }

  // Dim/winzige Bilder rausfiltern (unter 150px Kante = oft Icons/Avatare).
  const items = Array.from(byUrl.values())
    .filter(it => !it.width || !it.height || (it.width >= 150 && it.height >= 150))
    .sort((a, b) => b.matches - a.matches || (b.width * b.height || 0) - (a.width * a.height || 0))
    .slice(0, 24);

  return items.map(it => ({
    source: 'web_images',
    title: (it.title || 'Bild').slice(0, 140),
    url: it.page_url || it.image_url,
    snippet: (it.snippet || '').slice(0, 240),
    confidence: Math.min(1, 0.3 + Math.min(0.4, (it.matches - 1) * 0.1)),
    payload: {
      is_image: true,
      image_url: it.image_url,
      page_url: it.page_url,
      width: it.width,
      height: it.height,
      query_matches: it.matches,
      queries: it.queries.slice(0, 4),
    },
  }));
}
