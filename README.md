# Habits

Ein minimalistischer Gewohnheiten-Tracker fürs Handy. Abhaken dauert keine zwei
Sekunden: App öffnen, einmal tippen, fertig. Dazu ein kurzes Tagebuch, ein, zwei
Sätze pro Tag.

Alles läuft offline im Browser. Es gibt kein Konto, keinen Server und keine
Benachrichtigungen. Die Daten bleiben auf dem Gerät.

## Was sie kann

- **Heute.** Die heute fälligen Gewohnheiten als große Zeilen. Ein Tipp hakt
  ab, ein zweiter Tipp nimmt den Haken wieder weg. Neben jeder Zeile steht die
  aktuelle Serie, bei „x pro Woche“ auch der Stand der Woche. Was heute nicht
  dran ist, liegt eingeklappt darunter.
- **Nachtragen.** Wischen oder die Pfeile oben führen bis zu 7 Tage zurück.
- **Tagebuch.** Unter den Gewohnheiten steht „Wie war der Tag?“. Ein Tipp
  öffnet ein Feld für bis zu 500 Zeichen, pro Tag gibt es einen Eintrag.
- **Verlauf.** Für jede Gewohnheit ein Kalender der letzten 26 Wochen, dazu
  aktuelle Serie, längste Serie und die Quote der letzten 30 Tage. Im Reiter
  „Tagebuch“ stehen alle Einträge, neueste zuerst.
- **Häufigkeit.** Täglich, an festen Wochentagen (z. B. Mo, Mi, Fr) oder
  x-mal pro Woche an beliebigen Tagen. Wochen beginnen am Montag.
- **Tagesgrenze.** Ein neuer Tag beginnt um 3 Uhr, einstellbar von 0 bis 6
  Uhr. Wer um 0:30 Uhr abhakt, meint den Vortag.
- **Themes.** Dunkel und Hell.

## Bedienung

| Geste | Wirkung |
|---|---|
| Zeile antippen | abhaken / Haken wegnehmen |
| Zeile lange drücken | Gewohnheit bearbeiten, archivieren, löschen |
| Nach rechts wischen | Vortag |
| Nach links wischen | zurück Richtung heute |
| ＋ unten in der Mitte | neue Gewohnheit |
| Zahnrad | Einstellungen: Theme, Tagesgrenze, Reihenfolge, Archiv, Backup |

Der Tab „Heute“ springt immer zum heutigen Tag zurück. Das tut die App auch von
selbst, wenn sie länger als zwei Minuten im Hintergrund war.

## Installieren

1. Die Seite auf dem Handy in Chrome öffnen.
2. ⋮ → **Zum Startbildschirm hinzufügen**.

Danach startet sie wie eine App und funktioniert auch ohne Netz.

## Daten und Backup

Die Daten liegen nur im Speicher des Browsers auf diesem Gerät. **„Browserdaten
löschen“ löscht damit auch alle Gewohnheiten und das Tagebuch.** Deshalb
regelmäßig ein Backup machen: *Einstellungen → Backup → Speichern* legt eine
JSON-Datei in den Download-Ordner. *Laden* spielt sie wieder ein und ersetzt
dabei den jetzigen Stand.

Ist das letzte Backup über 30 Tage alt, oder gab es nach zwei Wochen noch gar
keins, zeigt das Zahnrad einen roten Punkt.

## Entwicklung

Es gibt keinen Build und keine Abhängigkeiten. Die App besteht aus drei
Dateien: `index.html`, `style.css` und `app.js`.

```bash
python3 -m http.server 8123
```

Dann `http://localhost:8123` öffnen. Im selben WLAN geht es auch vom Handy aus
über die IP des Rechners. Dort läuft allerdings kein Service Worker, weil der
https oder localhost braucht.

- **Selbsttest der Serien-Logik:** in der Browser-Konsole `testStreaks()`
  aufrufen. Er prüft Monats- und Jahreswechsel, Schalttag, Sommer- und
  Winterzeit und die Tagesgrenze.
- **Icons neu erzeugen:** `python3 icons/make-icons.py` (braucht Pillow).
  Das Skript wird für die App selbst nicht gebraucht.
- **Nach jeder Änderung** `APP_VERSION` in `app.js` und `CACHE` in `sw.js`
  hochzählen, sonst liefert der Service Worker die alte Fassung aus.

## Veröffentlichen (GitHub Pages)

1. Auf github.com/new ein **öffentliches** Repo `habits` anlegen, ohne README.
2. „uploading an existing file“ → den **Inhalt** dieses Ordners hineinziehen.
   `index.html` muss im Wurzelverzeichnis liegen. `.claude/` und Backups
   bleiben draußen.
3. *Settings → Pages → Deploy from a branch*, `main`, `/ (root)` → Save.
4. Nach ein, zwei Minuten ist die App unter `https://<name>.github.io/habits/`
   erreichbar.

Bei einem Update kommen nur die geänderten Dateien nach `update/`, zusammen
mit `sw.js` und hochgezähltem `CACHE`. Die Anleitung dazu steht dann in
`UPDATE-HOCHLADEN.md`.
