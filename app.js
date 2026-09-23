'use strict';

/* ═══════════════════════════════════════════════════════════════
   Habits — ein minimalistischer Gewohnheiten-Tracker.
   Abhaken muss in unter zwei Sekunden gehen: öffnen, tippen, fertig.
   ═══════════════════════════════════════════════════════════════ */

const KEY = 'habits.v1';
/* Bei jeder Änderung hochzählen — wird in den Einstellungen angezeigt, damit
   sich auf dem Handy prüfen lässt, welche Fassung wirklich läuft. */
const APP_VERSION = '1.0.0';

const THEME_KEY = 'habits.theme';
/* `bar` ist die Hintergrundfarbe des Themes und landet im
   <meta name="theme-color">, damit die Systemleiste des Handys mitzieht —
   muss mit --bg in style.css übereinstimmen. */
const THEMES = {
  dark:  { label: 'Dunkel', bar: '#0b0e14' },
  light: { label: 'Hell',   bar: '#f5f6f8' },
};

/* Habit-Palette. Gespeichert wird nur der Schlüssel; die Farbe selbst kommt
   aus dem Token --hc-<schlüssel>, das jedes Theme in style.css setzt. So
   ziehen beim Theme-Wechsel alle Gewohnheiten mit. */
const COLORS = ['green', 'teal', 'blue', 'violet', 'rose', 'amber'];
const COLOR_LABELS = { green: 'Grün', teal: 'Türkis', blue: 'Blau', violet: 'Violett', rose: 'Rosa', amber: 'Bernstein' };
const FREQS = { daily: 'Täglich', weekdays: 'An Tagen', weekly: 'Pro Woche' };

/* Wochentage wie Date.getDay(): 0 = Sonntag. Angezeigt wird ab Montag. */
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const MAX_BACK = 7;           // so viele Tage lässt sich nachtragen
const NOTE_MAX = 500;         // Tagebuch: ein, zwei Sätze — kein Roman
const HM_WEEKS = 26;          // Verlauf: so viele Wochen zeigt die Heatmap
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Frische Grundstruktur. Basis beim Laden und beim Backup-Import, damit
    später ergänzte Felder in alten Daten nicht fehlen. */
const blank = () => ({
  v: 1,
  habits: [],         // {id, name, freq, days, target, color, order, archived, created} — Felder siehe blankHabit
  checkins: {},       // { 'YYYY-MM-DD': [habitId, …] } — der Tag nach Tagesgrenze, nicht das Kalenderdatum der Uhr
  notes: {},          // { 'YYYY-MM-DD': 'Text' } — ein kurzer Tagebucheintrag je Tag, gleiche Tagesgrenze
  dayStart: 3,        // Stunde, ab der ein neuer Tag beginnt: wer um 0:30 abhakt, meint den Vortag
  theme: 'dark',
  setup: false,       // erste Gewohnheit angelegt? Danach einmal der Bedienungshinweis
  lastBackup: null,   // ISO-Zeitpunkt des letzten Exports
});

/** Eine Gewohnheit mit allen Feldern. `days` und `target` werden nur bei
    ihrer Häufigkeit ausgewertet; `days` bleibt sonst leer. */
const blankHabit = () => ({
  id: '',
  name: '',
  freq: 'daily',      // 'daily' | 'weekdays' | 'weekly'
  days: [],           // nur bei 'weekdays': Wochentage 0–6, 0 = Sonntag
  target: 3,          // nur bei 'weekly': so oft pro Woche, 1–7
  color: COLORS[0],   // Schlüssel aus COLORS
  order: 0,           // Position in der Liste, aufsteigend
  archived: false,    // raus aus Heute, Verlauf bleibt erhalten
  created: '',        // Tag der Anlage, 'YYYY-MM-DD'
});

let db = blank();

/* ── Persistenz ─────────────────────────────────────────────── */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v, lo, hi, def) {
  if (v == null || v === '') return def;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

/** Fremden Datensatz (aus localStorage oder Backup) auf die aktuelle Struktur
    bringen. Object.assign allein reicht nicht: es ersetzt verschachtelte
    Objekte im Ganzen — ein älteres Unterobjekt ohne ein neues Feld würde die
    Vorgabe nicht ergänzen, sondern löschen. Daten haben Vorrang vor Vorgabe. */
function normalize(src) {
  const base = blank();
  const d = Object.assign(blank(), src || {});
  delete d.meta;                                   // Kopfdaten des Backups gehören nicht in die Daten

  const seen = new Set();
  d.habits = (Array.isArray(d.habits) ? d.habits : [])
    .filter((h) => h && typeof h === 'object')
    .map((h, i) => normHabit(h, i, seen));
  // Lückenlos neu durchzählen: nach Import oder Löschen sammeln sich sonst
  // doppelte oder springende Werte, und „nach oben schieben" tut nichts.
  d.habits.sort((a, b) => a.order - b.order).forEach((h, i) => { h.order = i; });

  // Check-ins: nur gültige Tage, nur bekannte Gewohnheiten, keine Doppelten.
  // Leere Tage fliegen raus, damit das Objekt kompakt bleibt.
  const ids = new Set(d.habits.map((h) => h.id));
  const ci = {};
  const rawCi = d.checkins && typeof d.checkins === 'object' && !Array.isArray(d.checkins) ? d.checkins : {};
  for (const [k, list] of Object.entries(rawCi)) {
    if (!isDayKey(k) || !Array.isArray(list)) continue;
    const clean = [...new Set(list.filter((id) => ids.has(id)))];
    if (clean.length) ci[k] = clean;
  }
  d.checkins = ci;

  // Tagebuch: nur Text an gültigen Tagen. Bewusst nicht auf NOTE_MAX kürzen —
  // die Grenze gilt beim Schreiben, ein Import soll nichts abschneiden.
  const notes = {};
  const rawNotes = d.notes && typeof d.notes === 'object' && !Array.isArray(d.notes) ? d.notes : {};
  for (const [k, v] of Object.entries(rawNotes)) {
    if (!isDayKey(k) || typeof v !== 'string') continue;
    const text = v.trim();
    if (text) notes[k] = text;
  }
  d.notes = notes;

  // Fehlt das Anlagedatum, gilt der früheste Check-in, sonst heute.
  const first = {};
  for (const k of Object.keys(ci).sort()) for (const id of ci[k]) if (!first[id]) first[id] = k;
  d.dayStart = clampInt(d.dayStart, 0, 12, base.dayStart);
  d.habits.forEach((h) => { if (!h.created) h.created = first[h.id] || numToKey(logicalDay(new Date(), d.dayStart)); });

  if (!THEMES[d.theme]) d.theme = base.theme;
  d.setup = d.setup === true || d.habits.length > 0;
  d.lastBackup = typeof d.lastBackup === 'string' && !isNaN(Date.parse(d.lastBackup)) ? d.lastBackup : null;
  d.v = base.v;
  return d;
}

/** Eine einzelne Gewohnheit absichern. `seen` sammelt vergebene ids, damit
    zwei Einträge mit derselben id nicht ihre Check-ins teilen. */
function normHabit(src, i, seen) {
  const h = Object.assign(blankHabit(), src);
  h.id = typeof h.id === 'string' && h.id && !seen.has(h.id) ? h.id : uid();
  seen.add(h.id);
  h.name = String(h.name == null ? '' : h.name).trim().slice(0, 80) || 'Gewohnheit';
  if (!FREQS[h.freq]) h.freq = 'daily';
  h.days = Array.isArray(h.days)
    ? [...new Set(h.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
    : [];
  if (h.freq === 'weekdays' && !h.days.length) h.freq = 'daily';   // ohne Tage wäre sie nie fällig
  if (h.freq !== 'weekdays') h.days = [];
  h.target = clampInt(h.target, 1, 7, 3);
  if (!COLORS.includes(h.color)) h.color = COLORS[i % COLORS.length];
  h.order = Number.isFinite(Number(h.order)) ? Number(h.order) : i;
  h.archived = h.archived === true;
  h.created = isDayKey(h.created) ? h.created : '';
  return h;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    db = normalize(JSON.parse(raw));
  } catch (e) { console.warn('Laden fehlgeschlagen', e); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Speichern fehlgeschlagen!'); console.error(e); }
}

/** Theme aufs Dokument legen. Der Spiegel in THEME_KEY ist das, was das
    Startskript in index.html liest — ohne ihn flackert der Start. */
function applyTheme(t) {
  if (!THEMES[t]) t = 'dark';
  db.theme = t;
  document.documentElement.dataset.theme = t;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = THEMES[t].bar;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* nicht schlimm */ }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ── Helfer und Formatierung ────────────────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Tagnummern werden als UTC-Mitternacht formatiert — deshalb timeZone 'UTC',
   sonst rutscht westlich von Greenwich das Datum um einen Tag zurück. */
const dfDay = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dfWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: 'UTC' });
const fmtDay = (n) => dfDay.format(new Date(n * MS_DAY));

let toastTimer;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2200);
}

/** Kurzes Antippen fühlbar machen, wo das Gerät es kann (Android). */
function buzz(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* egal */ }
}

/* ── Tage ───────────────────────────────────────────────────────
   Intern ist ein Tag eine ganze Zahl: Tage seit dem 1.1.1970, gerechnet in
   UTC. Damit gibt es keine 23- oder 25-Stunden-Tage bei der Zeitumstellung,
   und Monats- und Jahreswechsel sind schlichtes +1. Die lokale Uhr spielt nur
   an einer Stelle eine Rolle: in logicalDay(), beim Blick auf „jetzt". */

const MS_DAY = 864e5;
const keyToNum = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / MS_DAY;
const numToKey = (n) => new Date(n * MS_DAY).toISOString().slice(0, 10);
/* Rundreise statt nur Regex: fängt auch den 30. Februar ab. */
const isDayKey = (k) => typeof k === 'string' && DAY_RE.test(k) && numToKey(keyToNum(k)) === k;
/** Wochentag wie Date.getDay(), 0 = Sonntag. Der 1.1.1970 war ein Donnerstag. */
const weekday = (n) => (((n + 4) % 7) + 7) % 7;
/** Montag der Woche, in der n liegt — Wochen beginnen am Montag. */
const mondayOf = (n) => n - ((weekday(n) + 6) % 7);

/** Welcher Tag ist es für die App? Vor der Tagesgrenze zählt noch der Vortag.
    Bewusst über die angezeigte Stunde und nicht über „jetzt minus 3 h": in
    der Nacht der Umstellung auf Sommerzeit wäre 3:30 Uhr sonst noch gestern. */
function logicalDay(date, dayStart) {
  let n = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_DAY;
  if (date.getHours() < dayStart) n -= 1;
  return n;
}
const today = () => logicalDay(new Date(), db.dayStart);

/* ── Serien ─────────────────────────────────────────────────────
   Reine Funktionen: sie bekommen die Gewohnheit, die Menge ihrer
   Check-in-Tage (Tagnummern) und den heutigen Tag, und lesen nichts
   Globales. Gespeichert wird davon nichts — alles folgt aus checkins. */

const NONE = new Set();

/** Tagnummern mit Check-in je Gewohnheit. Einmal pro Zeichnen aufgebaut,
    danach ist jede Frage „an Tag n abgehakt?" ein Set-Zugriff. */
function checkinIndex(checkins) {
  const idx = new Map();
  for (const [k, ids] of Object.entries(checkins)) {
    const n = keyToNum(k);
    for (const id of ids) {
      if (!idx.has(id)) idx.set(id, new Set());
      idx.get(id).add(n);
    }
  }
  return idx;
}

/** Wie oft in der Woche ab `monday` abgehakt. */
function weekCount(set, monday) {
  let c = 0;
  for (let i = 0; i < 7; i++) if (set.has(monday + i)) c++;
  return c;
}

/** Steht Tag n im Plan? Nur bei 'weekdays' gibt es freie Tage. */
const isPlanDay = (h, n) => h.freq !== 'weekdays' || h.days.includes(weekday(n));

/** Ist die Gewohnheit an Tag n fällig? Bei 'weekly' zählt der Tag selbst
    nicht mit — sonst spränge die Zeile beim Abhaken des letzten nötigen
    Mals mitten unter dem Finger nach „nicht fällig". */
function isDue(h, set, n) {
  if (h.freq === 'weekly') return weekCount(set, mondayOf(n)) - (set.has(n) ? 1 : 0) < h.target;
  return isPlanDay(h, n);
}

/** Aktuelle Serie: Tage (daily, weekdays) bzw. Wochen (weekly). Der laufende
    Tag bzw. die laufende Woche bricht sie nie — die sind ja noch nicht vorbei. */
function currentStreak(h, set, today) {
  if (h.freq === 'weekly') {
    const t = Math.max(1, h.target);
    let w = mondayOf(today), s = 0;
    if (weekCount(set, w) >= t) s++;
    for (w -= 7; weekCount(set, w) >= t; w -= 7) s++;
    return s;
  }
  if (h.freq === 'weekdays' && !h.days.length) return 0;      // sonst Endlosschleife
  // Rückwärts über die Plantage; freie Tage werden übersprungen, nicht gezählt.
  let s = 0;
  for (let n = today; ; n--) {
    if (!isPlanDay(h, n)) continue;
    if (set.has(n)) s++;
    else if (n !== today) break;
  }
  return s;
}

/** Längste Serie überhaupt, in derselben Einheit wie currentStreak. */
function longestStreak(h, set, today) {
  if (!set.size) return 0;
  const first = Math.min(...set);
  let best = 0, run = 0;
  if (h.freq === 'weekly') {
    const t = Math.max(1, h.target);
    for (let w = mondayOf(first); w <= today; w += 7) {
      if (weekCount(set, w) >= t) best = Math.max(best, ++run);
      else run = 0;
    }
    return best;
  }
  for (let n = first; n <= today; n++) {
    if (!isPlanDay(h, n)) continue;
    if (set.has(n)) best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}

/** Ab wann wird gemessen? Anlage oder erster Check-in, was früher war —
    nachgetragene Tage vor der Anlage sollen mitzählen. */
function habitStart(h, set) {
  const c = isDayKey(h.created) ? keyToNum(h.created) : Infinity;
  return set.size ? Math.min(c, ...set) : c;
}

/** Quote der letzten 30 Tage (0–1) oder null, wenn es noch nichts zu messen
    gibt. Ein heute noch offener Tag zählt nicht dagegen. Bei 'weekly' sind es
    Wochen: jede, deren Sonntag in den 30 Tagen liegt; die laufende Woche und
    eine angebrochene Startwoche aber nur, wenn ihr Ziel schon erreicht ist. */
function rate30(h, set, today, start) {
  const from = Math.max(today - 29, start);
  let hit = 0, due = 0;
  if (h.freq === 'weekly') {
    const cur = mondayOf(today), t = Math.max(1, h.target);
    for (let w = mondayOf(from); w <= cur; w += 7) {
      const met = weekCount(set, w) >= t;
      if ((w === cur || w < start) && !met) continue;
      due++; if (met) hit++;
    }
  } else {
    for (let n = from; n <= today; n++) {
      if (!isPlanDay(h, n)) continue;
      if (n === today && !set.has(n)) continue;
      due++; if (set.has(n)) hit++;
    }
  }
  return due ? hit / due : null;
}

/** Selbsttest der Tages- und Serienlogik. In der Konsole: testStreaks() */
function testStreaks() {
  const T = keyToNum;
  const S = (...keys) => new Set(keys.map(T));
  const range = (a, b) => { const r = []; for (let n = T(a); n <= T(b); n++) r.push(numToKey(n)); return r; };
  const H = (freq, extra) => Object.assign(blankHabit(), { freq }, extra);
  const L = (y, mo, d, h, mi, ds) => numToKey(logicalDay(new Date(y, mo - 1, d, h, mi), ds == null ? 3 : ds));
  const pct = (x) => (x == null ? null : Math.round(x * 100));
  const MWF = H('weekdays', { days: [1, 3, 5] });
  const W3 = H('weekly', { target: 3 });
  const yearEnd = ['2025-12-22', '2025-12-24', '2025-12-26', '2025-12-30', '2025-12-31', '2026-01-02'];

  const cases = [
    // Kalender
    ['21.9.2026 ist ein Montag', 1, weekday(T('2026-09-21'))],
    ['Montag zu Sonntag 27.9.', '2026-09-21', numToKey(mondayOf(T('2026-09-27')))],
    ['Wochenbeginn über Jahreswechsel', '2025-12-29', numToKey(mondayOf(T('2026-01-01')))],
    ['30. Februar ist kein Tag', false, isDayKey('2026-02-30')],
    // Tagesgrenze 3 Uhr
    ['0:30 Uhr zählt zum Vortag', '2026-09-22', L(2026, 9, 23, 0, 30)],
    ['2:59 Uhr zählt zum Vortag', '2026-09-22', L(2026, 9, 23, 2, 59)],
    ['3:00 Uhr ist der neue Tag', '2026-09-23', L(2026, 9, 23, 3, 0)],
    ['Tagesgrenze über Monatswechsel', '2026-09-30', L(2026, 10, 1, 1, 0)],
    ['Tagesgrenze über Jahreswechsel', '2026-12-31', L(2027, 1, 1, 2, 0)],
    ['Tagesgrenze 0 Uhr', '2026-09-23', L(2026, 9, 23, 0, 30, 0)],
    ['Sommerzeit 29.3.: 1:30 noch Vortag', '2026-03-28', L(2026, 3, 29, 1, 30)],
    ['Sommerzeit 29.3.: 3:30 schon neuer Tag', '2026-03-29', L(2026, 3, 29, 3, 30)],
    ['Winterzeit 25.10.: 2:30 noch Vortag', '2026-10-24', L(2026, 10, 25, 2, 30)],
    ['Winterzeit 25.10.: 3:30 neuer Tag', '2026-10-25', L(2026, 10, 25, 3, 30)],
    // daily
    ['daily: über Monatswechsel', 5, currentStreak(H('daily'), S(...range('2026-01-29', '2026-02-02')), T('2026-02-02'))],
    ['daily: heute offen bricht nicht', 5, currentStreak(H('daily'), S(...range('2026-01-29', '2026-02-02')), T('2026-02-03'))],
    ['daily: gestern verpasst bricht', 0, currentStreak(H('daily'), S(...range('2026-01-29', '2026-02-02')), T('2026-02-04'))],
    ['daily: über Jahreswechsel', 4, currentStreak(H('daily'), S(...range('2025-12-30', '2026-01-02')), T('2026-01-02'))],
    ['daily: Schalttag 29.2.2028', 3, currentStreak(H('daily'), S('2028-02-28', '2028-02-29', '2028-03-01'), T('2028-03-01'))],
    ['daily: über Sommerzeit', 4, currentStreak(H('daily'), S(...range('2026-03-27', '2026-03-30')), T('2026-03-30'))],
    ['daily: über Winterzeit', 4, currentStreak(H('daily'), S(...range('2026-10-23', '2026-10-26')), T('2026-10-26'))],
    ['daily: längste Serie', 5, longestStreak(H('daily'), S(...range('2026-09-01', '2026-09-05'), ...range('2026-09-10', '2026-09-12')), T('2026-09-23'))],
    // weekdays Mo/Mi/Fr
    ['Mo/Mi/Fr: freie Tage unterbrechen nicht', 4, currentStreak(MWF, S('2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21'), T('2026-09-23'))],
    ['Mo/Mi/Fr: freier Tag zählt nicht mit', 4, currentStreak(MWF, S('2026-09-14', '2026-09-16', '2026-09-18', '2026-09-19', '2026-09-21'), T('2026-09-23'))],
    ['Mo/Mi/Fr: verpasster Plantag bricht', 0, currentStreak(MWF, S('2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21'), T('2026-09-24'))],
    ['Mo/Mi/Fr: über Jahreswechsel', 3, currentStreak(MWF, S('2025-12-29', '2025-12-31', '2026-01-02'), T('2026-01-04'))],
    ['Mo/Mi/Fr: an freiem Tag nicht fällig', false, isDue(MWF, NONE, T('2026-09-22'))],
    // weekly 3×
    ['3×/Woche: Woche über Jahreswechsel', 2, currentStreak(W3, S(...yearEnd), T('2026-01-05'))],
    ['3×/Woche: laufende Woche erreicht zählt', 3, currentStreak(W3, S(...yearEnd, '2026-01-05', '2026-01-06', '2026-01-07'), T('2026-01-07'))],
    ['3×/Woche: verfehlte Woche bricht', 0, currentStreak(W3, S(...yearEnd), T('2026-01-12'))],
    ['3×/Woche: längste Serie', 2, longestStreak(W3, S(...yearEnd), T('2026-01-12'))],
    ['2×/Woche: nach Ziel nicht mehr fällig', false, isDue(H('weekly', { target: 2 }), S('2026-09-21', '2026-09-22'), T('2026-09-23'))],
    ['2×/Woche: am abgehakten Tag bleibt fällig', true, isDue(H('weekly', { target: 2 }), S('2026-09-21', '2026-09-23'), T('2026-09-23'))],
    // Quote
    ['Quote daily, heute offen zählt nicht', 50, pct(rate30(H('daily'), S(...range('2026-09-10', '2026-09-14')), T('2026-09-20'), T('2026-09-10')))],
    ['Quote 2×/Woche in Wochen', 67, pct(rate30(H('weekly', { target: 2 }), S('2026-08-31', '2026-09-02', '2026-09-08', '2026-09-15', '2026-09-17', '2026-09-21'), T('2026-09-23'), T('2026-08-31')))],
  ];

  const rows = cases.map(([Fall, erwartet, ergebnis]) => ({ Fall, erwartet, ergebnis, ok: erwartet === ergebnis ? '✓' : '✗' }));
  console.table(rows);
  const bad = rows.filter((r) => r.ok !== '✓');
  const msg = bad.length ? `${bad.length} von ${rows.length} Fällen fehlgeschlagen` : `Alle ${rows.length} Fälle bestanden`;
  (bad.length ? console.error : console.log)(msg);
  return msg;
}

/* ── Navigation ─────────────────────────────────────────────── */

const TITLES = { heute: 'Heute', verlauf: 'Verlauf' };
let view = 'heute';

function nav(v) {
  view = v;
  if (v === 'heute') dayOffset = 0;   // der Heute-Tab führt immer zu heute, auch aus einem Vortag
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  $$('.tabbar button[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === v));
  $('#viewTitle').textContent = TITLES[v] || '';
  window.scrollTo(0, 0);
  armBack();                    // Zurück soll auf Heute führen, nicht aus der App
  render();
}

/** Alles neu zeichnen. Bei den Datenmengen einer Handy-App ist gezieltes
    Aktualisieren unnötige Komplexität — einmal neu rendern ist schnell genug
    und kann nicht aus dem Tritt geraten. */
function render() {
  if (view === 'heute') renderHeute();
  else if (view === 'verlauf') renderVerlauf();
  $('#btnSettings').classList.toggle('badge', backupDue());
}

const activeHabits = () => db.habits.filter((h) => !h.archived).sort((a, b) => a.order - b.order);

/* ── Heute ──────────────────────────────────────────────────── */

let dayOffset = 0;         // 0 = heute, -1 = gestern … bis -MAX_BACK
let shownDay = null;       // der Tag, der gerade zu sehen ist — auf ihn wirkt ein Tipp
let shownToday = null;     // „heute" beim letzten Zeichnen, um die Tagesgrenze zu bemerken
let notDueOpen = false;
let justToggled = null;    // nur diese Zeile animiert beim nächsten Zeichnen
let slideDir = 0;

const ICON_CHK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path pathLength="1" d="M6.5 12.5l3.6 3.6 7.4-8.2"/></svg>';
const ICON_FLAME = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6.2.6c.5 2.2 3.5 3.5 3.5 6.8A3.7 3.7 0 0 1 2.3 7.4c0-1.6.8-2.7 1.7-3.4.1 1.2.6 2 1.4 2.3-.2-2.1.1-4 .8-5.7z"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
const ICON_PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function dayTitle(off, n) {
  if (off === 0) return 'Heute';
  if (off === -1) return 'Gestern';
  if (off === -2) return 'Vorgestern';
  if (off <= -7) return 'Vor einer Woche';   // sonst stünde da derselbe Wochentag wie heute
  return dfWeekday.format(new Date(n * MS_DAY));
}

function renderHeute() {
  const el = $('#view-heute');
  const t = today();
  const day = t + dayOffset;
  shownDay = day; shownToday = t;
  $('#viewTitle').textContent = dayTitle(dayOffset, day);

  const habits = activeHabits();
  if (!habits.length) {
    el.innerHTML = `
      <div class="empty">
        <p>Noch keine Gewohnheit. Fang mit einer kleinen an — abhaken geht dann mit einem Tipp.</p>
        <button class="btn btn-primary" data-act="new">Erste Gewohnheit anlegen</button>
      </div>`;
    return;
  }

  const idx = checkinIndex(db.checkins);
  const setOf = (id) => idx.get(id) || NONE;
  const due = [], rest = [];
  for (const h of habits) (isDue(h, setOf(h.id), day) ? due : rest).push(h);
  const doneN = due.filter((h) => setOf(h.id).has(day)).length;
  const all = due.length > 0 && doneN === due.length;
  const prog = !due.length ? 'Nichts fällig'
    : all ? 'Alles erledigt'
    : `${doneN} von ${due.length} erledigt`;
  const row = (h) => habitRow(h, setOf(h.id), day, t);
  // Ist heute gar nichts fällig, wäre die Seite sonst leer — dann gleich aufklappen.
  const ndOpen = notDueOpen || !due.length;

  el.innerHTML = `
    <div class="day-nav">
      <div class="day-mid">
        <div class="day-date">${esc(fmtDay(day))}</div>
        <div class="day-prog${all ? ' all' : ''}">${prog}</div>
      </div>
      <button class="icon-btn" data-day="-1" aria-label="Vortag"${dayOffset <= -MAX_BACK ? ' disabled' : ''}>${ICON_PREV}</button>
      <button class="icon-btn" data-day="1" aria-label="Nächster Tag"${dayOffset >= 0 ? ' disabled' : ''}>${ICON_NEXT}</button>
    </div>
    <div class="${slideDir < 0 ? 'slide-prev' : slideDir > 0 ? 'slide-next' : ''}">
      ${due.length ? `<div class="hlist">${due.map(row).join('')}</div>`
                   : `<p class="nothing">${dayOffset ? 'An diesem Tag' : 'Heute'} ist nichts fällig.</p>`}
      ${rest.length ? `
        <button class="nd-toggle" data-act="notdue" aria-expanded="${ndOpen}">${ICON_MORE}
          ${dayOffset ? 'Nicht fällig' : 'Heute nicht fällig'} · ${rest.length}</button>
        ${ndOpen ? `<div class="hlist nd">${rest.map(row).join('')}</div>` : ''}` : ''}
      ${noteRow(numToKey(day))}
    </div>`;
}

/** Die Tagebuchzeile unter den Gewohnheiten: leer eine Einladung, sonst der
    Anfang des Eintrags. Ein Tipp öffnet das Sheet für genau diesen Tag. */
function noteRow(k) {
  const text = db.notes[k];
  return `
    <button class="note-row${text ? ' has' : ''}" data-note="${k}">
      ${ICON_PEN}<span class="note-t">${text ? esc(text) : 'Wie war der Tag?'}</span>
    </button>`;
}

/** Eine Abhak-Zeile. Die Serie gilt immer bis heute, auch wenn gerade ein
    Vortag zu sehen ist — Nachtragen soll sofort zeigen, dass sie wieder steht. */
function habitRow(h, set, day, t) {
  const done = set.has(day);
  const s = currentStreak(h, set, t);
  const sub = [];
  if (s > 0) {
    sub.push(ICON_FLAME + (h.freq === 'weekly'
      ? `${s} ${s === 1 ? 'Woche' : 'Wochen'}`
      : `${s} ${s === 1 ? 'Tag' : 'Tage'}`));
  }
  if (h.freq === 'weekly') {
    const w = mondayOf(day);
    sub.push(`${weekCount(set, w)}/${h.target} ${w === mondayOf(t) ? 'diese' : 'letzte'} Woche`);
  }
  return `
    <button class="hrow${done ? ' done' : ''}${justToggled === h.id ? ' just' : ''}" data-toggle="${esc(h.id)}"
      style="--c:var(--hc-${esc(h.color)})" aria-pressed="${done}">
      <span class="hdot"></span>
      <span class="htext">
        <span class="hname">${esc(h.name)}</span>
        ${sub.length ? `<span class="hsub">${sub.join(' · ')}</span>` : ''}
      </span>
      <span class="chk">${ICON_CHK}</span>
    </button>`;
}

/** Abhaken oder wieder aus — immer für den Tag, der gerade zu sehen ist. */
function toggleCheck(id) {
  if (shownDay == null) return;
  const k = numToKey(shownDay);
  const list = db.checkins[k] || [];
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else { list.push(id); buzz(12); }
  if (list.length) db.checkins[k] = list; else delete db.checkins[k];
  save();
  justToggled = id;
  renderHeute();
  justToggled = null;
}

function shiftDay(d) {
  const next = Math.max(-MAX_BACK, Math.min(0, dayOffset + d));
  if (next === dayOffset || view !== 'heute') return;
  dayOffset = next;
  slideDir = d;
  renderHeute();
  slideDir = 0;
}

/* ── Verlauf ────────────────────────────────────────────────── */

let verlaufTab = 'habits';   // 'habits' | 'notes'
let notesShown = 60;         // Tagebuch: so viele Einträge, „Ältere anzeigen" holt mehr

const dfMonthYear = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dfNoteDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

function renderVerlauf() {
  $('#view-verlauf').innerHTML = `
    <div class="seg vseg">
      <button data-vtab="habits" class="${verlaufTab === 'habits' ? 'on' : ''}">Gewohnheiten</button>
      <button data-vtab="notes" class="${verlaufTab === 'notes' ? 'on' : ''}">Tagebuch</button>
    </div>
    ${verlaufTab === 'notes' ? notesList() : habitsHistory()}`;
}

/** Wie die Häufigkeit in einem Wort aussieht: „Täglich", „Mo, Mi, Fr", „3× pro Woche". */
function freqText(h) {
  if (h.freq === 'weekly') return `${h.target}× pro Woche`;
  if (h.freq === 'weekdays') return h.days.length === 7 ? 'Täglich' : WD_ORDER.filter((d) => h.days.includes(d)).map((d) => WD_SHORT[d]).join(', ');
  return 'Täglich';
}

function habitsHistory() {
  if (!db.habits.length) return '<p class="soon">Hier erscheint für jede Gewohnheit ein Kalender, sobald Du eine angelegt hast.</p>';
  const t = today();
  const idx = checkinIndex(db.checkins);
  const block = (h) => habitHistory(h, idx.get(h.id) || NONE, t);
  const archived = db.habits.filter((h) => h.archived).sort((a, b) => a.order - b.order);
  return activeHabits().map(block).join('')
    + (archived.length ? `<h2 class="sec">Archiviert</h2><div class="hh-arch">${archived.map(block).join('')}</div>` : '');
}

/** Ein Block im Verlauf: Kopf, Heatmap, drei Kennzahlen. */
function habitHistory(h, set, t) {
  const cur = currentStreak(h, set, t);
  const best = longestStreak(h, set, t);
  const rate = rate30(h, set, t, habitStart(h, set));
  const unit = (n) => (h.freq === 'weekly' ? (n === 1 ? 'Woche' : 'Wochen') : (n === 1 ? 'Tag' : 'Tage'));
  return `
    <article class="hh" style="--c:var(--hc-${esc(h.color)})">
      <header class="hh-head">
        <span class="hdot"></span><span class="hh-name">${esc(h.name)}</span><span class="hh-freq">${esc(freqText(h))}</span>
      </header>
      ${heatmap(h, set, t)}
      <div class="stats">
        <div><span class="stat-v">${cur}<small>${unit(cur)}</small></span><span class="stat-l">aktuelle Serie</span></div>
        <div><span class="stat-v">${best}<small>${unit(best)}</small></span><span class="stat-l">längste Serie</span></div>
        <div><span class="stat-v">${rate == null ? '–' : Math.round(rate * 100) + '<small>%</small>'}</span><span class="stat-l">letzte 30 Tage</span></div>
      </div>
    </article>`;
}

/** Kalender-Heatmap der letzten HM_WEEKS Wochen als inline-SVG, GitHub-Stil:
    Spalten sind Wochen (Montag oben), Zeilen Wochentage. Abgehakt in der
    Habit-Farbe; freie Tage und Tage vor dem Start blass, damit sie nicht wie
    verpasst aussehen. Heute trägt einen Ring. Die Farben kommen per Klasse
    aus Tokens, das SVG selbst enthält keine. */
function heatmap(h, set, t) {
  const CELL = 11, GAP = 3, STEP = CELL + GAP, LEFT = 20, TOP = 15;
  const first = mondayOf(t) - (HM_WEEKS - 1) * 7;
  const start = habitStart(h, set);

  // Monatsnamen über der ersten Woche eines neuen Monats. Liegen zwei zu dicht
  // beieinander (Monatswechsel gleich in der zweiten Spalte), fällt der erste weg.
  const marks = [];
  for (let w = 0; w < HM_WEEKS; w++) {
    const m = new Date((first + w * 7) * MS_DAY).getUTCMonth();
    if (!marks.length || marks[marks.length - 1].m !== m) marks.push({ w, m });
  }
  const months = marks
    .filter((mk, i) => i === marks.length - 1 || marks[i + 1].w - mk.w >= 3)
    .map((mk) => `<text x="${LEFT + mk.w * STEP}" y="10" class="hm-m">${MONTHS[mk.m]}</text>`).join('');
  const labels = [['Mo', 0], ['Mi', 2], ['Fr', 4]]
    .map(([l, d]) => `<text x="0" y="${TOP + d * STEP + CELL - 2}" class="hm-w">${l}</text>`).join('');

  let cells = '', done = 0;
  for (let w = 0; w < HM_WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const n = first + w * 7 + d;
      if (n > t) break;                    // die Zukunft der laufenden Woche bleibt leer
      const hit = set.has(n);
      if (hit) done++;
      const cls = hit ? 'hm-d' : (n < start || !isPlanDay(h, n)) ? 'hm-f' : 'hm-c';
      cells += `<rect x="${LEFT + w * STEP}" y="${TOP + d * STEP}" width="${CELL}" height="${CELL}" rx="2.5" class="${cls}${n === t ? ' hm-t' : ''}"/>`;
    }
  }
  const W = LEFT + HM_WEEKS * STEP - GAP, H = TOP + 7 * STEP - GAP;
  return `<svg class="hm" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="${done} Mal abgehakt in den letzten ${HM_WEEKS} Wochen">${months}${labels}${cells}</svg>`;
}

/** Tagebuch: neueste zuerst, nach Monaten gegliedert. Die Punkte neben dem
    Datum sind die Gewohnheiten, die an dem Tag abgehakt waren. */
function notesList() {
  const tk = numToKey(today());
  const keys = Object.keys(db.notes).sort().reverse();
  const write = db.notes[tk] ? '' : `<div class="note-new"><button class="btn btn-block" data-note="${tk}">${ICON_PEN} Heute schreiben</button></div>`;
  if (!keys.length) {
    return write + '<p class="soon">Noch keine Einträge. Ein, zwei Sätze am Tag reichen — unten auf Heute oder hier.</p>';
  }
  const byId = new Map(db.habits.map((h) => [h.id, h]));
  const year = new Date(today() * MS_DAY).getUTCFullYear();
  let html = write, lastMonth = '';
  for (const k of keys.slice(0, notesShown)) {
    const d = new Date(keyToNum(k) * MS_DAY);
    // Monat nur mit Jahr, wenn es nicht das laufende ist
    const month = d.getUTCFullYear() === year ? dfMonthYear.format(d).replace(/ \d+$/, '') : dfMonthYear.format(d);
    if (month !== lastMonth) { html += `<h2 class="sec">${esc(month)}</h2>`; lastMonth = month; }
    const dots = (db.checkins[k] || []).map((id) => byId.get(id)).filter(Boolean)
      .sort((a, b) => a.order - b.order)
      .map((h) => `<span class="ndot" style="--c:var(--hc-${esc(h.color)})"></span>`).join('');
    html += `
      <button class="nentry" data-note="${k}">
        <span class="nentry-d">${esc(dfNoteDay.format(d))}<span class="ndots">${dots}</span></span>
        <span class="nentry-t">${esc(db.notes[k])}</span>
      </button>`;
  }
  if (keys.length > notesShown) html += '<button class="btn btn-ghost btn-block" data-act="more-notes">Ältere anzeigen</button>';
  return html;
}

/* ── Tagebuch-Eintrag ───────────────────────────────────────── */

/* Ungesicherter Text überlebt ein versehentliches Zurück oder Abbrechen —
   beim nächsten Öffnen desselben Tages steht er wieder da. Nur im Speicher,
   bis zum nächsten Neustart; mehr Aufwand lohnt für ein, zwei Sätze nicht. */
let noteDraft = null;        // { k, text }

function noteSheet(k) {
  const n = keyToNum(k);
  const saved = db.notes[k] || '';
  const text = noteDraft && noteDraft.k === k ? noteDraft.text : saved;
  const d = new Date(n * MS_DAY);
  const withYear = d.getUTCFullYear() !== new Date(today() * MS_DAY).getUTCFullYear();

  openSheet('Tagebuch', `
    <p class="note-day">${esc(fmtDay(n))}${withYear ? ' ' + d.getUTCFullYear() : ''}</p>
    <textarea class="inp note-in" id="note_in" rows="5" maxlength="${NOTE_MAX}"
      placeholder="Wie war der Tag? Ein, zwei Sätze reichen.">${esc(text)}</textarea>
    <p class="fld-hint note-cnt" id="note_cnt"></p>
    ${saved ? '<div class="form-foot"><button type="button" class="btn btn-ghost danger" data-hf="delnote">Eintrag löschen</button></div>' : ''}
  `, () => saveNote(k), 'Sichern');

  const ta = $('#note_in');
  const count = () => {
    const left = NOTE_MAX - ta.value.length;
    $('#note_cnt').textContent = left <= 100 ? `Noch ${left} Zeichen` : '';
  };
  ta.oninput = () => { noteDraft = { k, text: ta.value }; count(); };
  count();
  $('#sheetBody').onclick = (e) => { if (e.target.closest('[data-hf="delnote"]')) deleteNote(k); };
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/** Leer gesichert heißt: kein Eintrag. */
function saveNote(k) {
  const text = $('#note_in').value.trim().slice(0, NOTE_MAX);
  const had = !!db.notes[k];
  if (text) db.notes[k] = text; else delete db.notes[k];
  noteDraft = null;
  save(); closeSheet(); render();
  toast(text ? 'Gesichert' : had ? 'Eintrag entfernt' : 'Nichts eingetragen');
}

function deleteNote(k) {
  askSheet('Eintrag löschen?', `Der Tagebucheintrag vom ${fmtDay(keyToNum(k))} wird entfernt. Das lässt sich nicht rückgängig machen.`,
    'Löschen', () => {
      delete db.notes[k];
      noteDraft = null;
      save(); closeSheet(); render(); toast('Eintrag gelöscht');
    }, () => noteSheet(k), true);
}

/* ── Gewohnheit anlegen und bearbeiten ──────────────────────── */

let form = null;           // Arbeitskopie im offenen Formular; db bleibt bis „Sichern" unberührt
let formBack = null;       // wohin das Formular zurückführt (Einstellungen), sonst zuklappen

/** Erste Farbe, die noch keine aktive Gewohnheit trägt — so unterscheiden
    sich die ersten sechs von selbst. */
function nextColor() {
  const used = new Set(activeHabits().map((h) => h.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[db.habits.length % COLORS.length];
}

function newHabit() { habitSheet(null); }

function editHabit(id, back) {
  const h = db.habits.find((x) => x.id === id);
  if (h) habitSheet(h, back);
}

/** Formular für neu und bearbeiten. `back`: aus den Einstellungen geöffnet,
    führen Abbrechen, Sichern und Archivieren dorthin zurück. */
function habitSheet(h, back) {
  const isNew = !h;
  formBack = back || null;
  form = isNew ? Object.assign(blankHabit(), { color: nextColor() }) : Object.assign({}, h, { days: h.days.slice() });
  // Vorauswahl Mo–Fr, falls jemand auf „An Tagen" umschaltet
  if (!form.days.length) form.days = [1, 2, 3, 4, 5];

  openSheet(isNew ? 'Neue Gewohnheit' : 'Bearbeiten', `
    <div class="hform" id="hform" style="--c:var(--hc-${esc(form.color)})">
      <div class="fld">
        <label class="fld-l" for="hf_name">Name</label>
        <input class="inp" id="hf_name" autocomplete="off" autocapitalize="sentences" enterkeyhint="done"
          maxlength="60" placeholder="z. B. Zehn Minuten lesen" value="${esc(form.name)}">
      </div>
      <div class="fld">
        <span class="fld-l">Wie oft?</span>
        <div class="seg" id="hf_freq">${Object.entries(FREQS).map(([k, l]) =>
          `<button type="button" data-freq="${k}" class="${form.freq === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div id="hf_opts"></div>
      <div class="fld">
        <span class="fld-l">Farbe</span>
        <div class="swatches" id="hf_colors">${COLORS.map((c) =>
          `<button type="button" data-color="${c}" style="--sw:var(--hc-${c})" aria-label="${COLOR_LABELS[c]}"
            class="${form.color === c ? 'on' : ''}"></button>`).join('')}</div>
      </div>
      ${isNew ? '' : `
        <div class="form-foot">
          <button type="button" class="btn btn-ghost" data-hf="archive">${h.archived ? 'Wiederherstellen' : 'Archivieren'}</button>
          <button type="button" class="btn btn-ghost danger" data-hf="delete">Löschen</button>
        </div>`}
    </div>`, saveHabit, isNew ? 'Anlegen' : 'Sichern');

  renderHabitOpts();
  if (back) $('#sheetCancel').onclick = back;
  $('#sheetBody').onclick = onHabitFormClick;
  const inp = $('#hf_name');
  // „Fertig" auf der Tastatur klappt sie nur ein — Häufigkeit und Farbe kommen ja noch.
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
  if (isNew) inp.focus();
}

/** Der Teil des Formulars, der von der Häufigkeit abhängt. Das Namensfeld
    wird dabei nicht neu gezeichnet, sonst ginge Getipptes verloren. */
function renderHabitOpts() {
  const el = $('#hf_opts');
  if (form.freq === 'weekly') {
    el.innerHTML = `
      <div class="fld">
        <span class="fld-l">Wie oft pro Woche?</span>
        <div class="pick7">${[1, 2, 3, 4, 5, 6, 7].map((n) =>
          `<button type="button" data-target="${n}" class="${form.target === n ? 'on' : ''}"
            aria-pressed="${form.target === n}">${n}</button>`).join('')}</div>
        <p class="fld-hint">Egal an welchen Tagen. Die Woche beginnt am Montag.</p>
      </div>`;
  } else if (form.freq === 'weekdays') {
    el.innerHTML = `
      <div class="fld">
        <span class="fld-l">An welchen Tagen?</span>
        <div class="pick7">${WD_ORDER.map((d) =>
          `<button type="button" data-wd="${d}" class="${form.days.includes(d) ? 'on' : ''}"
            aria-pressed="${form.days.includes(d)}">${WD_SHORT[d]}</button>`).join('')}</div>
      </div>`;
  } else {
    el.innerHTML = '';
  }
}

function onHabitFormClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const ds = b.dataset;
  if ('freq' in ds) {
    form.freq = ds.freq;
    $$('#hf_freq button').forEach((x) => x.classList.toggle('on', x === b));
    renderHabitOpts();
  } else if ('target' in ds) {
    form.target = Number(ds.target);
    renderHabitOpts();
  } else if ('wd' in ds) {
    const d = Number(ds.wd);
    form.days = form.days.includes(d) ? form.days.filter((x) => x !== d) : form.days.concat(d);
    renderHabitOpts();
  } else if ('color' in ds) {
    form.color = ds.color;
    $$('#hf_colors button').forEach((x) => x.classList.toggle('on', x === b));
    $('#hform').style.setProperty('--c', `var(--hc-${form.color})`);
  } else if (ds.hf === 'archive') {
    toggleArchive(form.id);
  } else if (ds.hf === 'delete') {
    deleteHabit(form.id);
  }
}

function saveHabit() {
  const name = $('#hf_name').value.trim();
  if (!name) { toast('Bitte einen Namen eingeben'); $('#hf_name').focus(); return; }
  if (form.freq === 'weekdays' && !form.days.length) { toast('Bitte mindestens einen Tag wählen'); return; }
  form.name = name;
  // Die Vorauswahl der Tage gehört nur zu 'weekdays' — sonst nicht mitspeichern
  form.days = form.freq === 'weekdays' ? form.days.sort((a, b) => a - b) : [];

  const existing = db.habits.find((h) => h.id === form.id);
  if (existing) {
    Object.assign(existing, form);
  } else {
    form.id = uid();
    form.order = db.habits.reduce((m, h) => Math.max(m, h.order + 1), 0);
    form.created = numToKey(today());
    db.habits.push(form);
  }
  const first = !db.setup;
  db.setup = true;
  save();
  form = null;
  leaveForm();
  render();
  if (first) toast('Antippen hakt ab · lange drücken bearbeitet · wischen blättert', 4500);
  else toast(existing ? 'Gesichert' : 'Angelegt');
}

/** Nach Sichern, Archivieren, Löschen: zurück in die Einstellungen, falls
    das Formular von dort kam, sonst zuklappen. */
function leaveForm() {
  const back = formBack;
  formBack = null;
  if (back) back(); else closeSheet();
}

/** Archivieren ist umkehrbar, deshalb ohne Rückfrage. */
function toggleArchive(id) {
  const h = db.habits.find((x) => x.id === id);
  if (!h) return;
  h.archived = !h.archived;
  save();
  leaveForm();
  render();
  toast(h.archived ? 'Archiviert — wiederherstellbar in den Einstellungen' : 'Wiederhergestellt', 3000);
}

function deleteHabit(id) {
  const h = db.habits.find((x) => x.id === id);
  if (!h) return;
  const n = Object.values(db.checkins).filter((ids) => ids.includes(id)).length;
  const was = n === 0 ? 'Die Gewohnheit wird entfernt.'
    : n === 1 ? 'Die Gewohnheit und ihr Check-in werden entfernt.'
    : `Die Gewohnheit und alle ${n} Check-ins werden entfernt.`;
  const back = formBack;     // askSheet öffnet ein neues Sheet — den Rückweg vorher sichern
  askSheet(`„${h.name}“ löschen?`,
    `${was} Das lässt sich nicht rückgängig machen. Archivieren behält den Verlauf.`,
    'Löschen', () => {
      db.habits = db.habits.filter((x) => x.id !== id);
      for (const k of Object.keys(db.checkins)) {
        const rest = db.checkins[k].filter((x) => x !== id);
        if (rest.length) db.checkins[k] = rest; else delete db.checkins[k];
      }
      save();
      formBack = back;
      leaveForm();
      render();
      toast('Gelöscht');
    }, () => editHabit(id, back), true);
}

/* ── Einstellungen ──────────────────────────────────────────── */

const dfDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

/** „heute", „gestern", „vor 12 Tagen" — für den Stand des Backups. */
function relDays(iso) {
  const then = new Date(iso);
  const days = Math.round((Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
    - Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())) / MS_DAY);
  return days <= 0 ? 'heute' : days === 1 ? 'gestern' : `vor ${days} Tagen`;
}

/** Ist ein Backup überfällig? Nie gesichert und Daten älter als zwei Wochen,
    oder das letzte Backup liegt über 30 Tage zurück. Dann trägt das Zahnrad
    einen Punkt — die Daten liegen nur auf diesem Gerät. */
function backupDue() {
  const keys = Object.keys(db.checkins).concat(Object.keys(db.notes));
  if (!keys.length) return false;
  if (db.lastBackup) return Date.now() - Date.parse(db.lastBackup) > 30 * MS_DAY;
  return today() - keyToNum(keys.sort()[0]) > 14;
}

function openSettings() {
  openSheet('Einstellungen', `
    <div class="fld">
      <span class="fld-l">Darstellung</span>
      <div class="seg" id="st_theme">${Object.entries(THEMES).map(([k, t]) =>
        `<button type="button" data-th="${k}" class="${db.theme === k ? 'on' : ''}">${t.label}</button>`).join('')}</div>
    </div>
    <div class="fld">
      <span class="fld-l">Neuer Tag beginnt um … Uhr</span>
      <div class="pick7" id="st_day"></div>
      <p class="fld-hint" id="st_day_hint"></p>
    </div>
    <div class="fld">
      <span class="fld-l">Gewohnheiten</span>
      <div id="st_habits"></div>
    </div>
    <div class="fld">
      <span class="fld-l">Backup</span>
      <p class="fld-hint st-backup" id="st_backup"></p>
      <div class="btn-row">
        <button type="button" class="btn" data-st="export">Speichern</button>
        <button type="button" class="btn" data-st="import">Laden</button>
      </div>
      <input type="file" accept="application/json,.json" class="hidden" id="st_file">
    </div>
    <div class="fld">
      <span class="fld-l">App</span>
      <div class="about">
        <span>Version <span class="num">${esc(APP_VERSION)}</span></span>
        <button type="button" class="btn" data-st="update">Nach Update suchen</button>
      </div>
    </div>`, null);

  renderSettingsParts();
  $('#sheetBody').onclick = onSettingsClick;
  $('#st_file').onchange = (e) => { importBackup(e.target.files[0]); e.target.value = ''; };
}

/** Die Teile der Einstellungen, die sich beim Antippen ändern. Einzeln neu
    gezeichnet, damit das Sheet beim Umsortieren nicht nach oben springt. */
function renderSettingsParts() {
  $('#st_day').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((h) =>
    `<button type="button" data-ds="${h}" class="${db.dayStart === h ? 'on' : ''}" aria-pressed="${db.dayStart === h}">${h}</button>`).join('');
  $('#st_day_hint').textContent = db.dayStart === 0
    ? 'Der Tag wechselt um Mitternacht.'
    : `Wer bis ${db.dayStart - 1}:59 Uhr abhakt oder schreibt, trägt noch für den Vortag ein.`;

  const act = activeHabits();
  const arch = db.habits.filter((h) => h.archived).sort((a, b) => a.order - b.order);
  const main = (h) => `
    <button type="button" class="mrow-main" data-edit="${esc(h.id)}">
      <span class="hdot"></span><span class="mname">${esc(h.name)}</span><span class="mfreq">${esc(freqText(h))}</span>
    </button>`;
  $('#st_habits').innerHTML = !db.habits.length
    ? '<p class="fld-hint">Noch keine. Mit dem Plus unten legst Du eine an.</p>'
    : act.map((h, i) => `
        <div class="mrow" style="--c:var(--hc-${esc(h.color)})">
          ${main(h)}
          <button type="button" class="icon-btn" data-move="-1" data-id="${esc(h.id)}" aria-label="Nach oben"${i === 0 ? ' disabled' : ''}>${ICON_UP}</button>
          <button type="button" class="icon-btn" data-move="1" data-id="${esc(h.id)}" aria-label="Nach unten"${i === act.length - 1 ? ' disabled' : ''}>${ICON_DOWN}</button>
        </div>`).join('')
      + (arch.length ? `<span class="fld-l st-arch">Archiviert</span>` + arch.map((h) => `
        <div class="mrow arch" style="--c:var(--hc-${esc(h.color)})">
          ${main(h)}
          <button type="button" class="btn btn-ghost" data-restore="${esc(h.id)}">Zurückholen</button>
        </div>`).join('') : '');

  const due = backupDue();
  $('#st_backup').classList.toggle('warn', due);
  $('#st_backup').textContent = (db.lastBackup
    ? `Letztes Backup ${relDays(db.lastBackup)} (${dfDate.format(new Date(db.lastBackup))}). `
    : 'Noch kein Backup. ')
    + 'Deine Daten liegen nur auf diesem Gerät — „Browserdaten löschen“ heißt: alles weg.';
}

function onSettingsClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const ds = b.dataset;
  if ('th' in ds) {
    applyTheme(ds.th);
    save();
    $$('#st_theme button').forEach((x) => x.classList.toggle('on', x === b));
  } else if ('ds' in ds) {
    db.dayStart = Number(ds.ds);
    save();
    renderSettingsParts();
    render();
  } else if ('edit' in ds) {
    editHabit(ds.edit, openSettings);
  } else if ('move' in ds) {
    moveHabit(ds.id, Number(ds.move));
  } else if ('restore' in ds) {
    const h = db.habits.find((x) => x.id === ds.restore);
    if (h) { h.archived = false; save(); renderSettingsParts(); render(); toast('Zurückgeholt'); }
  } else if (ds.st === 'export') {
    exportBackup();
    renderSettingsParts();
  } else if (ds.st === 'import') {
    $('#st_file').click();
  } else if (ds.st === 'update') {
    checkForUpdate();
  }
}

/** Eine Gewohnheit in der Liste um eins verschieben: tauscht `order` mit dem
    Nachbarn unter den aktiven. Archivierte behalten ihren Platz. */
function moveHabit(id, dir) {
  const list = activeHabits();
  const i = list.findIndex((h) => h.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i].order, list[j].order] = [list[j].order, list[i].order];
  save();
  renderSettingsParts();
  render();
}

/* ── Backup ─────────────────────────────────────────────────── */

const dfLong = new Intl.DateTimeFormat('de-DE',
  { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

function exportBackup() {
  db.lastBackup = new Date().toISOString();
  save();
  /* Der gesamte Datensatz wandert unverändert in die Datei. `meta` steht nur
     als Kopfzeile davor und wird beim Import wieder entfernt (siehe
     normalize), damit es nicht in die Daten wandert. */
  const payload = Object.assign({
    meta: { app: 'Habits', appVersion: APP_VERSION, format: db.v, exported: db.lastBackup },
  }, db);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `habits-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  render();
  toast('Backup gespeichert');
}

function importBackup(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.habits)) throw new Error('Die Datei ist kein Backup dieser App.');
      const stand = d.meta && d.meta.exported ? ` vom ${dfLong.format(new Date(d.meta.exported))}` : '';
      // Vor normalize nur grob zählen — es geht um eine Vorschau, nicht um Genauigkeit
      const plain = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
      const nCheck = Object.values(plain(d.checkins)).reduce((s, l) => s + (Array.isArray(l) ? l.length : 0), 0);
      const nNotes = Object.keys(plain(d.notes)).length;
      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      askSheet('Backup laden',
        `Das Backup${stand} enthält ${plural(d.habits.length, 'Gewohnheit', 'Gewohnheiten')}, `
        + `${plural(nCheck, 'Check-in', 'Check-ins')} und ${plural(nNotes, 'Tagebucheintrag', 'Tagebucheinträge')}. `
        + 'Deine jetzigen Daten werden dabei ersetzt.',
        'Laden', () => {
          // normalize() ergänzt, was in einem älteren Backup fehlt, und wirft
          // die Kopfzeile `meta` weg.
          db = normalize(d);
          applyTheme(db.theme);
          save(); closeSheet(); render(); toast('Backup geladen');
        }, openSettings);
    } catch (e) {
      infoSheet('Import fehlgeschlagen', e instanceof SyntaxError ? 'Die Datei ist kein gültiges JSON.' : e.message, openSettings);
    }
  };
  r.readAsText(file);
}

/* ── Updates ────────────────────────────────────────────────── */

/** Welche APP_VERSION liegt im Offline-Cache? Das ist die Fassung, die beim
    nächsten Laden ausgeliefert wird — nicht zwingend die laufende. */
async function cachedVersion() {
  if (!('caches' in window)) return null;
  for (const k of await caches.keys()) {
    if (!k.startsWith('habits')) continue;
    const c = await caches.open(k);
    const res = (await c.match('./app.js')) || (await c.match('app.js'));
    if (!res) continue;
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

/** Lädt neu, wenn im Cache eine andere Fassung liegt als die laufende. Die
    Sperre in sessionStorage verhindert eine Endlosschleife, falls das
    Neuladen die Version wider Erwarten nicht ändert. */
let reloading = false;
async function applyIfNewer(announce) {
  if (reloading) return false;
  const cv = await cachedVersion();
  if (!cv || cv === APP_VERSION) return false;
  if (sessionStorage.getItem('habits-reload') === cv) return false;   // schon versucht
  if (!$('#sheet').classList.contains('hidden')) {                    // Formular offen
    toast(`Version ${cv} bereit — App neu starten`);
    return true;
  }
  reloading = true;
  sessionStorage.setItem('habits-reload', cv);
  if (announce) toast(`Version ${cv} wird geladen …`);
  setTimeout(() => location.reload(), announce ? 700 : 0);
  return true;
}

function wireUpdates() {
  if (!('serviceWorker' in navigator)) return;

  /* Auf 'controllerchange' ist kein Verlass: aktualisiert sich dieselbe
     Registrierung, gilt die Seite nicht als "neu kontrolliert" und das
     Ereignis bleibt aus. Verlässlich ist der Zustandswechsel des neuen
     Workers auf 'activated' — dann liegt der frische Cache bereit. */
  const watch = (w) => {
    if (!w) return;
    if (w.state === 'activated') { applyIfNewer(false); return; }
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') applyIfNewer(false);
    });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => applyIfNewer(false));

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      watch(reg.installing); watch(reg.waiting);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      navigator.serviceWorker.ready.then(() => applyIfNewer(false));
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
}

/** „Nach Update suchen" in den Einstellungen. Das Einstellungs-Sheet hält
    nichts Ungesichertes, deshalb wird es für das Neuladen zugeklappt — sonst
    bliebe applyIfNewer beim Hinweis „App neu starten" stehen. */
async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) { toast('Updates gibt es nur über https, in der installierten App'); return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { toast('Offline-Modus noch nicht bereit — später noch einmal'); return; }
    toast('Suche …');
    await reg.update();
    if (reg.installing || reg.waiting) {
      closeSheet();
      toast('Neue Version wird geladen …', 4000);   // watch() lädt neu, sobald sie aktiv ist
      return;
    }
    const cv = await cachedVersion();
    if (cv && cv !== APP_VERSION) { closeSheet(); await applyIfNewer(true); return; }
    toast(`Version ${APP_VERSION} ist aktuell`);
  } catch (e) {
    toast('Keine Verbindung — später noch einmal');
  }
}

/* ── Sheet-System ───────────────────────────────────────────── */
let sheetSaveFn = null;

function openSheet(title, html, saveFn, saveLabel) {
  armBack();                              // Zurück soll das Sheet schließen, nicht die App
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').onclick = null;         // Handler des vorherigen Sheets verwerfen
  $('#sheetCancel').onclick = closeSheet; // ggf. überschriebenes Abbrechen zurücksetzen
  sheetSaveFn = saveFn || null;
  const btn = $('#sheetSave');
  btn.classList.toggle('hidden', !saveFn);
  btn.textContent = saveLabel || 'Sichern';
  $('#sheet').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  $('#sheetBody').scrollTop = 0;
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  sheetSaveFn = null;
}

/* ── Dialoge ────────────────────────────────────────────────────
   Ersatz für confirm() / prompt() / alert(): installierte Web-Apps
   unterdrücken die nativen Dialoge je nach Gerät kommentarlos — der Knopf
   tut dann scheinbar nichts. Diese hier sind normale Sheets und
   funktionieren überall gleich.
   `back` führt zurück zum vorherigen Sheet statt alles zuzuklappen. */

function askSheet(title, text, okLabel, onOk, back, danger) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" id="dlgOk">${esc(okLabel)}</button>
    <button class="btn btn-block" id="dlgNo" style="margin-top:8px">Abbrechen</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = onOk;
  $('#dlgNo').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

function infoSheet(title, text, back) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn btn-primary btn-block" id="dlgOk">Verstanden</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

/* ── Zurück-Taste ───────────────────────────────────────────────
   Ohne Zutun beendet ein einziger Druck auf Zurück die installierte App —
   viel zu leicht aus Versehen. Deshalb liegt ein zusätzlicher Verlaufseintrag
   („Wächter") über der App: Zurück landet dann bei uns statt beim System.

   Der Druck schließt der Reihe nach, was offen ist — Sheet, Vortag,
   Unterseite — und baut den Wächter danach wieder auf. Steht nichts mehr
   offen und Du bist auf Heute, fragt ein Dialog nach. */
let guardUp = false;
let leaving = false;

function pushGuard() {
  if (guardUp) return;
  guardUp = true;
  try { history.pushState({ g: 1 }, ''); } catch (e) { guardUp = false; }
}

/** Vor allem, was die Zurück-Taste abfangen soll: Sheet öffnen, Seite wechseln. */
function armBack() { pushGuard(); }

/** „Verlassen" im Abschiedsdialog: der Dialog hat selbst einen Wächter
    aufgebaut (jedes Sheet tut das). Erst ihn abräumen, dann führt der zweite
    Schritt aus der App. Beides muss über zwei Runden laufen — history.back()
    zweimal hintereinander fasst der Browser zu einem Schritt zusammen. */
function leaveApp() {
  closeSheet();
  leaving = true;
  history.back();
}

function wireBack() {
  pushGuard();
  window.addEventListener('popstate', () => {
    guardUp = false;

    if (leaving) {
      leaving = false;
      history.back();
      // Falls nichts mehr zum Zurückgehen da ist (im Browser-Tab, in dem die App
      // der erste Eintrag ist), bleiben wir hier — dann fehlt der Wächter. Kein
      // Timer zum Nachrüsten: ein pushState würde den laufenden Schritt abbrechen
      // und genau das Verlassen verhindern. Also erst beim nächsten Antippen.
      document.addEventListener('pointerdown', pushGuard, { once: true });
      return;
    }
    // Über den Abbrechen-Knopf, nicht über closeSheet: verschachtelte Sheets
    // haben dort ihren Rückweg zum vorherigen Sheet hinterlegt.
    if (!$('#sheet').classList.contains('hidden')) { $('#sheetCancel').click(); pushGuard(); return; }
    if (view !== 'heute') { nav('heute'); pushGuard(); return; }
    // Beim Nachtragen führt Zurück erst einmal zu heute.
    if (dayOffset !== 0) { dayOffset = 0; render(); pushGuard(); return; }

    askSheet('App verlassen?', 'Möchtest Du die App wirklich schließen?',
      'Verlassen', leaveApp);
  });
}

/* ── Verdrahtung ────────────────────────────────────────────── */

let pressFired = false;    // langer Druck hat schon ausgelöst — der folgende Klick darf nicht abhaken

function wire() {
  document.body.addEventListener('click', (e) => {
    const r = e.target.closest('[data-toggle]');
    if (r) {
      if (pressFired) { pressFired = false; return; }
      toggleCheck(r.dataset.toggle);
      return;
    }
    const n = e.target.closest('[data-nav]'); if (n) { nav(n.dataset.nav); return; }
    const d = e.target.closest('[data-day]'); if (d) { shiftDay(Number(d.dataset.day)); return; }
    const no = e.target.closest('[data-note]'); if (no) { noteSheet(no.dataset.note); return; }
    const vt = e.target.closest('[data-vtab]');
    if (vt) { verlaufTab = vt.dataset.vtab; renderVerlauf(); return; }
    const a = e.target.closest('[data-act]');
    if (a && a.dataset.act === 'new') { newHabit(); return; }
    if (a && a.dataset.act === 'notdue') { notDueOpen = !notDueOpen; renderHeute(); return; }
    if (a && a.dataset.act === 'more-notes') { notesShown += 60; renderVerlauf(); return; }
  });
  $('#btnNew').onclick = newHabit;
  $('#btnSettings').onclick = openSettings;
  $('#sheetCancel').onclick = closeSheet;
  $('#scrim').onclick = () => $('#sheetCancel').click();   // wie Abbrechen, damit verschachtelte Sheets zurückführen
  $('#sheetSave').onclick = () => sheetSaveFn && sheetSaveFn();

  wireLongPress();
  wireSwipe();
  wireClock();

  // Am Rechner: Pfeiltasten blättern durch die Tage.
  document.addEventListener('keydown', (e) => {
    if (view !== 'heute' || !$('#sheet').classList.contains('hidden')) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') shiftDay(-1);
    else if (e.key === 'ArrowRight') shiftDay(1);
  });
}

/** Lange drücken auf eine Zeile öffnet sie zum Bearbeiten. Ein normaler Tipp
    dauert unter 200 ms, 500 ms lassen also genug Abstand zum Abhaken. */
function wireLongPress() {
  let timer = 0, x = 0, y = 0;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  document.addEventListener('pointerdown', (e) => {
    pressFired = false;          // Nicht jeder lange Druck endet in einem Klick — hier sicher zurücksetzen
    const r = e.target.closest('[data-toggle]');
    if (!r || e.button > 0) return;
    x = e.clientX; y = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = 0; pressFired = true;
      buzz(18);
      editHabit(r.dataset.toggle);
    }, 500);
  });
  document.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel();
  });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  // Sonst öffnet Android beim langen Druck sein eigenes Menü
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-toggle]')) e.preventDefault(); });
}

/** Wischen auf Heute blättert zum Vortag (nach rechts) oder zurück (nach links). */
function wireSwipe() {
  const v = $('#view-heute');
  let sx = 0, sy = 0, st = 0;
  v.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = e.timeStamp;
  }, { passive: true });
  v.addEventListener('touchend', (e) => {
    if (e.touches.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.8 * Math.abs(dy) && e.timeStamp - st < 700) shiftDay(dx > 0 ? -1 : 1);
  }, { passive: true });
}

/** Die App bleibt im Hintergrund oft stundenlang offen. Wer sie wieder
    hervorholt, will heute abhaken — nicht in dem Vortag landen, bei dem er
    stehen geblieben ist, und nicht im Tag von gestern Abend. */
function wireClock() {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (Date.now() - hiddenAt > 2 * 60 * 1000 || shownToday !== today()) dayOffset = 0;
    render();
  });
  // Läuft die App offen über die Tagesgrenze, rückt Heute von selbst weiter.
  setInterval(() => {
    if (view === 'heute' && shownToday !== null && shownToday !== today()) { dayOffset = 0; render(); }
  }, 60 * 1000);
}

/* ── Start ──────────────────────────────────────────────────── */

load();
applyTheme(db.theme);
wire();
wireBack();
nav('heute');

/* Bittet den Browser, den Speicher nicht bei Platzmangel wegzuräumen. */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

wireUpdates();
