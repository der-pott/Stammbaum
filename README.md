# Stammbaum

Familien-Stammbaum mit optionaler KI-Ahnenforschung. Erreichbar unter `stammbaum.p-m-pott.de`.

## Features

- Personenverwaltung (Namen, Daten, Geburts-/Sterbeort, Notizen)
- Beziehungen: Eltern → Kind, Ehepartner
- Automatische Stammbaum-Visualisierung (SVG, Generationen-Layout)
- KI-Ahnenforschung via Anthropic (Modell `claude-opus-4-7`, strukturierte Vorschläge für Eltern/Geschwister/Hypothesen)

## KI-Setup

```bash
# auf dem VPS
echo 'ANTHROPIC_API_KEY=sk-ant-api03-...' | ssh vps 'cat > /srv/projects/stammbaum/.env && chmod 600 /srv/projects/stammbaum/.env'
./scripts/deploy.sh --api
```

Ohne Key liefert `/api/ai/research` 503. Rate-Limit: 10 Calls / Minute / IP.

## Auth (PIN)

Zwei Rollen: `editor` (voller Zugriff) und `viewer` (nur Lesen). Ohne Login
liefert jede API-Route außer `/api/auth/*` und `/api/health` 401, das Frontend
zeigt einen Login-Dialog.

Erstes Setup auf dem VPS:

```bash
ssh vps 'cat >> /srv/projects/stammbaum/.env <<EOF
SB_INIT_EDITOR_PIN=dein-editor-pin
SB_INIT_VIEWER_PIN=dein-viewer-pin
EOF'
./scripts/deploy.sh --api
```

Beim ersten Container-Start werden die PINs scrypt-gehasht in der Tabelle `pins`
abgelegt. Danach ignoriert der Service die Env-Werte — zum Ändern den jeweiligen
Eintrag in `pins` löschen und neu deployen. Login-Rate-Limit: 5 Versuche /
Minute / IP. Session-Cookie `sb_session` (HttpOnly, SameSite=strict, 30 Tage).

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
POST   /api/ai/research         { person_id, prompt? }   # 10 req/min/IP
GET    /api/ai/runs/:person_id

Antwortformat /api/ai/research:
{
  id, status, model, person,
  eltern: [{name, rolle, geburt, sterbe, ort, quellenhinweis}],
  geschwister: [{name, geburt, ort, quellenhinweis}],
  hypothesen: [string],
  quellen_vorschlag: [string]
}
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
