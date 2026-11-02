// Country name → ISO-3166-1 alpha-2 → regional-indicator emoji flag.
// Focus: German-genealogy relevant countries. Extend as needed.

const NAME_TO_ISO = {
  'deutschland': 'DE', 'germany': 'DE', 'brd': 'DE', 'ddr': 'DE', 'deutsches reich': 'DE',
  'österreich': 'AT', 'oesterreich': 'AT', 'austria': 'AT',
  'schweiz': 'CH', 'switzerland': 'CH', 'suisse': 'CH',
  'frankreich': 'FR', 'france': 'FR',
  'italien': 'IT', 'italy': 'IT', 'italia': 'IT',
  'spanien': 'ES', 'spain': 'ES',
  'portugal': 'PT',
  'niederlande': 'NL', 'netherlands': 'NL', 'holland': 'NL',
  'belgien': 'BE', 'belgium': 'BE',
  'luxemburg': 'LU', 'luxembourg': 'LU',
  'dänemark': 'DK', 'daenemark': 'DK', 'denmark': 'DK',
  'schweden': 'SE', 'sweden': 'SE',
  'norwegen': 'NO', 'norway': 'NO',
  'finnland': 'FI', 'finland': 'FI',
  'polen': 'PL', 'poland': 'PL',
  'tschechien': 'CZ', 'czech republic': 'CZ', 'czechia': 'CZ', 'böhmen': 'CZ', 'boehmen': 'CZ',
  'slowakei': 'SK', 'slovakia': 'SK',
  'ungarn': 'HU', 'hungary': 'HU',
  'rumänien': 'RO', 'rumaenien': 'RO', 'romania': 'RO',
  'bulgarien': 'BG', 'bulgaria': 'BG',
  'griechenland': 'GR', 'greece': 'GR',
  'türkei': 'TR', 'tuerkei': 'TR', 'turkey': 'TR',
  'russland': 'RU', 'russia': 'RU', 'ussr': 'RU', 'sowjetunion': 'RU',
  'ukraine': 'UA',
  'belarus': 'BY', 'weißrussland': 'BY', 'weissrussland': 'BY',
  'litauen': 'LT', 'lithuania': 'LT',
  'lettland': 'LV', 'latvia': 'LV',
  'estland': 'EE', 'estonia': 'EE',
  'kroatien': 'HR', 'croatia': 'HR',
  'serbien': 'RS', 'serbia': 'RS',
  'bosnien': 'BA', 'bosnia': 'BA',
  'slowenien': 'SI', 'slovenia': 'SI',
  'jugoslawien': 'RS', 'yugoslavia': 'RS',
  'großbritannien': 'GB', 'grossbritannien': 'GB', 'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'schottland': 'GB',
  'irland': 'IE', 'ireland': 'IE',
  'usa': 'US', 'vereinigte staaten': 'US', 'united states': 'US', 'amerika': 'US',
  'kanada': 'CA', 'canada': 'CA',
  'mexiko': 'MX', 'mexico': 'MX',
  'brasilien': 'BR', 'brazil': 'BR',
  'argentinien': 'AR', 'argentina': 'AR',
  'australien': 'AU', 'australia': 'AU',
  'neuseeland': 'NZ', 'new zealand': 'NZ',
  'japan': 'JP', 'nippon': 'JP',
  'china': 'CN',
  'indien': 'IN', 'india': 'IN',
  'südafrika': 'ZA', 'suedafrika': 'ZA', 'south africa': 'ZA',
  'israel': 'IL',
  'palästina': 'PS', 'palaestina': 'PS', 'palestine': 'PS',
  'ägypten': 'EG', 'aegypten': 'EG', 'egypt': 'EG',
  'preußen': 'DE', 'preussen': 'DE',
  'bayern': 'DE', 'sachsen': 'DE', 'schlesien': 'PL', 'pommern': 'DE', 'ostpreußen': 'PL', 'ostpreussen': 'PL',
};

export function isoFromCountry(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  if (NAME_TO_ISO[key]) return NAME_TO_ISO[key];
  // Try first word (e.g. "Deutschland (Preußen)" → "deutschland")
  const first = key.split(/[\s,(]/)[0];
  return NAME_TO_ISO[first] || null;
}

export function flagForCountry(name) {
  const iso = isoFromCountry(name);
  if (!iso) return '';
  // Regional indicator A = 0x1F1E6
  const base = 0x1F1E6;
  const codes = iso.toUpperCase().split('').map(c => base + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codes);
}
