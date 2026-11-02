#!/usr/bin/env python3
# Backfill-Script für Wohnort-Einträge: parst den freitext `place` in strukturierte
# Felder (street, city, district, postal_code, region, country, postal_code_historical).
#
# Usage:
#   python3 scripts/backfill_residences.py                 # dry-run, listet geplante Updates
#   python3 scripts/backfill_residences.py --commit        # tatsächlich PATCHen
#
# Login via PIN 060481 (editor).
import sys
import re
import json
import urllib.request
import urllib.parse
import http.cookiejar

API = 'https://stammbaum.p-m-pott.de'

# Berlin-Ortsteil → aktuelle 5-stellige PLZ (grobe Default-Zuordnung Zentrum)
BERLIN_DISTRICT_PLZ = {
    'Charlottenburg':  '10585',
    'Tiergarten':      '10785',
    'Moabit':          '10551',
    'Mitte':           '10178',
    'Wedding':         '13353',
    'Spandau':         '13585',
    'Haselhorst':      '13599',
    'Siemensstadt':    '13629',
    'Tegel':           '13507',
    'Reinickendorf':   '13407',
    'Wittenau':        '13469',
    'Neukölln':        '12043',
    'Britz':           '12347',
    'Treptow':         '12435',
    'Steglitz':        '12163',
    'Köpenick':        '12555',
    'Lichtenberg':     '10367',
    'Schöneberg':      '10781',
    'Kreuzberg':       '10961',
    'Friedrichshain':  '10243',
    'Pankow':          '13187',
    'Prenzlauer Berg': '10405',
    'Zehlendorf':      '14163',
    'Wilmersdorf':     '10707',
}

# Berlin Postleitgebiet (vor 1961) → heutiger Ortsteil (grobe Zuordnung)
# W = West, N = Nord, O = Ost, S = Süd (+ Zwischen-Himmelsrichtungen)
BERLIN_HIST_TO_DISTRICT = {
    'W 1': 'Tiergarten',  'W 8': 'Mitte',
    'W 9': 'Tiergarten',  'W 10': 'Tiergarten', 'W 15': 'Wilmersdorf',
    'W 30': 'Schöneberg', 'W 35': 'Tiergarten', 'W 50': 'Schöneberg',
    'W 57': 'Schöneberg',
    'NW 7': 'Mitte', 'NW 21': 'Moabit', 'NW 23': 'Tiergarten',
    'NW 40': 'Tiergarten', 'NW 87': 'Moabit',
    'N 4': 'Mitte', 'N 20': 'Wedding', 'N 24': 'Mitte', 'N 31': 'Wedding',
    'N 54': 'Prenzlauer Berg', 'N 58': 'Prenzlauer Berg', 'N 65': 'Wedding',
    'O 17': 'Friedrichshain', 'O 27': 'Friedrichshain',
    'SO 36': 'Kreuzberg',
    'S 14': 'Mitte', 'S 42': 'Kreuzberg', 'S 59': 'Neukölln',
    'SW 11': 'Kreuzberg', 'SW 29': 'Kreuzberg', 'SW 61': 'Kreuzberg',
    'SW 68': 'Kreuzberg',
}

# Nicht-Berlin: Stadt → (PLZ-Default-Innenstadt, Region)
CITY_META = {
    'Minden':         ('32423', 'Nordrhein-Westfalen', 'Deutschland'),
    'Werder (Havel)': ('14542', 'Brandenburg',          'Deutschland'),
    'Werder/Havel':   ('14542', 'Brandenburg',          'Deutschland'),
    'Potsdam':        ('14467', 'Brandenburg',          'Deutschland'),
    'Duisburg':       ('47051', 'Nordrhein-Westfalen',  'Deutschland'),
    'Grasberg':       ('28879', 'Niedersachsen',        'Deutschland'),
    'Bochum':         ('44787', 'Nordrhein-Westfalen',  'Deutschland'),
    'Recklinghausen': ('45657', 'Nordrhein-Westfalen',  'Deutschland'),
    'Hattingen':      ('45525', 'Nordrhein-Westfalen',  'Deutschland'),
    'Dortmund':       ('44135', 'Nordrhein-Westfalen',  'Deutschland'),
    'Iserlohn':       ('58644', 'Nordrhein-Westfalen',  'Deutschland'),
    'Eutin':          ('23701', 'Schleswig-Holstein',   'Deutschland'),
    'Münster':        ('48143', 'Nordrhein-Westfalen',  'Deutschland'),
    'München':        ('80331', 'Bayern',               'Deutschland'),
    'Hamburg':        ('20095', 'Hamburg',              'Deutschland'),
    'Köln':           ('50667', 'Nordrhein-Westfalen',  'Deutschland'),
    'Frankfurt':      ('60311', 'Hessen',               'Deutschland'),
    'Wien':           ('1010',  'Wien',                 'Österreich'),
}

def normalize_city(c):
    return c.strip()

def parse_place(place, notes_hint=''):
    """
    Returns dict with structured keys. Falls Parsing scheitert, bleibt Original als
    place freitext und wir setzen `_note` als Hinweis.
    """
    p = (place or '').strip()
    if not p:
        return None
    out = {
        'street': None, 'city': None, 'district': None,
        'postal_code': None, 'postal_code_historical': None,
        'region': None, 'country': 'Deutschland',
        '_note': None,
    }

    # Spezialfälle: Hinweise im Text
    if 'Schwetz' in p or 'Świecie' in p:
        out['city'] = 'Świecie (hist. Schwetz)'
        out['postal_code'] = '86-100'
        out['region'] = 'Woiwodschaft Kujawien-Pommern (hist. Westpreußen)'
        out['country'] = 'Polen'
        return out

    if 'Michelsdorf' in p and ('Leobschütz' in p or 'Oberschlesien' in p):
        out['city'] = 'Michelsdorf (Kreis Leobschütz, hist. Oberschlesien)'
        out['region'] = 'Woiwodschaft Oppeln (hist. Oberschlesien)'
        out['country'] = 'Polen'
        out['_note'] = 'Historisch Oberschlesien, heute Polen (Oppeln). Genaue Zuordnung Gemeinde Michelsdorf (dt.) / Śmicz (poln.) unsicher — bitte prüfen.'
        return out

    if 'Obergrüne' in p and 'Iserlohn' in p:
        out['city'] = 'Iserlohn'
        out['district'] = 'Obergrüne'
        out['postal_code'] = '58644'
        out['region'] = 'Nordrhein-Westfalen'
        return out

    # Berlin-Varianten
    m = re.match(r'^Berlin[-\s]+([A-ZÄÖÜ][\wäöüß\-]+)(?:,\s*(.+))?$', p)
    if m:
        # „Berlin-Tegel, Bernauer Straße 96"
        district = m.group(1).strip()
        street = (m.group(2) or '').strip() or None
        out['city'] = 'Berlin'
        out['district'] = district
        out['street'] = street
        out['postal_code'] = BERLIN_DISTRICT_PLZ.get(district)
        out['region'] = 'Berlin'
        if not out['postal_code']:
            out['_note'] = f'PLZ für Berlin-{district} nicht in Default-Liste — bitte prüfen.'
        return out

    # „Berlin W35, Woyrschstraße 26"
    m = re.match(r'^Berlin\s+([NSOWnswo]{1,3})\s*(\d{1,3}),?\s*(.+)?$', p)
    if m:
        hint = f'{m.group(1).upper()} {m.group(2)}'
        street = (m.group(3) or '').strip() or None
        district = BERLIN_HIST_TO_DISTRICT.get(hint)
        out['city'] = 'Berlin'
        out['street'] = street
        out['district'] = district
        out['postal_code_historical'] = hint
        out['postal_code'] = BERLIN_DISTRICT_PLZ.get(district) if district else None
        out['region'] = 'Berlin'
        if not district:
            out['_note'] = f'Historisches Postleitgebiet {hint} nicht zugeordnet — Ortsteil + aktuelle PLZ bitte manuell setzen.'
        return out

    # „Berlin, Oldenburger Straße 22"
    m = re.match(r'^Berlin,\s*(.+)$', p)
    if m:
        street = m.group(1).strip()
        out['city'] = 'Berlin'
        out['street'] = street
        out['region'] = 'Berlin'
        # Heuristik: wenn „Oldenburger" → Moabit, sonst unbekannt
        if 'Oldenburger' in street: out['district'] = 'Moabit'; out['postal_code'] = '10551'
        elif 'Bernauer' in street:  out['district'] = 'Tegel';  out['postal_code'] = '13507'
        else:
            out['_note'] = 'Berlin-Ortsteil / PLZ aus Straßenname nicht abgeleitet — bitte manuell setzen.'
        return out

    # „Berlin" allein
    if p == 'Berlin':
        out['city'] = 'Berlin'
        out['region'] = 'Berlin'
        return out

    # „Werder (Havel), Brandenburger Straße 160"
    m = re.match(r'^(Werder\s*\(Havel\)|Werder/Havel|Werder),\s*(.+)$', p)
    if m:
        street = m.group(2).strip()
        out['city'] = 'Werder (Havel)'
        out['street'] = street
        out['postal_code'] = '14542'
        out['region'] = 'Brandenburg'
        return out

    # „Minden, Marienglacis 29"
    m = re.match(r'^([A-ZÄÖÜ][\wäöüß\-\s\(\)]+?),\s*(.+)$', p)
    if m:
        city = m.group(1).strip()
        street = m.group(2).strip()
        if city in CITY_META:
            plz, region, country = CITY_META[city]
            out['city'] = city
            out['street'] = street
            out['postal_code'] = plz
            out['region'] = region
            out['country'] = country
            return out

    # Nur Stadtname ohne Straße
    if p in CITY_META:
        plz, region, country = CITY_META[p]
        out['city'] = p
        out['postal_code'] = plz
        out['region'] = region
        out['country'] = country
        return out

    # Berlin-Ortsteil ohne „Berlin-" Prefix (seltener Fall)
    for d, plz in BERLIN_DISTRICT_PLZ.items():
        if p == d or p == f'Berlin-{d}':
            out['city'] = 'Berlin'
            out['district'] = d
            out['postal_code'] = plz
            out['region'] = 'Berlin'
            return out

    out['_note'] = f'Parse-Heuristik erkennt diesen Freitext nicht — bitte manuell strukturieren.'
    return out


# API Helpers
class Api:
    def __init__(self):
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))

    UA = 'Stammbaum-Backfill/1.0 (python-urllib)'

    def login(self):
        req = urllib.request.Request(
            f'{API}/api/auth/login',
            data=json.dumps({'role': 'editor', 'pin': '060481'}).encode(),
            headers={'content-type': 'application/json', 'user-agent': self.UA, 'accept': 'application/json'},
            method='POST',
        )
        self.opener.open(req).read()

    def get(self, path):
        req = urllib.request.Request(f'{API}{path}', headers={'user-agent': self.UA, 'accept': 'application/json'})
        return json.loads(self.opener.open(req).read())

    def patch(self, path, body):
        req = urllib.request.Request(
            f'{API}{path}',
            data=json.dumps(body).encode(),
            headers={'content-type': 'application/json', 'user-agent': self.UA, 'accept': 'application/json'},
            method='PATCH',
        )
        return json.loads(self.opener.open(req).read())


def main():
    commit = '--commit' in sys.argv
    api = Api()
    api.login()

    persons = api.get('/api/persons')
    total = 0
    updated = 0
    grenzfaelle = []
    pro_person = {}

    for p in persons:
        pid = p['id']
        name = f"{p.get('given_name') or ''} {p.get('surname') or ''}".strip()
        try:
            residences = api.get(f'/api/persons/{pid}/residences')
        except Exception as e:
            print(f'[WARN] {name}: residences fetch failed: {e}')
            continue
        for r in residences:
            total += 1
            # Überspringen wenn strukturierte Felder schon gefüllt
            if r.get('city') or r.get('street') or r.get('postal_code'):
                continue
            parsed = parse_place(r.get('place'), r.get('notes') or '')
            if not parsed:
                continue
            note_hint = parsed.pop('_note', None)
            patch_body = {k: v for k, v in parsed.items() if v is not None}
            if note_hint:
                existing_notes = (r.get('notes') or '').strip()
                extra = f'\n[Backfill-Hinweis] {note_hint}' if existing_notes else f'[Backfill-Hinweis] {note_hint}'
                patch_body['notes'] = existing_notes + extra
                grenzfaelle.append(f"  - {name}: '{r.get('place')}' → {note_hint}")
            flag = '[PATCH]' if commit else '[DRY ]'
            print(f'{flag} {name} · {r.get("place")} → {json.dumps(patch_body, ensure_ascii=False)}')
            if commit:
                api.patch(f'/api/persons/{pid}/residences/{r["id"]}', patch_body)
            updated += 1
            pro_person[name] = pro_person.get(name, 0) + 1

    print()
    print(f'=== Summary ===')
    print(f'Total residences gefunden:    {total}')
    print(f'{"PATCHed" if commit else "Würde PATCHen"}: {updated}')
    print(f'Pro Person:')
    for n, c in sorted(pro_person.items()):
        print(f'  - {n}: {c}')
    if grenzfaelle:
        print(f'\nGrenzfälle:')
        for g in grenzfaelle:
            print(g)


if __name__ == '__main__':
    main()
