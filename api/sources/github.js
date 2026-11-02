// GitHub users — public search API, unauthenticated (10 req/min is enough).
import { httpGet, nameParts } from '../http.js';
import { isPreDigital } from './_gating.js';

export const META = { label: 'GitHub', url: 'https://github.com' };

export async function search(person) {
  if (isPreDigital(person)) return [];
  const { full, firstGiven, surname } = nameParts(person);
  if (!full) return [];
  const url = `https://api.github.com/search/users?q=${encodeURIComponent(full)}&per_page=10`;
  const r = await httpGet('github', url, { accept: 'json' });
  if (!r.ok) {
    return [{ source: 'github', title: 'GitHub', url, snippet: `Zugriff nicht möglich (${r.error})`, confidence: 0, payload: { error: r.error } }];
  }
  const items = r.body?.items || [];
  if (!items.length) {
    return [{ source: 'github', title: 'GitHub', url, snippet: 'Keine GitHub-Nutzer gefunden.', confidence: 0, payload: { empty: true } }];
  }
  const given = (firstGiven || '').toLowerCase();
  const sn = (surname || '').toLowerCase();
  return items.slice(0, 10).map(u => {
    const login = (u.login || '').toLowerCase();
    const html = u.html_url || `https://github.com/${u.login}`;
    let confidence = 0.3;
    if (given && login.includes(given)) confidence += 0.1;
    if (sn && login.includes(sn)) confidence += 0.15;
    return {
      source: 'github',
      title: u.login || 'GitHub user',
      url: html,
      snippet: `GitHub-Profil${u.type && u.type !== 'User' ? ' (' + u.type + ')' : ''}`,
      confidence,
      payload: { login: u.login, avatar: u.avatar_url, html_url: html },
    };
  });
}
