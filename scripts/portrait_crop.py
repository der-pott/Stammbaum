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
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))

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
        # Großzügiges Padding für Portrait: Gesicht ca. 42% des Bildes
        box_size = max(fw, fh) * 2.4
        half = box_size / 2
        # Nach oben etwas mehr Platz für Haar/Stirn (Shift -8% der Box-Höhe)
        shift_up = box_size * 0.08
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
        method = f'face-crop (face {fw}x{fh} bei {x},{y})'

    # Resize auf Zielgröße
    crop_img = cv2.resize(crop_img, (size, size), interpolation=cv2.INTER_AREA)
    cv2.imwrite(out_path, crop_img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return {'method': method, 'out_size': (size, size), 'orig_size': (w, h)}


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
