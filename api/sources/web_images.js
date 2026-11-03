// Bild-Recherche über Bing/DuckDuckGo Image-SERPs (gescraped via Firecrawl)
// plus og:image aus den gescrapten Textseiten. Private Familien-Nutzung;
// Einverständnis der Lebenden liegt vor (CLAUDE.md).

import { nameParts, yearOf } from '../http.js';
import { fetchPage } from '../scrape_fetcher.js';
import { webSearch } from '../search_backend.js';

export const META = { label: 'Bild-Recherche (Bing/DDG + og:image)', url: 'https://www.bing.com/images' };

const BING_IMG_URL = (q) => `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&first=1`;
const DDG_IMG_URL  = (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`;

const SKIP_URL = [
  /\/favicon|\/logo|\/icon|\/sprite|\/banner|\/cookie|\/consent|\/bg(_|-)/i,
  /tracking|analytics|pixel|placeholder|avatar\.jpg/i,
  /\.svg(\?|$)/i,
  /data:image/i,
  /gravatar\.com/i,
  /\/themes?\//i,          // CMS theme assets
  /\/skins?\//i,
  /\/assets\/(?:ui|common)/i,
  /image_terms|link_extern|image_terms_of_use/i,
  /\.(gif|webp)\?.*ad/i,   // ad banners
];

// Positive signals for a real portrait / person photo
const PORTRAIT_HINT = /pic|photo|foto|portrait|headshot|profile|mitarbeiter|person|team|member|profil|portr|kolleg/i;

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

  const queries = new Set();
  queries.add(full);
  if (title) queries.add(`${title} ${full}`);
  if (birthPlace) queries.add(`${full} ${birthPlace}`);
  if (deathPlace && deathPlace !== birthPlace) queries.add(`${full} ${deathPlace}`);
  for (const city of residences.slice(0, 2)) queries.add(`${full} ${city}`);
  for (const emp of employers.slice(0, 1)) queries.add(`${full} ${emp}`);
  return Array.from(queries).slice(0, 5);
}

function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }

// Bing Images: thumbnail URLs sind th.bing.com/th/id/OIP.* mit w= und h= params.
// Die begleitende <a class="iusc" m="..."> JSON enthält murl (source URL) und t (title).
function extractBingImages(html, query) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  // iusc <a> tags carry a JSON blob in `m=`
  const iuscRe = /<a[^>]+class="iusc"[^>]+m="([^"]+)"/gi;
  let m;
  while ((m = iuscRe.exec(html)) !== null) {
    try {
      const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const meta = JSON.parse(raw);
      const image_url = meta.murl || meta.mediaurl || meta.turl;
      if (!image_url || SKIP_URL.some(p => p.test(image_url))) continue;
      if (seen.has(image_url)) continue;
      seen.add(image_url);
      out.push({
        image_url,
        thumb_url: meta.turl || null,
        page_url: meta.purl || meta.murl || null,
        alt: meta.t || meta.desc || '',
        width: meta.mw || null,
        height: meta.mh || null,
        source_query: query,
      });
    } catch { /* skip malformed */ }
  }
  // Fallback: plain th.bing.com URLs
  if (!out.length) {
    const thumbRe = /https?:\/\/th\.bing\.com\/th\/id\/[^"\s<>]+/g;
    while ((m = thumbRe.exec(html)) !== null) {
      const url = m[0].replace(/&amp;/g, '&');
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ image_url: url, thumb_url: url, page_url: null, alt: '', width: null, height: null, source_query: query });
    }
  }
  return out;
}

// Alle Bild-Kandidaten einer Textseite ziehen: og:image + <img> src + markdown.
// Filter: SKIP_URL für Logos/Themes/Icons. Portrait-Hints boosten später das
// Scoring. So findet web_images z.B. das Portrait im CPR-Rostock-HTML das
// kein og:image deklariert.
function extractImagesFromPage(html, md, pageUrl) {
  const metas = [];
  const seen = new Set();
  const push = (rawUrl, src) => {
    if (!rawUrl) return;
    let abs;
    try { abs = new URL(rawUrl.split(/\s+/)[0], pageUrl).href; } catch { return; }
    if (SKIP_URL.some(p => p.test(abs))) return;
    if (!/^https?:/i.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    metas.push({ image_url: abs, page_url: pageUrl, alt: '', width: null, height: null, source_query: src });
  };
  // 1. og:image / twitter:image (höchste Priorität — vom Seitenbesitzer kuratiert)
  if (html) {
    const ogRe = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:url)["'][^>]+content=["']([^"']+)["']/gi;
    let m; while ((m = ogRe.exec(html)) !== null) push(m[1], 'og:image');
  }
  // 2. HTML <img src>
  if (html) {
    const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?/gi;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
      const url = m[1];
      const alt = m[2] || '';
      push(url, '<img>');
      // alt updaten für den gerade gepushten Eintrag
      const entry = metas[metas.length - 1];
      if (entry && alt) entry.alt = alt;
    }
  }
  // 3. Markdown ![alt](url)
  if (md) {
    const mdRe = /!\[([^\]]*)\]\(([^)\s]+)/g;
    let m;
    while ((m = mdRe.exec(md)) !== null) {
      const alt = m[1] || '';
      push(m[2], 'markdown-image');
      const entry = metas[metas.length - 1];
      if (entry && alt) entry.alt = alt;
    }
  }
  return metas;
}

async function scrapeImageSearch(url, query) {
  try {
    const r = await fetchPage('web_images', url, { timeout: 20_000 });
    if (!r.ok) return [];
    const html = r.html || r.text || '';
    if (url.includes('bing.com/images')) return extractBingImages(html, query);
    if (url.includes('duckduckgo.com'))  return extractBingImages(html, query); // DDG uses similar iusc-style blobs occasionally
    return [];
  } catch { return []; }
}

async function scrapeTextPageForImages(url) {
  try {
    const r = await fetchPage('web_images', url, { timeout: 15_000 });
    if (!r.ok) return [];
    const html = r.html || r.text || '';
    const md = r.markdown || '';
    return extractImagesFromPage(html, md, url);
  } catch { return []; }
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

  const queries = buildQueries(person);
  if (!queries.length) return [];

  // Phase 1: Bing Images SERP für jede Query (sequentiell gegen Firecrawl Rate-Cap)
  const bingResults = [];
  for (const q of queries) {
    const hits = await scrapeImageSearch(BING_IMG_URL(q), q);
    bingResults.push(...hits);
  }

  // Phase 2: User-bestätigte Treffer (verified_facts) IMMER gezielt nach
  // Bildern scrapen. Hier liegt der Portrait-Hit oft begraben (CPR, Vita-
  // Seiten etc). Anschließend Top-Textsuche-Treffer der aktuellen Queries.
  const verifiedUrls = (person.verified_facts || []).map(v => v.url).filter(Boolean);
  const textSearchResults = [];
  for (const q of queries.slice(0, 3)) {
    const r = await webSearch({ query: q, country: 'DE', limit: 4 });
    if (r.ok) for (const h of (r.hits || [])) if (h.url) textSearchResults.push(h.url);
  }
  // verified_urls VOR den search-results — höchste Priorität
  const allPageUrls = Array.from(new Set([...verifiedUrls, ...textSearchResults])).slice(0, 10);
  const pageImgResults = [];
  for (const u of allPageUrls) {
    const imgs = await scrapeTextPageForImages(u);
    pageImgResults.push(...imgs);
  }

  // Dedupe + score
  const byUrl = new Map();
  for (const img of [...bingResults, ...pageImgResults]) {
    if (!img.image_url) continue;
    const prev = byUrl.get(img.image_url) || { ...img, matches: 0, queries: [], sources: new Set() };
    prev.matches += 1;
    if (img.source_query && !prev.queries.includes(img.source_query)) prev.queries.push(img.source_query);
    // Herkunft erfassen für Scoring
    if (img.source_query === 'og:image') prev.sources.add('og');
    else if (img.source_query === '<img>' || img.source_query === 'markdown-image') prev.sources.add('page');
    else prev.sources.add('bing');
    if ((img.alt || '').length > (prev.alt || '').length) prev.alt = img.alt;
    // Portrait-Hint im Pfadnamen → high confidence
    if (PORTRAIT_HINT.test(img.image_url)) prev.portrait_hint = true;
    byUrl.set(img.image_url, prev);
  }

  const nameLower = full.toLowerCase();
  const firstLower = (firstGiven || '').toLowerCase();
  const surnameLower = (surname || '').toLowerCase();
  const birthPlaceLower = (person.birth_place || '').toLowerCase();
  const residences = (person.residences || []).map(r => (r.city || r.place || '').toLowerCase().split(',')[0].trim()).filter(Boolean);

  // Verified-Page-Hosts erfassen — Bilder VON diesen URLs sind besonders
  // wertvoll weil die Seite als Ground-Truth-Quelle bestätigt ist.
  const verifiedHosts = new Set((person.verified_facts || [])
    .map(v => { try { return new URL(v.url).host; } catch { return null; } })
    .filter(Boolean));

  const items = Array.from(byUrl.values()).map(it => {
    const alt = (it.alt || '').toLowerCase();
    const hasPageSrc = it.sources.has('page');
    const hasOg = it.sources.has('og');
    const hasBing = it.sources.has('bing');
    let score = hasBing ? 0.35 : 0.3; // bing baseline etwas höher (bereits name-targeted)
    if (alt.includes(nameLower)) score += 0.35;
    else if (surnameLower && alt.includes(surnameLower)) score += 0.15;
    if (it.matches > 1) score += Math.min(0.2, (it.matches - 1) * 0.1);
    if (hasOg) score += 0.1;
    if (hasPageSrc) score += 0.1;   // explizit auf einer Textseite verlinkt
    if (it.portrait_hint) score += 0.2; // URL enthält "pic"/"foto"/"portrait"/etc
    // Bild liegt auf einem user-bestätigten Host → +0.25 (CPR-Portrait-Fall)
    try {
      const imgHost = new URL(it.image_url).host;
      if (verifiedHosts.has(imgHost)) { score += 0.25; it.verified_source = true; }
    } catch { /* ignore */ }
    if (it.width && it.width >= 400) score += 0.05;
    if (it.width && it.width >= 800) score += 0.05;
    for (const r of residences) if (r.length > 2 && alt.includes(r)) { score += 0.05; break; }
    it.confidence = Math.min(1, score);
    // Set serialisiert schlecht → als Array ablegen für payload
    it.source_tags = Array.from(it.sources);
    delete it.sources;
    return it;
  }).filter(it => !it.width || !it.height || (it.width >= 100 && it.height >= 100))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 24);

  if (!items.length) {
    return [{
      source: 'web_images',
      title: 'Bild-Recherche',
      url: `https://www.bing.com/images/search?q=${encodeURIComponent(full)}`,
      snippet: `Keine Bild-Treffer über ${queries.length} Varianten (Bing + og:image).`,
      confidence: 0,
      payload: { empty: true, queries_tried: queries.length },
    }];
  }

  return items.map(it => {
    const srcLabel = it.verified_source ? 'bestätigte Quelle'
      : it.source_tags.includes('og') ? 'og:image'
      : it.source_tags.includes('page') ? 'Textseiten-Bild'
      : 'Bing-Images';
    return {
      source: 'web_images',
      title: (it.alt || 'Bild').slice(0, 140),
      url: it.page_url || it.image_url,
      snippet: `Gefunden via ${srcLabel}${it.width && it.height ? ` · ${it.width}×${it.height}` : ''}${it.matches > 1 ? ` · ${it.matches}× bestätigt` : ''}${it.portrait_hint ? ' · Portrait-Hint' : ''}`,
      confidence: it.confidence,
      payload: {
        is_image: true,
        image_url: it.image_url,
        thumb_url: it.thumb_url || it.image_url,
        page_url: it.page_url,
        alt: it.alt,
        width: it.width,
        height: it.height,
        query_matches: it.matches,
        verified_source: !!it.verified_source,
        portrait_hint: !!it.portrait_hint,
      },
    };
  });
}
