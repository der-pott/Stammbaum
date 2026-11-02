// Reddit public search — JSON endpoint, no auth. old.reddit.com is more
// permissive against bot-UAs than www.reddit.com.
import { httpGet, nameParts } from '../http.js';

export const META = { label: 'Reddit', url: 'https://old.reddit.com' };

export async function search(person) {
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://old.reddit.com/search.json?q=${encodeURIComponent('"' + full + '"')}&limit=10&sort=relevance`;
  const r = await httpGet('reddit', url, { accept: 'json' });
  if (!r.ok) {
    return [{ source: 'reddit', title: 'Reddit', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const children = r.body?.data?.children || [];
  if (!children.length) {
    return [{ source: 'reddit', title: 'Reddit', url, snippet: 'Keine Reddit-Treffer.', confidence: 0, payload: { empty: true } }];
  }
  const relevantSubs = /^(de|germany|austria|genealogy|ancestry|AskHistorians|dachschaden)$/i;
  return children.slice(0, 10).map(c => {
    const d = c.data || {};
    const sub = d.subreddit || '';
    const title = d.title || '';
    const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : (d.url || '');
    const excerpt = (d.selftext || title || '').slice(0, 200);
    let confidence = 0.25;
    if (relevantSubs.test(sub)) confidence += 0.15;
    return {
      source: 'reddit',
      title: title.slice(0, 140),
      url: permalink,
      snippet: `r/${sub} · ${excerpt}`.slice(0, 240),
      confidence,
      payload: { subreddit: sub, score: d.score, created_utc: d.created_utc, author: d.author },
    };
  });
}
