# Stammbaum

Statische Seite unter `stammbaum.p-m-pott.de`, serviert von nginx im Docker-Container.

## Struktur

- `public/` — statische Seiten
- `web/default.conf` — nginx-Konfig mit Cache-Headern
- `compose.yaml` — nginx-Container im `platform_proxy`-Netz
- `deploy/stammbaum.caddy` — Caddy-Site für den VPS
- `scripts/deploy.sh` — Push + VPS-Pull + Container-Reload

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
ssh vps 'sudo mv /tmp/stammbaum.caddy /srv/platform/caddy/sites/ && sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile'
ssh vps 'cd /srv/projects/stammbaum && docker compose up -d'
```

Danach reicht:

```bash
./scripts/deploy.sh
```

DNS: Cloudflare A-Record `stammbaum` → VPS-IP, Proxy an.
