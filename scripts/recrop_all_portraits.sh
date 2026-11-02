#!/bin/bash
# Alle als Portrait markierten Bilder neu mit Face-Detection croppen.
# Nutzt /data/images.backup-20261102/ als Original-Quelle,
# ersetzt in /data/images/ und updated bytes.
set -e

COOKIE=/tmp/stammbaum_jar
curl -sc $COOKIE -X POST https://stammbaum.p-m-pott.de/api/auth/login \
  -H 'content-type: application/json' -d '{"role":"editor","pin":"060481"}' >/dev/null

# Alle Personen mit portrait_image_id
curl -sb $COOKIE "https://stammbaum.p-m-pott.de/api/persons" \
  | python3 -c "
import json, sys
ps = json.load(sys.stdin)
for p in ps:
  pid = p.get('portrait_image_id')
  if pid:
    print(f\"{pid}|{p.get('given_name','')} {p.get('surname','')}\")" \
  | while IFS='|' read -r PID NAME; do
      TMPIN=$(mktemp -t portin.XXXXXX).jpg
      TMPOUT=$(mktemp -t portout.XXXXXX).jpg
      # WICHTIG: KEIN ssh -n hier. Vorher: `ssh -n ... < /dev/null` oder `ssh -n` LEERTE
      # beim nächsten Push-Call stdin → der Push-cat kam leer an und schrieb 0-Byte-Files.
      # Fix: < /dev/null auf den pull-Call setzen (ssh ohne -n), damit der read-Loop
      # weiterhin aus /tmp/portraits.lst speisen kann.
      ssh vps "docker exec stammbaum-api cat /data/images.backup-20261102/images/$PID" < /dev/null > "$TMPIN" 2>/dev/null
      if [ ! -s "$TMPIN" ]; then
        echo "SKIP $NAME ($PID): kein Backup"
        rm -f "$TMPIN" "$TMPOUT"
        continue
      fi
      /tmp/img-env/bin/python /Users/maximilianpott/Projects/Stammbaum/scripts/portrait_crop.py \
        "$TMPIN" "$TMPOUT" --size 1200 2>&1 | sed "s/^/[$NAME] /"
      SZ=$(stat -f %z "$TMPOUT")
      cat "$TMPOUT" | ssh vps "docker exec -i stammbaum-api sh -c 'cat > /data/images/$PID'"
      ssh vps "docker exec stammbaum-api node -e \"require('better-sqlite3')('/data/stammbaum.db').prepare('UPDATE images SET mime=?, bytes=? WHERE id=?').run('image/jpeg', $SZ, '$PID')\"" < /dev/null 2>/dev/null
      # Sanity check: wenn remote bytes != lokal → push ist fehlgeschlagen
      REMOTE_SZ=$(ssh vps "docker exec stammbaum-api stat -c %s /data/images/$PID" < /dev/null)
      [ "$SZ" != "$REMOTE_SZ" ] && echo "  WARN: remote=$REMOTE_SZ ≠ lokal=$SZ"
      echo "  → bytes=$SZ"
      rm -f "$TMPIN" "$TMPOUT"
    done
echo "DONE"
