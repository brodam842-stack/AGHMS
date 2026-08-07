// ============================================================
// Agenda spreadsheet export
// ------------------------------------------------------------
// Turns what the HODs submitted (jsonb rows in `agenda_submissions`)
// back into real .xlsx workbooks so an admin can download it:
//
//   • one department's sheet                     → downloadSubmissionWorkbook
//   • every department for a meeting, in one file → downloadMeetingSubmissionsWorkbook
//   • Document Hub data sheets (one or many)      → downloadHubSheetWorkbook / …Sheets…
//
// Layout mirrors the agenda template exactly: the same column order, the same
// merged parent-group headers, and dates written as dd/mm/yyyy.
// ============================================================
import * as XLSX from 'xlsx';
import { formatDMY, formatDMYTime, parseToIso } from './dateFormat';

// ─── Cell + sheet helpers ─────────────────────────────────────────────────────

const MIN_COL_WIDTH = 10;
const MAX_COL_WIDTH = 42;

/** Render one submitted value for Excel: dates as dd/mm/yyyy, numbers as numbers. */
function cellValue(raw, type) {
  if (raw == null || raw === '') return '';
  if (type === 'date') return formatDMY(raw);
  if (type === 'number') {
    const n = Number(String(raw).trim());
    return String(raw).trim() !== '' && Number.isFinite(n) ? n : String(raw);
  }
  // Untyped column that nonetheless holds an ISO date — show it day-first too.
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return formatDMY(raw.trim());
  return typeof raw === 'string' ? raw : String(raw);
}

/**
 * Build the header block for a column schema.
 * Columns carrying a `parent` produce a two-row header with the parent merged
 * horizontally across its children; plain columns are merged vertically so they
 * read as a single tall cell — the same shape the upload parser expects back.
 *
 * @param {Array<{name:string,type:string,parent?:string|null}>} columns
 * @param {string[]} leadHeaders extra plain columns pinned to the left
 */
function buildHeader(columns, leadHeaders = []) {
  const twoLevel = columns.some(c => c.parent);
  const offset = leadHeaders.length;
  const width = offset + columns.length;

  if (!twoLevel) {
    return { rows: [[...leadHeaders, ...columns.map(c => c.name)]], merges: [] };
  }

  const row1 = new Array(width).fill('');
  const row2 = new Array(width).fill('');
  const merges = [];

  leadHeaders.forEach((h, i) => {
    row1[i] = h;
    merges.push({ s: { r: 0, c: i }, e: { r: 1, c: i } });
  });

  let i = 0;
  while (i < columns.length) {
    const col = columns[i];
    const at = offset + i;
    if (!col.parent) {
      row1[at] = col.name;
      merges.push({ s: { r: 0, c: at }, e: { r: 1, c: at } });
      i++;
    } else {
      const parent = col.parent;
      const start = at;
      while (i < columns.length && columns[i].parent === parent) {
        row2[offset + i] = columns[i].name;
        i++;
      }
      const end = offset + i - 1;
      row1[start] = parent;
      if (start < end) merges.push({ s: { r: 0, c: start }, e: { r: 0, c: end } });
    }
  }

  return { rows: [row1, row2], merges };
}

/**
 * Assemble a worksheet from a column schema and records.
 * @param {object} opts
 * @param {Array} opts.columns  template column schema
 * @param {Array<{lead?:Array, data:object}>} opts.records
 * @param {string[]} [opts.leadHeaders]
 */
function buildSheet({ columns, records, leadHeaders = [] }) {
  const { rows: headerRows, merges } = buildHeader(columns, leadHeaders);
  const aoa = [...headerRows];

  for (const rec of records) {
    aoa.push([
      ...(rec.lead || []).map(v => (v == null ? '' : v)),
      ...columns.map(col => cellValue(rec.data?.[col.name], col.type)),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (merges.length) ws['!merges'] = merges;

  // Width each column to its widest cell so nothing lands as ####.
  const width = leadHeaders.length + columns.length;
  ws['!cols'] = Array.from({ length: width }, (_, c) => {
    const longest = aoa.reduce((max, row) => Math.max(max, String(row[c] ?? '').length), 0);
    return { wch: Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, longest + 2)) };
  });

  return ws;
}

/** Excel forbids []:*?/\ in sheet names and caps them at 31 chars. */
function safeSheetName(name, used) {
  let base = String(name || 'Sheet').replace(/[[\]:*?/\\]/g, '-').trim().slice(0, 31) || 'Sheet';
  if (!used) return base;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

function safeFileName(name, fallback = 'export') {
  const cleaned = String(name || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
  return (cleaned || fallback).slice(0, 90);
}

/**
 * Union of every key present in the submitted rows — the fallback schema for
 * feeds with no template attached (older submissions, the Document Hub).
 */
export function inferColumns(rows) {
  const seen = [];
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) if (!seen.includes(key)) seen.push(key);
  }
  return seen.map(name => ({ name, type: 'text', parent: null }));
}

/** The template schema when there is one, otherwise whatever the rows reveal. */
function resolveColumns(templateColumns, rows) {
  return templateColumns?.length ? templateColumns : inferColumns(rows);
}

const rowsOf = (submission) =>
  Array.isArray(submission?.submitted_data) ? submission.submitted_data : [];

// ─── Cover / summary sheet ────────────────────────────────────────────────────

function buildSummarySheet({ meeting, template, submissions, departments }) {
  const submittedIds = new Set(submissions.map(s => s.department_id));
  const invitedIds = Array.isArray(meeting?.invited_departments) ? meeting.invited_departments : [];
  const invited = invitedIds.length
    ? (departments || []).filter(d => invitedIds.includes(d.id))
    : (departments || []);
  const pending = invited.filter(d => !submittedIds.has(d.id));

  const aoa = [
    ['Meeting Agenda — Submitted Departmental Data'],
    [],
    ['Agenda Title', meeting?.agenda_title || '—'],
    ['Circular Number', meeting?.circular_number || '—'],
    ['Meeting Date', formatDMY(meeting?.meeting_date, '—')],
    ['Meeting Time', meeting?.meeting_time || '—'],
    ['Venue', meeting?.venue || '—'],
    ['Status', (meeting?.status || 'draft').replace(/_/g, ' ')],
    ['Agenda Template', template?.title || 'None linked'],
    ['Exported On', formatDMYTime(new Date())],
    [],
    ['Submissions', `${submissions.length} of ${invited.length || submissions.length} invited departments`],
    [],
    ['Department', 'Department Name', 'Submitted By', 'Role', 'Source File', 'Rows', 'Submitted On'],
  ];

  for (const s of submissions) {
    aoa.push([
      s.department?.code || '—',
      s.department?.name || '—',
      s.user?.full_name || '—',
      s.user?.role || '—',
      s.file_name || '—',
      rowsOf(s).length,
      formatDMYTime(s.updated_at || s.created_at),
    ]);
  }

  if (pending.length) {
    aoa.push([], ['Pending Departments']);
    for (const d of pending) aoa.push([d.code || '—', d.name || '—', 'Not submitted']);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 16 }, { wch: 38 }, { wch: 26 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 20 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  return ws;
}

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * One department's submission as a single-sheet workbook.
 */
export function downloadSubmissionWorkbook({ meeting, template, submission }) {
  const rows = rowsOf(submission);
  if (rows.length === 0) throw new Error('This submission has no data rows to export.');

  const columns = resolveColumns(template?.format_schema?.columns, rows);
  const ws = buildSheet({ columns, records: rows.map(data => ({ data })) });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(submission.department?.code || 'Submission'));

  const file = `${safeFileName(meeting?.agenda_title, 'agenda')}_${safeFileName(submission.department?.code, 'dept')}.xlsx`;
  XLSX.writeFile(wb, file);
  return file;
}

/**
 * Every department's submission for a meeting, in one workbook:
 * a summary cover sheet, a combined all-departments sheet, then one sheet per
 * department so each can still be read in its original shape.
 */
export function downloadMeetingSubmissionsWorkbook({ meeting, template, submissions = [], departments = [] }) {
  const withData = submissions.filter(s => rowsOf(s).length > 0);
  if (withData.length === 0) throw new Error('No department has submitted any spreadsheet data yet.');

  const allRows = withData.flatMap(rowsOf);
  const columns = resolveColumns(template?.format_schema?.columns, allRows);

  const wb = XLSX.utils.book_new();
  const used = new Set();

  XLSX.utils.book_append_sheet(wb, buildSummarySheet({ meeting, template, submissions, departments }),
    safeSheetName('Summary', used));

  // Combined view — every row from every department, tagged with its origin.
  const leadHeaders = ['Department', 'Submitted By', 'Submitted On'];
  const combined = withData.flatMap(s =>
    rowsOf(s).map(data => ({
      lead: [
        s.department?.code || '—',
        s.user?.full_name || '—',
        formatDMYTime(s.updated_at || s.created_at),
      ],
      data,
    }))
  );
  XLSX.utils.book_append_sheet(wb, buildSheet({ columns, records: combined, leadHeaders }),
    safeSheetName('All Departments', used));

  for (const s of withData) {
    const ws = buildSheet({ columns, records: rowsOf(s).map(data => ({ data })) });
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(s.department?.code || s.department?.name || 'Dept', used));
  }

  const file = `${safeFileName(meeting?.agenda_title, 'agenda')}_all_submissions.xlsx`;
  XLSX.writeFile(wb, file);
  return { file, departments: withData.length, rows: allRows.length };
}

/**
 * A single Document Hub data sheet. Hub items carry no column schema, so the
 * layout is inferred from the rows themselves.
 */
export function downloadHubSheetWorkbook(item) {
  const rows = item?.rows || [];
  if (rows.length === 0) throw new Error('This data sheet has no rows to export.');

  const columns = resolveColumns(item?.raw?.agenda_template?.format_schema?.columns, rows);
  const ws = buildSheet({ columns, records: rows.map(data => ({ data })) });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(item.deptCode || 'Data Sheet'));

  const file = `${safeFileName(item.meetingTitle || item.title, 'data_sheet')}_${safeFileName(item.deptCode, 'sheet')}.xlsx`;
  XLSX.writeFile(wb, file);
  return file;
}

/**
 * Every Document Hub data sheet currently in view, as one workbook:
 * an index sheet plus one sheet per submission.
 */
export function downloadHubSheetsWorkbook(items, fileLabel = 'document_hub_data_sheets') {
  const sheets = (items || []).filter(i => i.kind === 'sheet' && (i.rows?.length || 0) > 0);
  if (sheets.length === 0) throw new Error('There are no data sheets with rows to export.');

  const wb = XLSX.utils.book_new();
  const used = new Set();

  const index = [
    ['Document Hub — Submitted Data Sheets'],
    [],
    ['Exported On', formatDMYTime(new Date())],
    ['Data Sheets', sheets.length],
    [],
    ['Department', 'Meeting', 'Source File', 'Submitted By', 'Rows', 'Submitted On', 'Sheet'],
  ];

  const bodies = sheets.map((item) => {
    const name = safeSheetName(
      `${item.deptCode || 'Sheet'} ${item.meetingTitle || item.title || ''}`.trim(),
      used
    );
    index.push([
      item.deptCode || '—',
      item.meetingTitle || '—',
      item.title || '—',
      item.uploadedBy || '—',
      item.rows.length,
      formatDMYTime(item.createdAt),
      name,
    ]);
    return { name, item };
  });

  const indexWs = XLSX.utils.aoa_to_sheet(index);
  indexWs['!cols'] = [{ wch: 14 }, { wch: 40 }, { wch: 40 }, { wch: 24 }, { wch: 8 }, { wch: 20 }, { wch: 32 }];
  indexWs['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  XLSX.utils.book_append_sheet(wb, indexWs, 'Index');

  for (const { name, item } of bodies) {
    const columns = resolveColumns(item?.raw?.agenda_template?.format_schema?.columns, item.rows);
    XLSX.utils.book_append_sheet(wb, buildSheet({ columns, records: item.rows.map(data => ({ data })) }), name);
  }

  const file = `${safeFileName(fileLabel, 'document_hub')}.xlsx`;
  XLSX.writeFile(wb, file);
  return { file, sheets: sheets.length };
}

/**
 * The blank upload template for an agenda: the template's own column layout
 * (merged parent headers included) plus any prefilled example rows, with dates
 * written in dd/mm/yyyy so HODs fill them in the format the parser expects.
 */
export function downloadBlankTemplateWorkbook({ template }) {
  const columns = template?.format_schema?.columns || [];
  if (columns.length === 0) throw new Error('This agenda has no spreadsheet format defined.');

  const defaults = template?.format_schema?.rows || [];
  const records = defaults.length ? defaults.map(data => ({ data })) : [{ data: {} }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSheet({ columns, records }), 'Upload Template');

  const file = `${safeFileName(template?.title, 'agenda')}_template.xlsx`;
  XLSX.writeFile(wb, file);
  return file;
}

// Exposed for the uploader, which needs to know how many header rows to skip.
export { buildHeader, parseToIso };
