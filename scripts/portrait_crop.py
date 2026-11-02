#!/usr/bin/env python3
# Face-detection Portrait-Crop für Stammbaum.
# Nutzt OpenCV Haar-Cascades für frontale Gesichter (robust, keine GPU/ML-models).
# Wenn kein Gesicht erkannt: Fallback = Center-Crop auf Quadrat.
#
# Usage: portrait_crop.py <input> <output> [--size 1200]
import sys, os, pathlib
import cv2
import numpy as np

def crop(in_path: str, out_path: str, size: int = 1200) -> dict:
    img = cv2.imread(in_path)
    if img is None:
        raise RuntimeError(f'cannot read {in_path}')
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade_path = pathlib.Path(cv2.data.haarcascades) / 'haarcascade_frontalface_default.xml'
    cascade = cv2.CascadeClassifier(str(cascade_path))
    # Mindest-Face = 8% der kleineren Bildseite — ignoriert Hintergrund-Gesichter
    # auf Gruppenfotos. Für 5712x3213 wären das 257px, nicht 60px.
    min_px = max(60, int(min(h, w) * 0.08))
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_px, min_px))

    if len(faces) == 0:
        # Fallback: center-crop auf Quadrat
        s = min(h, w)
        x1 = (w - s) // 2
        y1 = (h - s) // 2
        crop_img = img[y1:y1+s, x1:x1+s]
        method = 'center-crop (kein Gesicht erkannt)'
    else:
        # Nimm größtes Gesicht
        x, y, fw, fh = max(faces, key=lambda f: f[2]*f[3])
        cx = x + fw / 2
        cy = y + fh / 2
        # Dynamisches Padding: enges Portrait wenn Face groß (viel vom Bild);
        # großzügiger wenn Face klein (Gruppenfoto / Person im Kontext) damit
        # genug Pixel bleiben und kein brutaler Upscale nötig wird.
        face_px = max(fw, fh)
        if face_px >= 800:
            padding = 1.65    # face dominiert Bild → eng
        elif face_px >= 400:
            padding = 2.0     # mittelgroß
        else:
            padding = 3.0     # Gruppenfoto → mehr Kontext für genug Pixel
        box_size = face_px * padding
        half = box_size / 2
        # Nach oben leicht shiften (Haar/Stirn): 4% der Box
        shift_up = box_size * 0.04
        x1 = int(max(0, cx - half))
        y1 = int(max(0, cy - half - shift_up))
        x2 = int(min(w, cx + half))
        y2 = int(min(h, cy + half - shift_up))
        # Auf Quadrat beschneiden (nimm kleinste Dimension)
        side = min(x2 - x1, y2 - y1)
        x_center = (x1 + x2) // 2
        y_center = (y1 + y2) // 2
        x1 = max(0, x_center - side // 2)
        y1 = max(0, y_center - side // 2)
        x2 = min(w, x1 + side)
        y2 = min(h, y1 + side)
        crop_img = img[y1:y2, x1:x2]
        method = f'face-crop (face {fw}x{fh} bei {x},{y}, padding {padding}x)'

    # Kein Upscale über die native Crop-Größe hinaus. Max target_size, aber nie
    # größer als die kleinere Seite des Crops.
    crop_h, crop_w = crop_img.shape[:2]
    out_size = min(size, crop_h, crop_w)
    if out_size < size:
        method += f' (kein Upscale, nativ {out_size}px)'
    crop_img = cv2.resize(crop_img, (out_size, out_size), interpolation=cv2.INTER_AREA)
    cv2.imwrite(out_path, crop_img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return {'method': method, 'out_size': (out_size, out_size), 'orig_size': (w, h)}


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) < 2:
        print('usage: portrait_crop.py <input> <output> [--size N]', file=sys.stderr)
        sys.exit(2)
    size = 1200
    if '--size' in args:
        i = args.index('--size')
        size = int(args[i+1])
        del args[i:i+2]
    result = crop(args[0], args[1], size=size)
    print(f"{args[0]} → {args[1]}  [{result['method']}, {result['orig_size']} → {result['out_size']}]")
