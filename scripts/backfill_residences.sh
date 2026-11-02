#!/bin/bash
# Backfill Wohnort-Einträge: parst Freitext `place` in strukturierte Felder.
# Usage:
#   bash scripts/backfill_residences.sh           # dry-run
#   bash scripts/backfill_residences.sh --commit  # tatsächlich PATCHen
set -euo pipefail

COMMIT=0
[ "${1:-}" = "--commit" ] && COMMIT=1

API=https://stammbaum.p-m-pott.de
COOKIE=$(mktemp -t sbcookie.XXXXXX)
trap 'rm -f "$COOKIE"' EXIT

curl -sc "$COOKIE" -X POST "$API/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"role":"editor","pin":"060481"}' >/dev/null

# Parsing-Logik in Python (STDIN JSON → STDOUT patch-body JSON oder leer)
# Nutzt subprocess, aber Python wird nur für den EINEN Parse-Call per Row aufgerufen.
PARSER=$(cat <<'PY'
import json, re, sys

BERLIN_DISTRICT_PLZ = {
    'Charlottenburg':'10585','Tiergarten':'10785','Moabit':'10551','Mitte':'10178',
    'Wedding':'13353','Spandau':'13585','Haselhorst':'13599','Siemensstadt':'13629',
    'Tegel':'13507','Reinickendorf':'13407','Wittenau':'13469','Neukölln':'12043',
    'Britz':'12347','Treptow':'12435','Steglitz':'12163','Köpenick':'12555',
    'Lichtenberg':'10367','Schöneberg':'10781','Kreuzberg':'10961','Friedrichshain':'10243',
    'Pankow':'13187','Prenzlauer Berg':'10405','Zehlendorf':'14163','Wilmersdorf':'10707',
}
BERLIN_HIST = {
    'W 35':'Tiergarten','NW 7':'Mitte','W 8':'Mitte','W 9':'Tiergarten','W 10':'Tiergarten',
    'W 30':'Schöneberg','W 50':'Schöneberg','W 57':'Schöneberg','W 15':'Wilmersdorf','W 1':'Tiergarten',
    'NW 21':'Moabit','NW 23':'Tiergarten','NW 40':'Tiergarten','NW 87':'Moabit',
    'N 4':'Mitte','N 20':'Wedding','N 24':'Mitte','N 31':'Wedding','N 54':'Prenzlauer Berg',
    'N 58':'Prenzlauer Berg','N 65':'Wedding',
    'O 17':'Friedrichshain','O 27':'Friedrichshain','SO 36':'Kreuzberg',
    'S 14':'Mitte','S 42':'Kreuzberg','S 59':'Neukölln',
    'SW 11':'Kreuzberg','SW 29':'Kreuzberg','SW 61':'Kreuzberg','SW 68':'Kreuzberg',
}
CITY_META = {
    'Minden':('32423','Nordrhein-Westfalen','Deutschland'),
    'Werder (Havel)':('14542','Brandenburg','Deutschland'),
    'Werder/Havel':('14542','Brandenburg','Deutschland'),
    'Werder':('14542','Brandenburg','Deutschland'),
    'Potsdam':('14467','Brandenburg','Deutschland'),
    'Duisburg':('47051','Nordrhein-Westfalen','Deutschland'),
    'Grasberg':('28879','Niedersachsen','Deutschland'),
    'Bochum':('44787','Nordrhein-Westfalen','Deutschland'),
    'Recklinghausen':('45657','Nordrhein-Westfalen','Deutschland'),
    'Hattingen':('45525','Nordrhein-Westfalen','Deutschland'),
    'Dortmund':('44135','Nordrhein-Westfalen','Deutschland'),
    'Iserlohn':('58644','Nordrhein-Westfalen','Deutschland'),
    'Eutin':('23701','Schleswig-Holstein','Deutschland'),
    'Münster':('48143','Nordrhein-Westfalen','Deutschland'),
    'München':('80331','Bayern','Deutschland'),
    'Hamburg':('20095','Hamburg','Deutschland'),
    'Köln':('50667','Nordrhein-Westfalen','Deutschland'),
    'Frankfurt':('60311','Hessen','Deutschland'),
    'Wien':('1010','Wien','Österreich'),
    'Lübeck':('23552','Schleswig-Holstein','Deutschland'),
    'Gröbenzell':('82194','Bayern','Deutschland'),
    'Kiel':('24103','Schleswig-Holstein','Deutschland'),
    'Essen':('45127','Nordrhein-Westfalen','Deutschland'),
    'Düsseldorf':('40213','Nordrhein-Westfalen','Deutschland'),
    'Hannover':('30159','Niedersachsen','Deutschland'),
    'Leipzig':('04109','Sachsen','Deutschland'),
    'Dresden':('01067','Sachsen','Deutschland'),
    'Nürnberg':('90402','Bayern','Deutschland'),
    'Stuttgart':('70173','Baden-Württemberg','Deutschland'),
    'Bremen':('28195','Bremen','Deutschland'),
}

def parse(p):
    p = (p or '').strip()
    if not p: return None
    out = {'street':None,'city':None,'district':None,'postal_code':None,
           'postal_code_historical':None,'region':None,'country':'Deutschland','_note':None}

    if 'Schwetz' in p or 'Świecie' in p:
        out.update(city='Świecie (hist. Schwetz)', postal_code='86-100',
                   region='Woiwodschaft Kujawien-Pommern (hist. Westpreußen)', country='Polen')
        return out
    if 'Michelsdorf' in p and ('Leobschütz' in p or 'Oberschlesien' in p):
        out.update(city='Michelsdorf (Kreis Leobschütz, hist. Oberschlesien)',
                   region='Woiwodschaft Oppeln (hist. Oberschlesien)', country='Polen',
                   _note='Historisch Oberschlesien, heute Polen (Oppeln). Michelsdorf (dt.) / Śmicz (poln.) unsicher - bitte prüfen.')
        return out
    if 'Obergrüne' in p and 'Iserlohn' in p:
        out.update(city='Iserlohn', district='Obergrüne', postal_code='58644', region='Nordrhein-Westfalen')
        return out

    # Erst historisches Postleitgebiet (W35, NW7, SO36 etc.) - vor dem allgemeinen Berlin-Ortsteil
    # Erlaubt sowohl 'Berlin W35' als auch 'Berlin W 35', mit optional Komma + Straße.
    m = re.match(r'^Berlin[-\s]+([NSOWnswo]{1,3})\s*(\d{1,3})(?:,\s*(.+))?$', p)
    if m:
        hint = f'{m.group(1).upper()} {m.group(2)}'
        street = (m.group(3) or '').strip() or None
        district = BERLIN_HIST.get(hint)
        out.update(city='Berlin', street=street, district=district,
                   postal_code_historical=hint,
                   postal_code=BERLIN_DISTRICT_PLZ.get(district) if district else None,
                   region='Berlin')
        if not district:
            out['_note'] = f'Historisches Postleitgebiet {hint} nicht zugeordnet - Ortsteil + PLZ bitte manuell.'
        return out

    m = re.match(r'^Berlin[-\s]+([A-ZÄÖÜ][\wäöüß\-]+)(?:,\s*(.+))?$', p)
    if m:
        district = m.group(1).strip()
        street = (m.group(2) or '').strip() or None
        out.update(city='Berlin', district=district, street=street,
                   postal_code=BERLIN_DISTRICT_PLZ.get(district), region='Berlin')
        if not out['postal_code']:
            out['_note'] = f'PLZ für Berlin-{district} nicht in Default-Liste - bitte prüfen.'
        return out

    m = re.match(r'^Berlin,\s*(.+)$', p)
    if m:
        street = m.group(1).strip()
        out.update(city='Berlin', street=street, region='Berlin')
        if 'Oldenburger' in street: out.update(district='Moabit', postal_code='10551')
        elif 'Bernauer' in street: out.update(district='Tegel', postal_code='13507')
        else: out['_note'] = 'Berlin-Ortsteil / PLZ aus Straßenname nicht abgeleitet - bitte manuell.'
        return out

    if p == 'Berlin':
        out.update(city='Berlin', region='Berlin')
        return out

    m = re.match(r'^(Werder\s*\(Havel\)|Werder/Havel|Werder),\s*(.+)$', p)
    if m:
        out.update(city='Werder (Havel)', street=m.group(2).strip(),
                   postal_code='14542', region='Brandenburg')
        return out

    m = re.match(r'^([A-ZÄÖÜ][\wäöüß\-\s\(\)]+?),\s*(.+)$', p)
    if m:
        city = m.group(1).strip()
        street = m.group(2).strip()
        if city in CITY_META:
            plz, region, country = CITY_META[city]
            out.update(city=city, street=street, postal_code=plz, region=region, country=country)
            return out

    if p in CITY_META:
        plz, region, country = CITY_META[p]
        out.update(city=p, postal_code=plz, region=region, country=country)
        return out

    for d, plz in BERLIN_DISTRICT_PLZ.items():
        if p == d or p == f'Berlin-{d}':
            out.update(city='Berlin', district=d, postal_code=plz, region='Berlin')
            return out

    out['_note'] = 'Parse-Heuristik erkennt diesen Freitext nicht - bitte manuell strukturieren.'
    return out

row = json.loads(sys.stdin.read())
parsed = parse(row.get('place'))
if not parsed:
    print(''); sys.exit(0)
note_hint = parsed.pop('_note', None)
body = {k: v for k, v in parsed.items() if v is not None}
if note_hint:
    existing = (row.get('notes') or '').strip()
    sep = '\n' if existing else ''
    body['notes'] = existing + sep + '[Backfill-Hinweis] ' + note_hint
print(json.dumps({'patch': body, 'note_hint': note_hint}, ensure_ascii=False))
PY
)

PERSONS=$(curl -sb "$COOKIE" "$API/api/persons")
TOTAL=0
UPDATED=0
GRENZ=()

TMP_PERSONS=$(mktemp -t sbp.XXXXXX)
echo "$PERSONS" | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    name = (p.get('given_name') or '') + ' ' + (p.get('surname') or '')
    print(p['id'] + '|' + name.strip())
" > "$TMP_PERSONS"

while IFS='|' read -r PID NAME; do
  [ -z "$PID" ] && continue
  RES=$(curl -sb "$COOKIE" "$API/api/persons/$PID/residences")
  TMP_ROWS=$(mktemp -t sbr.XXXXXX)
  echo "$RES" | python3 -c "
import json, sys
for r in json.load(sys.stdin):
    if r.get('city') or r.get('street') or r.get('postal_code'):
        continue
    print(r['id'] + '::' + json.dumps(r, ensure_ascii=False))
" > "$TMP_ROWS"
  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    RID="${LINE%%::*}"
    JSON="${LINE#*::}"
    PARSED=$(printf '%s' "$JSON" | python3 -c "$PARSER" 2>/dev/null || true)
    [ -z "$PARSED" ] && continue
    PATCH_BODY=$(printf '%s' "$PARSED" | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d['patch'],ensure_ascii=False))")
    NOTE=$(printf '%s' "$PARSED" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('note_hint') or '')")
    PLACE=$(printf '%s' "$JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('place',''))")
    FLAG='[DRY ]'
    [ "$COMMIT" = "1" ] && FLAG='[PATCH]'
    echo "$FLAG $NAME · $PLACE → $PATCH_BODY"
    [ -n "$NOTE" ] && echo "       Grenzfall: $NOTE"
    if [ "$COMMIT" = "1" ]; then
      curl -sb "$COOKIE" -X PATCH "$API/api/persons/$PID/residences/$RID" \
        -H 'content-type: application/json' -d "$PATCH_BODY" >/dev/null
    fi
  done < "$TMP_ROWS"
  rm -f "$TMP_ROWS"
done < "$TMP_PERSONS"
rm -f "$TMP_PERSONS"

echo ""
echo "=== Backfill fertig (COMMIT=$COMMIT) ==="
