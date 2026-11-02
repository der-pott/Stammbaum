// Wikidata/Wikipedia source — searches wbsearchentities for human candidates,
// pulls birth/death/place from the entity payload, and scores confidence by
// name + year overlap. No API key required.
//
// This runs server-side. Keep the module stateless.

const SEARCH_URL = 'https://www.wikidata.org/w/api.php';
const ENTITY_URL = 'https://www.wikidata.org/wiki/Special:EntityData/';
const WIKI_SUMMARY_URL = 'https://de.wikipedia.org/api/rest_v1/page/summary/';

const TIMEOUT = 10_000;

function fetchJson(url, { timeout = TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Stammbaum/1.0 (research)' } })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .finally(() => clearTimeout(t));
}

function yearFromDate(s) {
  if (!s) return null;
  const m = String(s).match(/[+-]?(\d{3,4})/);
  return m ? parseInt(m[1], 10) : null;
}

export async function search(person) {
  const name = [person.given_name, person.surname].filter(Boolean).join(' ').trim();
  if (!name) return [];

  const searchParams = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'de',
    limit: '10',
    format: 'json',
    uselang: 'de',
    origin: '*',
  });

  const data = await fetchJson(`${SEARCH_URL}?${searchParams}`).catch(() => null);
  const hits = data?.search || [];
  if (!hits.length) return [];

  const targetBirth = yearFromDate(person.birth_date);
  const targetDeath = yearFromDate(person.death_date);
  const results = [];

  for (const h of hits.slice(0, 5)) {
    const entity = await fetchJson(`${ENTITY_URL}${h.id}.json`).catch(() => null);
    if (!entity?.entities?.[h.id]) continue;
    const ent = entity.entities[h.id];
    const claims = ent.claims || {};
    // Must be a human
    const instances = (claims.P31 || []).map(c => c.mainsnak?.datavalue?.value?.id);
    if (!instances.includes('Q5')) continue;

    const birthClaim = claims.P569?.[0]?.mainsnak?.datavalue?.value?.time;
    const deathClaim = claims.P570?.[0]?.mainsnak?.datavalue?.value?.time;
    const birthYear = yearFromDate(birthClaim);
    const deathYear = yearFromDate(deathClaim);

    // Confidence: name match + year match
    const label = (ent.labels?.de?.value || ent.labels?.en?.value || h.label || '').toLowerCase();
    let confidence = 0;
    if (label.includes((person.surname || '').toLowerCase()) && (person.surname || '').length > 2) confidence += 0.3;
    if (label.includes((person.given_name || '').toLowerCase().split(' ')[0] || '~~~')) confidence += 0.3;
    if (targetBirth && birthYear && Math.abs(targetBirth - birthYear) <= 1) confidence += 0.3;
    if (targetDeath && deathYear && Math.abs(targetDeath - deathYear) <= 1) confidence += 0.2;
    if (confidence < 0.3) continue;

    const descr = ent.descriptions?.de?.value || ent.descriptions?.en?.value || '';
    results.push({
      source: 'wikidata',
      url: `https://www.wikidata.org/wiki/${h.id}`,
      title: ent.labels?.de?.value || h.label,
      snippet: [descr, birthYear ? '*' + birthYear : null, deathYear ? '†' + deathYear : null].filter(Boolean).join(' · '),
      confidence: Math.min(1, confidence),
      payload: {
        qid: h.id,
        birth: birthYear, death: deathYear,
        description: descr,
      },
    });
  }

  // Also try the German Wikipedia REST summary endpoint for a plain-text hit
  // when the name is likely notable (two-word name, at least).
  if (name.split(' ').length >= 2) {
    try {
      const wikiData = await fetchJson(WIKI_SUMMARY_URL + encodeURIComponent(name));
      if (wikiData && wikiData.type !== 'disambiguation' && wikiData.extract) {
        let confidence = 0.4;
        const extractLower = (wikiData.extract || '').toLowerCase();
        if (targetBirth && extractLower.includes(String(targetBirth))) confidence += 0.2;
        results.push({
          source: 'wikipedia-de',
          url: wikiData.content_urls?.desktop?.page || `https://de.wikipedia.org/wiki/${encodeURIComponent(name)}`,
          title: wikiData.title,
          snippet: (wikiData.extract || '').slice(0, 300),
          confidence,
          payload: { summary: wikiData.extract },
        });
      }
    } catch (_) { /* ignore */ }
  }

  return results.sort((a, b) => b.confidence - a.confidence);
}
