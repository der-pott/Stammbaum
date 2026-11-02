#!/bin/bash
# Optimize ein Bild für den Stammbaum:
# 1. Dekodiert JPEG/PNG/WEBP/HEIC → arbeitet in sRGB
# 2. Auto-Trim: schneidet gleichfarbige Ränder weg (Fuzz 15%). Fallback: Original behalten, falls Trim zu aggressiv (> 55% weggeschnitten).
# 3. Max-Edge 2000px (Downscale, kein Upscale)
# 4. Auto-Orient (EXIF-Rotation anwenden)
# 5. JPEG q=85, strip EXIF
#
# Usage: optimize_image.sh <input> <output>
set -e
IN="$1"; OUT="$2"
if [ -z "$IN" ] || [ -z "$OUT" ]; then
  echo "usage: $0 <input> <output>" >&2; exit 2
fi

MAGICK=${MAGICK:-$(command -v magick || command -v convert)}

# Original-Dimensionen
ORIG_PIX=$("$MAGICK" identify -format "%w*%h" "$IN" 2>/dev/null)
ORIG_AREA=$(echo "$ORIG_PIX" | bc 2>/dev/null || python3 -c "a,b='$ORIG_PIX'.split('*');print(int(a)*int(b))")

FUZZ=${FUZZ:-25}
TMP=$(mktemp -t imgopt.XXXXXX).jpg
"$MAGICK" "$IN" -auto-orient -fuzz ${FUZZ}% -trim +repage -colorspace sRGB "$TMP" 2>/dev/null || cp "$IN" "$TMP"
TRIM_PIX=$("$MAGICK" identify -format "%w*%h" "$TMP" 2>/dev/null)
TRIM_AREA=$(python3 -c "a,b='$TRIM_PIX'.split('*');print(int(a)*int(b))" 2>/dev/null || echo 0)

RATIO=$(python3 -c "print(f'{$TRIM_AREA/$ORIG_AREA:.3f}')" 2>/dev/null)
# Zu aggressiv wenn weniger als 50% der Fläche übrig bleibt
TOO_AGGRESSIVE=$(python3 -c "print(1 if $RATIO < 0.50 else 0)" 2>/dev/null)

if [ "$TOO_AGGRESSIVE" = "1" ]; then
  "$MAGICK" "$IN" -auto-orient -colorspace sRGB -resize '2000x2000>' -strip -quality 85 "$OUT"
  rm -f "$TMP"
  echo "[no-trim] $IN → $OUT (ratio $RATIO zu aggressiv)"
else
  "$MAGICK" "$TMP" -resize '2000x2000>' -strip -quality 85 "$OUT"
  rm -f "$TMP"
  OUT_PIX=$("$MAGICK" identify -format "%w*%h" "$OUT" 2>/dev/null)
  echo "[trimmed] $IN ($ORIG_PIX) → $OUT ($OUT_PIX, ratio $RATIO)"
fi
