// Bild-Recherche: scraped Top-URLs aus web_dossier und extrahiert <img>-Tags
// bzw. Markdown-Bilder. Nutzer wählt in der UI welche Bilder in die
// Personen-Galerie übernommen werden. Private Familien-Nutzung — Einverständnis
// der lebenden Verwandten liegt vor, laut Projektanweisung.

import { nameParts, yearOf } from '../http.js';
import { webSearch } from '../search_backend.js';
import { fetchPage } from '../scrape_fetcher.js';

export const META = { label: 'Bild-Recherche (gescrapte Fundstellen)', url: 'https://www.google.com/images' };

const MAX_SCRAPES = 6;
const MIN_IMG_URL_LEN = 20;
const SKIP_URL_PATTERNS = [
  /\/favicon|\/logo|\/icon|\/sprite|\/banner|\/cookie|\/consent/i,
  /tracking|analytics|pixel/i,
  /\.svg(\?|$)/i,
  /data:image/i,
];

function buildQueries(person) {
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
  queries.add(`"${full}" Foto`);
  queries.add(`"${full}" Portrait`);
  return Array.from(queries).slice(0, 10);
}

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

function extractImagesFromHtml(html, pageUrl) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  // <img src=... alt=... width=... height=...>
  const re = /<img\b([^>]*?)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src || src.length < MIN_IMG_URL_LEN) continue;
    let abs;
    try { abs = new URL(src, pageUrl).href; } catch { continue; }
    if (SKIP_URL_PATTERNS.some(p => p.test(abs))) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const alt = (attrs.match(/\balt\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const w = parseInt((attrs.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || '0', 10) || null;
    const h = parseInt((attrs.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1] || '0', 10) || null;
    out.push({ image_url: abs, page_url: pageUrl, alt, width: w, height: h });
  }
  // Markdown-Fallback für Firecrawl-markdown-Only-Responses
  const mdRe = /!\[([^\]]*)\]\(([^)\s]+)/g;
  while ((m = mdRe.exec(html)) !== null) {
    const abs = (() => { try { return new URL(m[2], pageUrl).href; } catch { return null; } })();
    if (!abs || seen.has(abs)) continue;
    if (SKIP_URL_PATTERNS.some(p => p.test(abs))) continue;
    seen.add(abs);
    out.push({ image_url: abs, page_url: pageUrl, alt: m[1] || '', width: null, height: null });
  }
  return out;
}

export async function search(person) {
  const { full, firstGiven, surname } = nameParts(person);
  if (!full) return [];

  if (!process.env.FIRECRAWL_URL) {
    return [{
      source: 'web_images',
      title: 'Bild-Recherche (nicht konfiguriert)',
      url: 'https://www.firecrawl.dev',
      snippet: 'Benötigt FIRECRAWL_URL für Scraping.',
      confidence: 0,
      payload: { needs_config: true },
    }];
  }

  const queries = buildQueries(person).slice(0, 5);
  // Sequentiell gegen Firecrawl's Rate-Cap
  const perQuery = [];
  for (const q of queries) {
    const r = await webSearch({ query: q, country: 'DE', limit: 6 });
    perQuery.push(r);
  }

  // Dedupe candidate URLs across queries, score by multi-match
  const urlScore = new Map();
  for (const r of perQuery) {
    if (!r.ok) continue;
    for (const h of r.hits || []) {
      if (!h.url) continue;
      urlScore.set(h.url, (urlScore.get(h.url) || 0) + 1);
    }
  }
  const topUrls = Array.from(urlScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SCRAPES)
    .map(([url]) => url);

  if (!topUrls.length) {
    return [{
      source: 'web_images',
      title: 'Bild-Recherche',
      url: `https://www.google.com/search?q=${encodeURIComponent('"' + full + '"')}&tbm=isch`,
      snippet: `Keine Fundstellen über ${queries.length} Suchvarianten.`,
      confidence: 0,
      payload: { empty: true, queries_tried: queries.length },
    }];
  }

  // Scrape in parallel, extract images
  const scraped = await Promise.all(topUrls.map(async url => {
    try {
      const r = await fetchPage('web_images', url, { timeout: 15_000 });
      if (!r.ok) return [];
      const html = r.html || r.markdown || r.text || '';
      return extractImagesFromHtml(html, url);
    } catch { return []; }
  }));

  // Flatten + dedupe by image_url
  const byImg = new Map();
  for (const list of scraped) {
    for (const img of list) {
      if (!byImg.has(img.image_url)) byImg.set(img.image_url, img);
    }
  }
  // Scoring: Alt-Text enthält Namen oder Vorname oder Nachname → +0.3.
  // Size-Bonus: width >= 300 → +0.1
  const nameLower = full.toLowerCase();
  const firstLower = firstGiven.toLowerCase();
  const surnameLower = surname.toLowerCase();
  const items = Array.from(byImg.values()).map(it => {
    const alt = (it.alt || '').toLowerCase();
    let score = 0.3;
    if (alt.includes(nameLower)) score += 0.4;
    else if (surnameLower && alt.includes(surnameLower) && firstLower && alt.includes(firstLower)) score += 0.35;
    else if (surnameLower && alt.includes(surnameLower)) score += 0.15;
    if (it.width && it.width >= 300) score += 0.1;
    if (it.width && it.width >= 600) score += 0.05;
    it.confidence = Math.min(1, score);
    return it;
  }).filter(it => !it.width || !it.height || (it.width >= 100 && it.height >= 100))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 24);

  if (!items.length) {
    return [{
      source: 'web_images',
      title: 'Bild-Recherche',
      url: `https://www.google.com/search?q=${encodeURIComponent('"' + full + '"')}&tbm=isch`,
      snippet: `Keine passenden Bilder auf ${topUrls.length} gescrapten Seiten.`,
      confidence: 0,
      payload: { empty: true, pages_scraped: topUrls.length },
    }];
  }

  return items.map(it => ({
    source: 'web_images',
    title: (it.alt || 'Bild').slice(0, 140),
    url: it.page_url,
    snippet: `Gefunden auf ${hostOf(it.page_url) || it.page_url}${it.width && it.height ? ` · ${it.width}×${it.height}` : ''}`,
    confidence: it.confidence,
    payload: {
      is_image: true,
      image_url: it.image_url,
      page_url: it.page_url,
      alt: it.alt,
      width: it.width,
      height: it.height,
    },
  }));
}
