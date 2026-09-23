#!/usr/bin/env python3
"""Erzeugt die drei App-Icons: weißer Haken auf #1B1B1B.

Nur zum Neuerzeugen der Icons nötig, nicht für die App selbst.
Braucht Python 3 und Pillow:  python3 icons/make-icons.py
#1B1B1B ist das Grau der dunklen Homescreen-Icons (Bauanleitung 5.14) und
muss zu background_color in manifest.webmanifest passen, sonst zeichnet sich
beim Start der App ein Quadrat ab.
"""
from pathlib import Path
from PIL import Image, ImageDraw

BG = (0x1B, 0x1B, 0x1B)
FG = (255, 255, 255)
SS = 4                     # Überabtastung: groß zeichnen, verkleinern = glatte Kanten
OUT = Path(__file__).resolve().parent


def icon(size, scale):
    """scale: Größe des Hakens als Anteil der Kantenlänge (Breite ≈ 0,86 × scale)."""
    S = size * SS
    img = Image.new('RGB', (S, S), BG)
    d = ImageDraw.Draw(img)
    c, r = S / 2, S * scale

    # Häkchen wie in der App: kurzer Strich nach unten, langer nach oben rechts.
    # Die Punkte sind so gewählt, dass die Form um die Mitte liegt.
    pts = [(c - .42 * r, c + .02 * r), (c - .12 * r, c + .32 * r), (c + .44 * r, c - .30 * r)]
    w = .15 * r
    d.line(pts, fill=FG, width=round(w), joint='curve')
    for x, y in (pts[0], pts[-1]):                       # runde Enden
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=FG)
    return img.resize((size, size), Image.LANCZOS)


# Der Haken soll so groß wirken wie die Symbole der anderen Apps auf dem
# Homescreen: dort nehmen sie gut ein Drittel des Kreises ein.
# "maskable" (Homescreen): Android zeigt davon einen Kreis von gut 85 % der
# Kantenlänge — 32 % Hakenbreite ergeben dort die gewünschten ~37 %.
# "any" (Favicon, iOS) ist ganz sichtbar, deshalb etwas größer.
icon(192, .44).save(OUT / 'icon-192.png', optimize=True)
icon(512, .44).save(OUT / 'icon-512.png', optimize=True)
icon(512, .32).save(OUT / 'icon-maskable-512.png', optimize=True)
print('Icons geschrieben nach', OUT)
