#!/bin/bash
# Rück-Optimierung aller bereits hochgeladenen Bilder auf dem VPS.
# - Backup nach /data/images.backup-YYYYMMDD/
# - Durchläuft alle Dateien in /data/images/
# - Wendet optimize_image.sh an (Auto-Trim, Resize, JPEG q85)
# - Updated images.mime in DB auf image/jpeg
#
# Usage: optimize_vps_images.sh [--dry-run]
#
# Läuft remote per docker exec. Script wird nicht in Container kopiert — statt
# dessen Bytes per docker cp hin und her.
set -e
DRY=${1:-}

echo "== Backup der Bilder =="
ssh vps "docker exec stammbaum-api sh -c 'cp -rn /data/images /data/images.backup-$(date +%Y%m%d) 2>/dev/null; ls -la /data | head -5'"

echo "== Liste der Bilder =="
IDS=$(ssh vps "docker exec stammbaum-api ls /data/images/" | tr -d '\r')
TOTAL=$(echo "$IDS" | wc -l | tr -d ' ')
echo "Gesamt: $TOTAL Dateien"

if [ "$DRY" = "--dry-run" ]; then
  echo "DRY-RUN: ersten 3 anzeigen"
  echo "$IDS" | head -3
  exit 0
fi

WORK=$(mktemp -d -t imgopt.XXXXXX)
echo "Arbeite in $WORK"

I=0
for id in $IDS; do
  I=$((I+1))
  [ -z "$id" ] && continue
  IN="$WORK/$id.in"
  OUT="$WORK/$id.out"
  # Pull bytes
  ssh vps "docker exec stammbaum-api cat /data/images/$id" > "$IN" 2>/dev/null
  SZ_BEFORE=$(stat -f %z "$IN" 2>/dev/null || stat -c %s "$IN")
  if [ "$SZ_BEFORE" -lt 100 ]; then
    echo "[$I/$TOTAL] $id: zu klein ($SZ_BEFORE B), überspringe"
    continue
  fi
  # Optimize
  FUZZ=25 /Users/maximilianpott/Projects/Stammbaum/scripts/optimize_image.sh "$IN" "$OUT" >/dev/null 2>&1 || {
    echo "[$I/$TOTAL] $id: Optimierung fehlgeschlagen, überspringe"
    continue
  }
  SZ_AFTER=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
  # Push bytes zurück
  cat "$OUT" | ssh vps "docker exec -i stammbaum-api sh -c 'cat > /data/images/$id'"
  # Mime-Type auf JPEG setzen — über node + better-sqlite3 (sqlite3 CLI nicht im Container)
  ssh vps "docker exec stammbaum-api node -e \"require('better-sqlite3')('/data/stammbaum.db').prepare('UPDATE images SET mime=?, bytes=? WHERE id=?').run('image/jpeg', $SZ_AFTER, '$id')\"" 2>/dev/null || true
  PCT=$(python3 -c "print(f'{100*$SZ_AFTER/$SZ_BEFORE:.1f}')")
  echo "[$I/$TOTAL] $id: ${SZ_BEFORE}B → ${SZ_AFTER}B (${PCT}%)"
done

rm -rf "$WORK"
echo "DONE"
