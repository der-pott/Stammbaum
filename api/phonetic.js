// Cologne Phonetics (Kölner Phonetik) — designed for German names.
// Returns a digit string; two names with the same code sound alike in German.
// Reference: Hans Joachim Postel, 1969.

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');
}

const VOWELS = new Set(['a','e','i','j','o','u','y']);

export function colognePhonetic(input) {
  const s = normalize(input);
  if (!s) return '';
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const prev = s[i-1];
    const next = s[i+1];
    let code = '';
    if (VOWELS.has(c))               code = '0';
    else if (c === 'b')              code = '1';
    else if (c === 'p' && next !== 'h') code = '1';
    else if (c === 'p' && next === 'h') code = '3';
    else if (c === 'd' || c === 't') {
      code = (next === 's' || next === 'c' || next === 'z') ? '8' : '2';
    }
    else if (c === 'f' || c === 'v' || c === 'w') code = '3';
    else if (c === 'g' || c === 'k' || c === 'q') code = '4';
    else if (c === 'c') {
      // very simplified German rules
      if (i === 0) {
        code = (next && 'ahkloqrux'.includes(next)) ? '4' : '8';
      } else if (prev && 'sz'.includes(prev)) {
        code = '8';
      } else if (next && 'ahkoqux'.includes(next)) {
        code = '4';
      } else {
        code = '8';
      }
    }
    else if (c === 'x') {
      code = (prev && 'ckq'.includes(prev)) ? '8' : '48';
    }
    else if (c === 'l') code = '5';
    else if (c === 'm' || c === 'n') code = '6';
    else if (c === 'r') code = '7';
    else if (c === 's' || c === 'z') code = '8';
    else if (c === 'h') code = '';
    // dedupe adjacent same codes
    for (const ch of code) {
      if (out.length === 0 || out[out.length-1] !== ch) out.push(ch);
    }
  }
  // Drop leading-'0' continuation (keep first if present) — Cologne spec keeps leading vowel code only at index 0.
  const first = out[0] || '';
  const rest = out.slice(1).filter(c => c !== '0');
  return (first + rest.join('')).replace(/^$/, '');
}

export function phoneticKey(given, surname) {
  const g = colognePhonetic(given || '');
  const s = colognePhonetic(surname || '');
  return `${g}|${s}`;
}
