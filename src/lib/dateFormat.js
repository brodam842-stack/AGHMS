// ============================================================
// Date handling — dd/mm/yyyy everywhere the user can see it
// ------------------------------------------------------------
// The institute works in Indian day-first notation, so every
// spreadsheet the HODs download, fill and upload uses dd/mm/yyyy.
// Internally we still keep the canonical ISO `yyyy-mm-dd` string:
// it sorts correctly, matches what Postgres/`date` columns expect,
// and is what already sits in the older `agenda_submissions` rows.
//
//   user / Excel   ──parseToIso──▶   'yyyy-mm-dd'   ──formatDMY──▶   'dd/mm/yyyy'
//
// ============================================================

export const DATE_DISPLAY_FORMAT = 'dd/mm/yyyy';

const pad2 = (n) => String(n).padStart(2, '0');

const isRealDate = (y, m, d) => {
  if (!(y >= 1000 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1)) return false;
  return d <= new Date(y, m, 0).getDate(); // day 0 of next month = last day of this one
};

const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

// Two-digit years: 70-99 → 19xx, 00-69 → 20xx (the usual spreadsheet pivot).
const expandYear = (y) => (y >= 100 ? y : y >= 70 ? 1900 + y : 2000 + y);

/**
 * Excel stores dates as a serial day count from 1899-12-30 (the 1900 system,
 * leap-bug included). Convert one to ISO without going through a JS Date, so
 * the local timezone can never shift the day.
 */
export function excelSerialToIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0 || n > 2958465) return null; // >9999-12-31
  const days = Math.floor(n);
  const ms = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(ms);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Parse just about anything a user or a spreadsheet can produce into ISO.
 * Day-first is preferred — `03/04/2026` is 3 April, not 4 March — but an
 * unambiguous month-first value (`08-20-2026`, written by older versions of
 * this app) is still read correctly rather than rejected.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {string|null} 'yyyy-mm-dd', or null when it isn't a date at all
 */
export function parseToIso(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return iso(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number') return excelSerialToIso(value);

  const s = String(value).trim();
  if (!s) return null;

  // A bare number that came through as text is an Excel serial. Guard the
  // length so a year like "2026" isn't mistaken for one.
  if (/^\d+(\.\d+)?$/.test(s)) {
    return s.replace(/\..*$/, '').length >= 5 ? excelSerialToIso(s) : null;
  }

  // ISO / year-first: 2026-08-04, 2026/08/04 (optionally with a time part)
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }

  // Day-first / month-first: 04/08/2026, 4-8-26, 04.08.2026
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = expandYear(Number(m[3]));
    if (isRealDate(y, b, a)) return iso(y, b, a); // day-first wins
    if (isRealDate(y, a, b)) return iso(y, a, b); // legacy mm-dd-yyyy rescue
    return null;
  }

  // Textual months: 4 Aug 2026, 04-Aug-2026, Aug 4 2026, 4 August 2026
  m = s.match(/^(\d{1,2})[-\s]*([A-Za-z]{3,})[-\s]*(\d{2,4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const y = expandYear(Number(m[3]));
    if (mo && isRealDate(y, mo, d)) return iso(y, mo, d);
    return null;
  }
  m = s.match(/^([A-Za-z]{3,})[-\s]*(\d{1,2}),?[-\s]*(\d{2,4})$/);
  if (m) {
    const mo = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const d = Number(m[2]);
    const y = expandYear(Number(m[3]));
    if (mo && isRealDate(y, mo, d)) return iso(y, mo, d);
    return null;
  }

  return null;
}

/** True when the value can be read as a date. Empty is *not* an error here. */
export function isParsableDate(value) {
  return parseToIso(value) !== null;
}

/**
 * ISO (or anything parseToIso understands) → 'dd/mm/yyyy'.
 * Unparsable input is handed back untouched so a stray note in a date column
 * is still visible to whoever has to fix it.
 */
export function formatDMY(value, fallback = '') {
  if (value == null || value === '') return fallback;
  const isoStr = parseToIso(value);
  if (!isoStr) return String(value);
  const [y, m, d] = isoStr.split('-');
  return `${d}/${m}/${y}`;
}

/** 'dd/mm/yyyy hh:mm' for timestamps. */
export function formatDMYTime(value, fallback = '—') {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return formatDMY(value, fallback);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Today as a canonical ISO string, in local time (never UTC-shifted). */
export function todayIso() {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Progressive input mask for a dd/mm/yyyy text field: keeps only digits and
 * drops the separators in as the user types, so they never fight the slashes.
 */
export function maskDMYInput(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/**
 * Format a submitted cell for display. Columns typed `date` in the agenda
 * template are always shown as dd/mm/yyyy; for untyped feeds (the Document
 * Hub renders raw jsonb with no schema) only values that are unambiguously
 * ISO dates are reformatted, so ordinary text is left exactly as submitted.
 */
export function formatCellValue(value, type) {
  if (value == null || value === '') return '';
  if (type === 'date') return formatDMY(value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value.trim())) {
    return formatDMY(value.trim().slice(0, 10));
  }
  return String(value);
}
