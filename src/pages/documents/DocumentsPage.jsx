import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, Download, ExternalLink, Eye, RefreshCw, X, Radio, FileText, FileSpreadsheet, ScrollText, Clock, Layers, Building2 } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { useDocumentHub, useDepartments } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { DOC_STATUS_LABELS, DOC_STATUS_STYLES } from '../../lib/constants';
import { downloadOfficialMomPdf } from '../../lib/momPdf';
import { downloadHubSheetWorkbook, downloadHubSheetsWorkbook } from '../../lib/agendaExcel';
import { formatDMY, formatCellValue } from '../../lib/dateFormat';
import { Spinner, EmptyState } from '../../components/ui/index';

// ── helpers ────────────────────────────────────────────────────────────────
const KIND_META = {
  file:  { label: 'File',       icon: FileText,        wrap: 'bg-primary-50 text-primary-600' },
  sheet: { label: 'Data Sheet', icon: FileSpreadsheet, wrap: 'bg-success-50 text-success-600' },
  mom:   { label: 'MOM',        icon: ScrollText,      wrap: 'bg-violet-50 text-violet-600' },
};

const STATUS_BADGE = {
  ...Object.fromEntries(Object.entries(DOC_STATUS_STYLES).map(([k, v]) => [k, v.badge])),
  submitted: 'badge-primary',
  final:     'badge-success',
};

const fmtDate = (d) => formatDMY(d, '—');

const fmtBytes = (n) => {
  if (!n || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const statusLabel = (s) =>
  s === 'final' ? 'Final' : s === 'submitted' ? 'Submitted' : (DOC_STATUS_LABELS[s] || s);

// ── data-sheet viewer modal ──────────────────────────────────────────────────
function SheetModal({ item, onClose, onDownload }) {
  const rows = item?.rows || [];
  const cols = useMemo(() => {
    const seen = [];
    rows.forEach((r) => Object.keys(r || {}).forEach((k) => { if (!seen.includes(k)) seen.push(k); }));
    return seen;
  }, [rows]);

  if (!item) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-100">
          <div className="min-w-0">
            <h3 className="font-bold text-surface-800 truncate">{item.title}</h3>
            <p className="text-xs text-surface-500 mt-0.5">
              {item.deptCode && <span className="font-semibold">{item.deptCode}</span>}
              {item.deptCode && ' · '}{rows.length} row{rows.length === 1 ? '' : 's'}
              {item.uploadedBy && ` · by ${item.uploadedBy}`} · {fmtDate(item.createdAt)}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5 flex-shrink-0"><X size={18} /></button>
        </div>
        <div className="overflow-auto p-5">
          {rows.length === 0 ? (
            <p className="text-sm text-surface-400 italic text-center py-8">This submission has no row data.</p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 sticky top-0">
                  <th className="p-2 border border-surface-200 text-slate-400 w-10 text-center">#</th>
                  {cols.map((c) => (
                    <th key={c} className="p-2 border border-surface-200 text-left font-bold text-surface-700 whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="hover:bg-slate-50/50">
                    <td className="p-2 border border-surface-100 text-center text-slate-400">{i + 1}</td>
                    {cols.map((c) => (
                      <td key={c} className="p-2 border border-surface-100 text-surface-700">
                        {r?.[c] == null || r[c] === '' ? <span className="text-surface-300">—</span> : formatCellValue(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="p-4 border-t border-surface-100 flex justify-end gap-2">
          {rows.length > 0 && (
            <button onClick={() => onDownload(item)} className="btn-secondary text-xs">
              <Download size={13} /> Download Excel
            </button>
          )}
          {item.meetingId && (
            <Link to={`/meetings/agendas/${item.meetingId}`} className="btn-secondary text-xs">
              <ExternalLink size={13} /> Open meeting
            </Link>
          )}
          <button onClick={onClose} className="btn-primary text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}

// ── one feed row ──────────────────────────────────────────────────────────────
function HubRow({ item, onView, onDownload }) {
  const meta = KIND_META[item.kind] || KIND_META.file;
  const Icon = meta.icon;

  const downloadMom = () => {
    try {
      downloadOfficialMomPdf(item.momContent, item.meetingTitle || 'MOM');
    } catch {
      toast.error('This MOM has no printable content yet. Open it to generate the official minutes.');
    }
  };

  return (
    <div className="card p-4 flex flex-col sm:flex-row sm:items-center gap-4">
      <div className={clsx('flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center', meta.wrap)}>
        <Icon size={18} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="badge-surface text-[10px]">{meta.label}</span>
          {item.deptCode && <span className="badge-surface text-[10px]">{item.deptCode}</span>}
          <span className={clsx('badge text-[10px]', STATUS_BADGE[item.status] || 'badge-surface')}>
            {statusLabel(item.status)}
          </span>
          {item.kind === 'sheet' && (
            <span className="badge-surface text-[10px]">{item.rowCount} rows</span>
          )}
          {item.kind === 'file' && item.version > 1 && (
            <span className="badge-warning text-[10px]">v{item.version}</span>
          )}
        </div>
        <p className="text-sm font-semibold text-surface-800 truncate">{item.title}</p>
        <p className="text-xs text-surface-400 mt-0.5 truncate">
          {item.uploadedBy ? `By ${item.uploadedBy} · ` : ''}{fmtDate(item.createdAt)}
          {item.docType && item.kind === 'file' ? ` · ${item.docType}` : ''}
          {item.fileSize ? ` · ${fmtBytes(item.fileSize)}` : ''}
          {item.meetingTitle ? ` · ${item.meetingTitle}` : ''}
        </p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {item.kind === 'file' && item.fileUrl && (
          <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs">
            <Download size={13} /> Open
          </a>
        )}
        {item.kind === 'sheet' && (
          <>
            <button
              onClick={() => onDownload(item)}
              disabled={item.rowCount === 0}
              title={item.rowCount === 0 ? 'This submission has no rows' : 'Download this data sheet as Excel'}
              className="btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download size={13} /> Excel
            </button>
            <button onClick={() => onView(item)} className="btn-secondary text-xs">
              <Eye size={13} /> View data
            </button>
          </>
        )}
        {item.kind === 'mom' && (
          <>
            <button onClick={downloadMom} className="btn-secondary text-xs">
              <Download size={13} /> PDF
            </button>
            {item.meetingId && (
              <Link to={`/meetings/agendas/${item.meetingId}/mom`} className="btn-primary text-xs">
                <Eye size={13} /> View MOM
              </Link>
            )}
          </>
        )}
        {item.kind !== 'mom' && item.meetingId && (
          <Link to={`/meetings/agendas/${item.meetingId}`} className="btn-ghost text-xs" title="Open meeting">
            <ExternalLink size={13} />
          </Link>
        )}
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const { items, isLoading, refetch } = useDocumentHub();
  const { data: departments = [] } = useDepartments();
  const { canViewAll } = useAuth();

  const [tab, setTab] = useState('list'); // 'list' | 'byDept'
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [deptFilter, setDeptFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [viewing, setViewing] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      const matchSearch = !q ||
        it.title?.toLowerCase().includes(q) ||
        it.docType?.toLowerCase().includes(q) ||
        it.deptCode?.toLowerCase().includes(q) ||
        it.uploadedBy?.toLowerCase().includes(q) ||
        it.meetingTitle?.toLowerCase().includes(q);
      const matchKind = kindFilter === 'all' || it.kind === kindFilter;
      const matchDept = deptFilter === 'all' || it.deptCode === deptFilter;
      const matchStatus = statusFilter === 'all' || it.status === statusFilter;
      return matchSearch && matchKind && matchDept && matchStatus;
    });
  }, [items, search, kindFilter, deptFilter, statusFilter]);

  const counts = useMemo(() => ({
    total: items.length,
    file: items.filter((i) => i.kind === 'file').length,
    sheet: items.filter((i) => i.kind === 'sheet').length,
    mom: items.filter((i) => i.kind === 'mom').length,
    pending: items.filter((i) => i.kind === 'file' &&
      ['pending', 'submitted', 'overdue', 'revision_requested'].includes(i.status)).length,
  }), [items]);

  // Per-department rollup (files + data sheets; MOMs are institute-level).
  const byDept = useMemo(() => {
    const map = new Map();
    departments.forEach((d) => map.set(d.code, { code: d.code, name: d.name, file: 0, sheet: 0, last: null }));
    items.forEach((it) => {
      if (!it.deptCode) return;
      if (!map.has(it.deptCode)) map.set(it.deptCode, { code: it.deptCode, name: it.deptName || it.deptCode, file: 0, sheet: 0, last: null });
      const row = map.get(it.deptCode);
      if (it.kind === 'file') row.file += 1;
      if (it.kind === 'sheet') row.sheet += 1;
      if (!row.last || new Date(it.createdAt) > new Date(row.last)) row.last = it.createdAt;
    });
    return [...map.values()].sort((a, b) => (b.file + b.sheet) - (a.file + a.sheet));
  }, [items, departments]);

  // Every data sheet currently passing the filters — what "export all" acts on.
  const exportableSheets = useMemo(
    () => filtered.filter((i) => i.kind === 'sheet' && (i.rows?.length || 0) > 0),
    [filtered]
  );

  const handleDownloadSheet = (item) => {
    try {
      downloadHubSheetWorkbook(item);
      toast.success(`Downloaded ${item.deptCode || 'data sheet'} as Excel.`);
    } catch (err) {
      toast.error(err.message || 'Failed to export this data sheet');
    }
  };

  const handleDownloadAllSheets = () => {
    try {
      const res = downloadHubSheetsWorkbook(exportableSheets);
      toast.success(`Exported ${res.sheets} data sheet(s) into one workbook.`);
    } catch (err) {
      toast.error(err.message || 'Failed to export data sheets');
    }
  };

  const KPIS = [
    { label: 'Total Records', value: counts.total, color: 'text-surface-700', icon: Layers },
    { label: 'Files',         value: counts.file,  color: 'text-primary-600', icon: FileText },
    { label: 'Data Sheets',   value: counts.sheet, color: 'text-success-600', icon: FileSpreadsheet },
    { label: 'MOMs',          value: counts.mom,   color: 'text-violet-600',  icon: ScrollText },
    { label: 'Pending Review',value: counts.pending, color: 'text-warning-600', icon: Clock },
  ];

  return (
    <div className="page-wrapper">
      {/* Header */}
      <div className="section-header mb-6">
        <div>
          <h1 className="section-title">Document Hub</h1>
          <p className="section-subtitle">
            Every file, data sheet, and MOM ever submitted — linked to its meeting, kept permanently, updated live.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-success-600 bg-success-50 px-2.5 py-1 rounded-full">
            <Radio size={13} className="animate-pulse" /> Live
          </span>
          {canViewAll && (
            <button
              onClick={handleDownloadAllSheets}
              disabled={exportableSheets.length === 0}
              title={exportableSheets.length === 0
                ? 'No data sheets match the current filters'
                : 'Download every data sheet in view as one Excel workbook'}
              className="btn-secondary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FileSpreadsheet size={14} className="text-success-600" />
              Download All Excel Data
              {exportableSheets.length > 0 && (
                <span className="text-[10px] font-bold bg-success-50 text-success-700 px-1.5 py-0.5 rounded">
                  {exportableSheets.length}
                </span>
              )}
            </button>
          )}
          <button onClick={() => refetch()} className="btn-secondary text-sm" title="Refresh now">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {KPIS.map((kpi) => (
          <div key={kpi.label} className="card p-4 text-center">
            <p className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</p>
            <p className="text-xs text-surface-500 mt-1">{kpi.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 bg-surface-100 p-1 rounded-xl w-fit">
        {[['list', 'All Records'], ['byDept', 'By Department']].map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              tab === t ? 'bg-white text-primary-700 shadow-sm' : 'text-surface-500 hover:text-surface-700'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'list' ? (
        <>
          {/* Filters */}
          <div className="card p-4 mb-5">
            <div className="flex flex-col lg:flex-row gap-3">
              <div className="relative flex-1">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input
                  type="search"
                  placeholder="Search by title, department, person, meeting…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 text-sm w-full"
                />
              </div>
              <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="lg:w-40 text-sm">
                <option value="all">All Types</option>
                <option value="file">Files</option>
                <option value="sheet">Data Sheets</option>
                <option value="mom">MOMs</option>
              </select>
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="lg:w-40 text-sm">
                <option value="all">All Depts</option>
                {departments.map((d) => <option key={d.id} value={d.code}>{d.code}</option>)}
              </select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="lg:w-44 text-sm">
                <option value="all">All Status</option>
                {Object.entries(DOC_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                <option value="final">Final (MOM)</option>
              </select>
            </div>
          </div>

          {/* Feed */}
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner size={28} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={items.length === 0 ? 'Nothing submitted yet' : 'No matching records'}
              description={items.length === 0
                ? 'When HODs or faculty upload files, submit data sheets in a meeting, or a MOM is generated, everything shows up here automatically.'
                : 'Try clearing the search or filters above.'}
            />
          ) : (
            <>
              <p className="text-xs text-surface-400 mb-2">{filtered.length} of {items.length} records</p>
              <div className="space-y-2">
                {filtered.map((it) => (
                  <HubRow key={it.id} item={it} onView={setViewing} onDownload={handleDownloadSheet} />
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        /* By Department */
        <div className="card p-5 overflow-x-auto">
          <h3 className="text-base font-semibold text-surface-800 mb-4 flex items-center gap-2">
            <Building2 size={18} className="text-surface-400" /> Submissions by Department
          </h3>
          {isLoading ? (
            <div className="flex justify-center py-10"><Spinner size={24} /></div>
          ) : (
            <table className="w-full text-sm border-collapse min-w-[560px]">
              <thead>
                <tr className="text-left text-xs text-surface-500 border-b border-surface-200">
                  <th className="p-2.5">Department</th>
                  <th className="p-2.5 text-center">Files</th>
                  <th className="p-2.5 text-center">Data Sheets</th>
                  <th className="p-2.5 text-center">Total</th>
                  <th className="p-2.5">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {byDept.map((r) => (
                  <tr key={r.code} className="border-b border-surface-100 hover:bg-surface-50">
                    <td className="p-2.5">
                      <span className="font-semibold text-surface-800">{r.code}</span>
                      <span className="text-surface-400 text-xs ml-2 hidden sm:inline">{r.name}</span>
                    </td>
                    <td className="p-2.5 text-center text-primary-600 font-semibold">{r.file}</td>
                    <td className="p-2.5 text-center text-success-600 font-semibold">{r.sheet}</td>
                    <td className="p-2.5 text-center font-bold text-surface-800">{r.file + r.sheet}</td>
                    <td className="p-2.5 text-surface-500 text-xs">{r.last ? fmtDate(r.last) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {counts.mom > 0 && (
            <p className="text-xs text-surface-400 mt-4 flex items-center gap-1.5">
              <ScrollText size={13} className="text-violet-500" />
              {counts.mom} institute-level MOM{counts.mom === 1 ? '' : 's'} are listed under the All Records tab.
            </p>
          )}
        </div>
      )}

      {viewing && (
        <SheetModal item={viewing} onClose={() => setViewing(null)} onDownload={handleDownloadSheet} />
      )}
    </div>
  );
}
