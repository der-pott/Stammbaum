// Stolpersteine — Gedenken an NS-Opfer. Nur bei plausibler Betroffenheit.
// Kein direktes Such-API; nutzt sitewide Google-Suche über das Lookup der stolpersteine.eu.
import { httpGet, nameParts, yearOf } from '../http.js';

export const META = { label: 'Stolpersteine (NS-Opfer)', url: 'https://www.stolpersteine.eu' };

export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!surname) return [];
  const notes = (person.notes || '').toLowerCase();
  const d = yearOf(person.death_date);
  const inNS = (d && d >= 1933 && d <= 1945) ||
    notes.includes('jüdisch') || notes.includes('jude') || notes.includes('shoah') || notes.includes('holocaust') || notes.includes('ghetto') || notes.includes('kz') || notes.includes('deport');
  if (!inNS) return [];
  const url = `https://www.stolpersteine.eu/suchen?q=${encodeURIComponent(full)}`;
  const r = await httpGet('stolpersteine', url, { accept: 'text' });
  if (!r.ok) return [{ source: 'stolpersteine', title: 'Stolpersteine', url, snippet: 'Zugriff nicht möglich — manuell prüfen.', confidence: 0, payload: { error: r.error, manual_check: true } }];
  const body = r.body || '';
  if (body.toLowerCase().includes(surname.toLowerCase())) {
    return [{ source: 'stolpersteine', title: `Stolperstein-Suche: ${full}`, url, snippet: 'Möglicher Treffer auf stolpersteine.eu — manuell prüfen', confidence: 0.3, payload: { manual_check: true } }];
  }
  return [{ source: 'stolpersteine', title: 'Stolpersteine', url, snippet: 'Kein offensichtlicher Treffer.', confidence: 0, payload: { empty: true } }];
}
