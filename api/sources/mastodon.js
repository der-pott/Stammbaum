// Mastodon — flagship instance search covers much of federation.
import { httpGet, nameParts } from '../http.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'Mastodon', url: 'https://mastodon.social' };

export async function search(person) {
  if (isPreDigital(person)) return [];
  const { full } = nameParts(person);
  if (!full) return [];
  const url = `https://mastodon.social/api/v2/search?q=${encodeURIComponent(full)}&type=accounts&resolve=false&limit=10`;
  const r = await httpGet('mastodon', url, { accept: 'json' });
  if (!r.ok) {
    return [{ source: 'mastodon', title: 'Mastodon', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const accounts = r.body?.accounts || [];
  if (!accounts.length) {
    return [{ source: 'mastodon', title: 'Mastodon', url, snippet: 'Keine Fediverse-Accounts gefunden.', confidence: 0, payload: { empty: true } }];
  }
  const targetFull = full.toLowerCase();
  return accounts.slice(0, 10).map(a => {
    const display = (a.display_name || '').toLowerCase();
    let confidence = 0.25;
    if (display && (display.includes(targetFull) || targetFull.includes(display))) confidence += 0.15;
    const note = (a.note || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
    return {
      source: 'mastodon',
      title: a.display_name || a.acct || 'Mastodon-Account',
      url: a.url || `https://mastodon.social/@${a.acct}`,
      snippet: `@${a.acct}${note ? ' · ' + note : ''}`.slice(0, 240),
      confidence,
      payload: { acct: a.acct, display_name: a.display_name, followers_count: a.followers_count },
    };
  });
}
