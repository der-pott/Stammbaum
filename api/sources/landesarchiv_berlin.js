// Landesarchiv Berlin — Findbuch-Suche.
//
// Neue Quelle: landesarchiv-berlin.findbuch.net (content.* ist tot).
// Session-basiert: GET main.php liefert PHPSESSID, dann POST rech_start.php mit Cookie.
// Antwort = JSON mit result_list[] (Bestandssignaturen) + result_front (Trefferzahl-HTML).
// Titel pro Eintrag koennen aktuell nicht geladen werden (load_ve.php / rechergs.php = 500).
// Daher: eine Zusammenfassungs-Karte mit den Signaturen.

import { nameParts } from '../http.js';
import { needsFirecrawlCard } from '../scrape_fetcher.js';

export const META = {
  label: 'Landesarchiv Berlin',
  url: 'https://www.landesarchiv-berlin.findbuch.net/php/main.php',
};
const LABEL = 'Landesarchiv Berlin';
const BASE = 'https://www.landesarchiv-berlin.findbuch.net';
const UA = 'Stammbaum-Pott/1.0 (private family research; contact: maximilian.pott@outlook.com)';

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];

  const landingUrl = `${BASE}/php/main.php`;
  const searchUrl = `${BASE}/php/rech_start.php?rech_nr=1`;

  // 1) Session-Cookie holen
  let cookie = '';
  try {
    const landing = await fetch(landingUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept': 'text/html,*/*;q=0.8',
        'accept-language': 'de,en;q=0.8',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!landing.ok) {
      if (landing.status === 403 || landing.status === 503) {
        return [needsFirecrawlCard('landesarchiv_berlin', LABEL, landingUrl, `HTTP ${landing.status}`)];
      }
      return [{
        source: 'landesarchiv_berlin',
        title: LABEL,
        url: landingUrl,
        snippet: `Landing fehlgeschlagen (HTTP ${landing.status})`,
        confidence: 0,
        payload: { error: 'HTTP ' + landing.status },
      }];
    }
    const setCookie = landing.headers.get('set-cookie') || '';
    // Cookie-String auf "name=val"-Paare reduzieren
    cookie = setCookie
      .split(/,(?=[^;]+=)/)
      .map(part => part.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network error');
    return [{
      source: 'landesarchiv_berlin',
      title: LABEL,
      url: landingUrl,
      snippet: `Landing-Fehler (${msg})`,
      confidence: 0,
      payload: { error: msg },
    }];
  }

  // 2) Suche posten
  const body = new URLSearchParams({
    words: full,
    op: 'and',
    max: '50',
    pics_only: 'false',
    truncate: 'false',
    signature: 'false',
    kind: '',
    id: '',
    name: '',
    tab: '',
    complete: 'true',
    complete_date: 'true',
  });

  try {
    const res = await fetch(searchUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'accept-language': 'de,en;q=0.8',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        'origin': BASE,
        'referer': landingUrl,
        ...(cookie ? { 'cookie': cookie } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 503) {
        return [needsFirecrawlCard('landesarchiv_berlin', LABEL, landingUrl, `HTTP ${res.status}`)];
      }
      return [{
        source: 'landesarchiv_berlin',
        title: LABEL,
        url: landingUrl,
        snippet: `Suche fehlgeschlagen (HTTP ${res.status})`,
        confidence: 0,
        payload: { error: 'HTTP ' + res.status },
      }];
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return [{
        source: 'landesarchiv_berlin',
        title: LABEL,
        url: landingUrl,
        snippet: 'Nicht-JSON Antwort (API-Format geaendert?).',
        confidence: 0,
        payload: { raw_preview: text.slice(0, 200) },
      }];
    }

    const list = Array.isArray(data.result_list) ? data.result_list : [];
    // Trefferzahl aus result_front rausziehen
    let count = list.length;
    const front = String(data.result_front || '');
    const mnum = front.match(/(\d+)\s*Treffer/i);
    if (mnum) count = parseInt(mnum[1], 10);

    if (!count || !list.length) {
      return [{
        source: 'landesarchiv_berlin',
        title: LABEL,
        url: landingUrl,
        snippet: `Keine Treffer im Landesarchiv-Findbuch fuer "${full}".`,
        confidence: 0,
        payload: { empty: true, query: full },
      }];
    }

    // Signaturen sammeln + saeubern.
    // Rohes Format: "ve_c rep. 031-01-06*20202020...20363039...._0006765502@1@141"
    // Lesbarer Teil = alles vor "*". Prefix "ve_x " entfernen.
    const sigs = list
      .map(it => (it.key || it.signatur || it.sig || '').toString().trim())
      .map(k => k.split('*')[0].replace(/^ve_[a-z]\s+/i, '').trim())
      .filter(Boolean);
    const uniqueSigs = [...new Set(sigs)];
    const shown = uniqueSigs.slice(0, 10).join(', ');
    const snippet = uniqueSigs.length > 10
      ? `Bestaende: ${shown} … und mehr`
      : (shown || `${count} Treffer`);

    // Confidence: 0.4 + 0.1 pro zusaetzlichem Treffer, max 0.8
    const confidence = Math.min(0.8, 0.4 + 0.1 * (count - 1));

    return [{
      source: 'landesarchiv_berlin',
      title: `${count} ${count === 1 ? 'Treffer' : 'Treffer'} im Landesarchiv Berlin`,
      url: landingUrl,
      snippet,
      confidence,
      payload: {
        archiv: 'Landesarchiv Berlin',
        count,
        signatures: uniqueSigs.slice(0, 50),
        query: full,
        note: 'Einzeltitel aktuell nicht abrufbar (load_ve.php/rechergs.php liefern 500). Trefferliste direkt im Findbuch unter main.php durchsehen.',
      },
    }];
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network error');
    return [{
      source: 'landesarchiv_berlin',
      title: LABEL,
      url: landingUrl,
      snippet: `Netzwerk-/Timeout-Fehler (${msg})`,
      confidence: 0,
      payload: { error: msg },
    }];
  }
}
