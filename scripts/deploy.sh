#!/usr/bin/env bash
# Deploy Stammbaum via Git: push local master, pull on the VPS.
set -euo pipefail

HOST="${STAMMBAUM_HOST:-vps}"
REMOTE="/srv/projects/stammbaum"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Uncommitted changes — commit first." >&2
  exit 1
fi

git push origin master
ssh "$HOST" "cd $REMOTE && git pull --ff-only origin master && docker compose up -d"
echo "Deployed."
