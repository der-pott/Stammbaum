// Research dispatcher — fans out a person-lookup to all registered sources
// and collects hits. Each source has its own module in api/sources/.
//
// Active sources are those whose search() does real network work.
// Stub sources contribute metadata only.

import * as wikidata from './sources/wikidata.js';
import { SOURCES as STUB_SOURCES, search as stubSearch } from './sources/stubs.js';

const ACTIVE = [
  { key: 'wikidata', label: 'Wikidata/Wikipedia', impl: wikidata.search },
];

export function listSources() {
  return [
    ...ACTIVE.map(s => ({ key: s.key, label: s.label, active: true })),
    ...STUB_SOURCES.map(s => ({ ...s, active: false })),
  ];
}

export async function dispatchResearch(person) {
  const promises = ACTIVE.map(src =>
    Promise.resolve()
      .then(() => src.impl(person))
      .then(hits => (hits || []).map(h => ({ ...h, source: h.source || src.key })))
      .catch(err => {
        console.warn(`[research] ${src.key} failed:`, err?.message || err);
        return [];
      })
  );
  // Stubs always return []
  for (const s of STUB_SOURCES) promises.push(stubSearch(person, s).catch(() => []));
  const batches = await Promise.all(promises);
  const flat = batches.flat();
  // De-dupe by (source, url) and sort by confidence desc
  const seen = new Set();
  const unique = [];
  for (const h of flat.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))) {
    const k = `${h.source}|${h.url || h.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(h);
  }
  return unique;
}
