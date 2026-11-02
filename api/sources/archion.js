// Archion — paid login required. We return a courtesy pointer-hit.
import { nameParts } from '../http.js';

export const META = { label: 'Archion (ev. Kirchenbücher)', url: 'https://www.archion.de' };

export async function search(person) {
  const { full, surname } = nameParts(person);
  if (!surname) return [];
  const params = new URLSearchParams({ q: full });
  return [{
    source: 'archion',
    title: `Archion-Suche: ${full}`,
    url: `https://www.archion.de/de/suche/?${params.toString()}`,
    snippet: 'Zugang kostenpflichtig — Kirchenbücher der evangelischen Kirche. Suche manuell öffnen und Zugangsdaten verwenden.',
    confidence: 0,
    payload: { note: 'paywall', manual_check: true },
  }];
}
