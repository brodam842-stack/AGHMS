// ============================================================
// Excel → Agenda-Template format parser
// ------------------------------------------------------------
// Turns an uploaded "empty format" spreadsheet into the same
// { columns, rows } schema the Visual Excel Format Designer builds
// by hand. Understands:
//   • single-row headers            → flat columns
//   • two-row headers with merged    → parent-group columns
//     parent cells (e.g. "Marks" over [Mid][End])
//   • a leading full-width title/banner row (skipped)
//   • data types inferred from any example rows (else 'text')
//   • example data rows imported as prefilled default rows
// ============================================================
import * as XLSX from 'xlsx';
import { parseToIso } from './dateFormat';

const cellText = (cell) => {
  if (!cell) return '';
  const v = cell.w != null ? cell.w : cell.v;
  return (v == null ? '' : String(v)).trim();
};

/**
 * Parse the first worksheet of an uploaded workbook into the template
 * designer schema.
 * @param {ArrayBuffer|Uint8Array} input  raw file bytes
 * @returns {{ columns: Array<{name:string,type:'text'|'number'|'date',parent:string|null}>, rows: Array<Object>, sheetName: string, headerRows: number }}
 */
export function parseTemplateWorkbook(input) {
  const wb = XLSX.read(input, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('This file has no sheets.');
  const ws = wb.Sheets[sheetName];
  if (!ws || !ws['!ref']) throw new Error('The first sheet is empty.');

  const range = XLSX.utils.decode_range(ws['!ref']);
  const nRows = range.e.r - range.s.r + 1;
  const nCols = range.e.c - range.s.c + 1;
  const merges = ws['!merges'] || [];

  // Build a value grid (relative to the used range) and propagate every
  // merged region's value across all the cells it covers.
  const grid = Array.from({ length: nRows }, (_, r) =>
    Array.from({ length: nCols }, (_, c) =>
      ws[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })] || null
    )
  );
  const rel = (m) => ({
    sr: m.s.r - range.s.r, sc: m.s.c - range.s.c,
    er: m.e.r - range.s.r, ec: m.e.c - range.s.c,
  });
  for (const m of merges) {
    const { sr, sc, er, ec } = rel(m);
    const src = grid[sr]?.[sc] || null;
    for (let r = Math.max(0, sr); r <= Math.min(nRows - 1, er); r++)
      for (let c = Math.max(0, sc); c <= Math.min(nCols - 1, ec); c++)
        if (!grid[r][c]) grid[r][c] = src;
  }

  const nonEmptyCount = (r) =>
    grid[r].reduce((n, cell) => n + (cellText(cell) ? 1 : 0), 0);
  const isFullWidthMerge = (r) => merges.some((m) => {
    const x = rel(m);
    return x.sr === r && x.er === r && x.sc <= 0 && x.ec >= nCols - 1;
  });

  // Skip leading title/banner rows (a full-width merged cell, or a lone
  // cell sitting above a fuller row of real headers).
  let hdrStart = 0;
  while (hdrStart < nRows - 1) {
    if (isFullWidthMerge(hdrStart) ||
        (nonEmptyCount(hdrStart) <= 1 && nonEmptyCount(hdrStart + 1) > 1)) {
      hdrStart++;
    } else break;
  }

  // Two-level header = a horizontal (non-full-width) merge on the top header row.
  const twoLevel = merges.some((m) => {
    const x = rel(m);
    return x.sr === hdrStart && x.er === hdrStart && x.ec > x.sc &&
      !(x.sc <= 0 && x.ec >= nCols - 1);
  });
  const headerRows = twoLevel ? 2 : 1;
  const dataStart = hdrStart + headerRows;

  const inferType = (c) => {
    for (let r = dataStart; r < nRows; r++) {
      const cell = grid[r][c];
      if (!cell) continue;
      if (cell.t === 'd') return 'date';
      if (cell.t === 'n') return 'number';
      const s = cellText(cell);
      if (!s) continue;
      if (/^-?\d+(\.\d+)?$/.test(s)) return 'number';
      // A sample written as text, e.g. "04/08/2026" — still a date column.
      return parseToIso(s) ? 'date' : 'text';
    }
    return 'text';
  };

  const columns = [];
  const colNameByPos = new Array(nCols).fill(null);
  const colTypeByPos = new Array(nCols).fill('text');
  const seen = new Set();
  for (let c = 0; c < nCols; c++) {
    const top = cellText(grid[hdrStart][c]);
    const sub = headerRows === 2 ? cellText(grid[hdrStart + 1][c]) : '';
    let name, parent;
    if (headerRows === 2 && sub && sub !== top) {
      name = sub; parent = top || null;               // sub-column under a group
    } else {
      name = (sub && !top) ? sub : top; parent = null; // standalone column
    }
    if (!name) continue;
    colNameByPos[c] = name;
    const type = inferType(c);
    colTypeByPos[c] = type;
    const key = `${(parent || '').toLowerCase()}|||${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push({ name, type, parent });
  }
  if (columns.length === 0) {
    throw new Error('No column headers were found. Make sure the first row(s) contain column titles.');
  }

  // Carry any example data rows in as prefilled default rows. Dates are stored
  // canonically as ISO here; the designer and the uploader both render them
  // back to the user as dd/mm/yyyy.
  const fmt = (cell, type) => {
    if (!cell) return '';
    if (cell.t === 'd' && cell.v instanceof Date) return parseToIso(cell.v) || '';
    const text = cellText(cell);
    if (type === 'date' && text) return parseToIso(text) || text;
    return text;
  };

  const rows = [];
  const MAX_ROWS = 100;
  for (let r = dataStart; r < nRows && rows.length < MAX_ROWS; r++) {
    const obj = {};
    let any = false;
    for (let c = 0; c < nCols; c++) {
      const name = colNameByPos[c];
      if (!name) continue;
      const val = fmt(grid[r][c], colTypeByPos[c]);
      if (val) any = true;
      obj[name] = val;
    }
    if (any) rows.push(obj);
  }

  return { columns, rows, sheetName, headerRows };
}
