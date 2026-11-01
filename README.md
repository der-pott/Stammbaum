# Stammbaum

Familien-Stammbaum mit optionaler KI-Ahnenforschung. Erreichbar unter `stammbaum.p-m-pott.de`.

## Features

- Personenverwaltung (Namen, Daten, Geburts-/Sterbeort, Notizen)
- Beziehungen: Eltern → Kind, Ehepartner
- Automatische Stammbaum-Visualisierung (SVG, Generationen-Layout)
- KI-Research-Endpunkt (Stub; LLM-Anbindung folgt via `ANTHROPIC_API_KEY`)

## Struktur

- `public/` — Frontend (statisch, kein Build-Step)
- `web/default.conf` — nginx-Cache-Konfig
- `api/` — Node/Express + SQLite (persons, edges, ai_runs)
- `compose.yaml` — nginx + api im `platform_proxy`-Netz
- `deploy/stammbaum.caddy` — Caddy-Site (routet `/api/*` zur API)
- `scripts/deploy.sh` — Push + VPS-Pull + Container-Reload (`--api` erzwingt Build)
- `data/` — SQLite-Volume (ignoriert, lebt auf dem VPS)

## API

```
GET    /api/health
GET    /api/persons
POST   /api/persons             { given_name, surname, gender, birth_date, ... }
GET    /api/persons/:id
PATCH  /api/persons/:id
DELETE /api/persons/:id
GET    /api/edges
POST   /api/edges               { from_id, to_id, type: parent|spouse, since?, until? }
DELETE /api/edges/:id
GET    /api/tree                { persons, edges }
POST   /api/ai/research         { person_id, prompt? }
GET    /api/ai/runs/:person_id
```

## Lokal

Browser auf `public/index.html` reicht fürs Skelett. Für Container-Test:

```bash
docker compose up -d
# Container läuft im platform_proxy-Netz, kein Port nach außen.
```

## Deploy

Erstmaliges Setup auf VPS (einmalig):

```bash
ssh vps 'sudo mkdir -p /srv/projects/stammbaum && sudo chown maxadmin: /srv/projects/stammbaum'
ssh vps 'git clone https://github.com/der-pott/Stammbaum.git /srv/projects/stammbaum'
scp deploy/stammbaum.caddy vps:/tmp/
ssh vps 'sudo mv /tmp/stammbaum.caddy /srv/platform/caddy/sites/ && sudo docker exec platform-caddy caddy reload --config /etc/caddy/Caddyfile'
ssh vps 'cd /srv/projects/stammbaum && docker compose up -d'
```

Danach reicht:

```bash
./scripts/deploy.sh
```

DNS: Cloudflare A-Record `stammbaum` → VPS-IP, Proxy an.
