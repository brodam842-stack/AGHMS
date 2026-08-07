import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, FileText, Users, TrendingUp, CheckSquare, IndianRupee, GraduationCap, CheckCircle2, ArrowRight, Clock, AlertTriangle, Activity } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useMeetings, useDocuments, useActionItems, useDashboard, useCurrentYear, useDepartments, useFees, usePlacementStats, useAuditLogs } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { MEETING_STATUS_COLORS, MEETING_STATUS_LABELS } from '../../lib/constants';
import { formatDate } from '../../lib/supabaseHelpers';
import { SkeletonCard, ProgressBar } from '../../components/ui/index';
import { jsPDF } from 'jspdf';
import { renderMarkdownToPdf } from '../../lib/pdfMarkdown';

const STATUS_PIE_COLORS = { approved: '#22c55e', submitted: '#3b82f6', submitted_late: '#f59e0b', pending: '#94a3b8', revision_requested: '#a855f7', overdue: '#ef4444' };
const STATUS_PIE_LABELS = { approved: 'Approved', submitted: 'Submitted', submitted_late: 'Late', pending: 'Pending', revision_requested: 'Revision', overdue: 'Overdue' };

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : formatDate(dateStr);
}

// ─── KPI Card ──────────────────────────────────────────────────────────────────
function KPICard({ icon: Icon, label, value, sub, color, to, trend }) {
  const card = (
    <div className={`kpi-card group ${to ? 'cursor-pointer hover:shadow-card-hover' : ''}`}>
      <div className={`p-2.5 rounded-xl border w-fit ${color}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-2xl font-black text-surface-900">{value ?? '—'}</p>
        <p className="text-sm font-medium text-surface-600">{label}</p>
        {sub && <p className="text-xs text-surface-400 mt-0.5">{sub}</p>}
      </div>
      {trend !== undefined && (
        <div className={`mt-auto text-xs font-semibold flex items-center gap-1 ${trend >= 0 ? 'text-success-600' : 'text-danger-600'}`}>
          <TrendingUp size={12} className={trend < 0 ? 'rotate-180' : ''} />
          {Math.abs(trend)}% vs last month
        </div>
      )}
      {to && (
        <ArrowRight size={14} className="absolute right-4 top-1/2 -translate-y-1/2 text-surface-300 group-hover:text-primary-500 group-hover:translate-x-1 transition-all" />
      )}
    </div>
  );
  return to ? <Link to={to}>{card}</Link> : card;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { profile, role } = useAuth();
  const { data: kpis, isLoading: kpisLoading } = useDashboard();
  const { data: meetings = [], isLoading: meetingsLoading } = useMeetings({});
  const { data: documents = [] } = useDocuments({});
  const { data: actionItems = [] } = useActionItems({});
  const { data: currentYear } = useCurrentYear();
  const { data: departments = [] } = useDepartments();
  const { data: fees = [] } = useFees({});
  const { data: placementStats } = usePlacementStats();
  const { data: auditLogs = [] } = useAuditLogs();

  const userDept = departments.find(d => d.id === profile?.department_id);
  const userDeptCode = userDept?.code;
  const today = new Date();

  const filteredMeetings = meetings.filter(m => {
    if (['admin', 'principal', 'director'].includes(role)) return true;
    if (m.invited_departments && m.invited_departments.length > 0) {
      return m.invited_departments.includes(profile?.department_id);
    }
    return true;
  });

  // ── Real KPI figures ──────────────────────────────────────────────────────
  const pendingMeetings = filteredMeetings.filter(m => m.status === 'pending_approval').length;
  const upcomingMeetings = filteredMeetings.filter(m => ['approved', 'circulated'].includes(m.status) && (!m.meeting_date || new Date(m.meeting_date) >= today)).length;
  const overdueActions = actionItems.filter(a => a.status !== 'completed' && a.deadline && new Date(a.deadline) < today).length;
  const completedActions = actionItems.filter(a => a.status === 'completed').length;
  const pendingDocs = documents.filter(d => d.status === 'pending').length;

  const feeTotals = fees.reduce((acc, f) => { acc.payable += Number(f.net_payable) || 0; acc.paid += Number(f.total_paid) || 0; return acc; }, { payable: 0, paid: 0 });
  const feePct = feeTotals.payable > 0 ? Math.round((feeTotals.paid / feeTotals.payable) * 100) : null;
  const placedCount = placementStats?.placed ?? 0;

  // ── Document status distribution (real) ───────────────────────────────────
  const docStatusPie = useMemo(() => {
    const counts = {};
    documents.forEach(d => { counts[d.status] = (counts[d.status] || 0) + 1; });
    return Object.entries(counts)
      .map(([status, value]) => ({ name: STATUS_PIE_LABELS[status] || status, value, color: STATUS_PIE_COLORS[status] || '#94a3b8' }))
      .sort((a, b) => b.value - a.value);
  }, [documents]);

  // ── Department document compliance (real) ─────────────────────────────────
  const deptCompliance = useMemo(() => {
    const map = {};
    documents.forEach(d => {
      const code = d.department?.code || 'Other';
      if (!map[code]) map[code] = { dept: code, total: 0, done: 0 };
      map[code].total += 1;
      if (['approved', 'submitted', 'submitted_late'].includes(d.status)) map[code].done += 1;
    });
    return Object.values(map)
      .map(m => ({ dept: m.dept, pct: m.total ? Math.round((m.done / m.total) * 100) : 0 }))
      .sort((a, b) => b.pct - a.pct);
  }, [documents]);

  // ── 6-month activity trend (real) ─────────────────────────────────────────
  const trendData = useMemo(() => {
    const months = [];
    const idx = {};
    for (let k = 5; k >= 0; k--) {
      const d = new Date(today.getFullYear(), today.getMonth() - k, 1);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      idx[key] = months.length;
      months.push({ month: d.toLocaleString('default', { month: 'short' }), meetings: 0, documents: 0, actions: 0 });
    }
    const bump = (dateStr, field) => {
      if (!dateStr) return;
      const d = new Date(dateStr);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (idx[key] != null) months[idx[key]][field] += 1;
    };
    meetings.forEach(m => bump(m.meeting_date, 'meetings'));
    documents.forEach(d => bump(d.created_at, 'documents'));
    actionItems.forEach(a => bump(a.created_at, 'actions'));
    return months;
  }, [meetings, documents, actionItems]);

  const recentActivity = useMemo(() =>
    (auditLogs || []).slice(0, 6).map(l => ({
      text: `${l.user?.full_name || 'Someone'} ${String(l.action_type || 'updated').replace(/_/g, ' ')} ${l.entity_type || ''}`.trim(),
      time: timeAgo(l.created_at),
    })), [auditLogs]);

  const isStaff = ['hod', 'faculty'].includes(role);
  const postMeetingBrief = isStaff && meetings.find(m =>
    m.status === 'conducted' &&
    m.ai_summary?.departmentBriefs &&
    userDeptCode &&
    m.ai_summary.departmentBriefs[userDeptCode]
  );

  const handleDownloadMOMPDF = (meeting, briefText, deptName) => {
    const doc = new jsPDF();
    const pageH = doc.internal.pageSize.getHeight();
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 15;
    const contentW = pageW - margin * 2;

    // Header banner
    doc.setFillColor(79, 70, 229);
    doc.rect(0, 0, pageW, 35, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('RNGPIT ACADEMIC GOVERNANCE SYSTEM', margin, 14);
    doc.setFontSize(9);
    doc.setFont('Helvetica', 'normal');
    doc.text('AUTOMATED DEPARTMENTAL MINUTES OF MEETING (MOM)', margin, 26);

    // Meeting details
    let y = 48;
    doc.setTextColor(30, 41, 59);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('MEETING DETAILS', margin, y); y += 8;
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(51, 65, 85);
    doc.text(`Title: ${meeting.agenda_title}`, margin, y); y += 6;
    doc.text(`Date: ${formatDate(meeting.meeting_date)}`, margin, y); y += 6;
    doc.text(`Venue: ${meeting.venue || '—'}`, margin, y); y += 6;
    doc.text(`Department: ${deptName}`, margin, y); y += 8;
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, y, pageW - margin, y); y += 8;

    // Brief (rich markdown → headings, lists, real tables)
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(30, 41, 59);
    doc.text('DEPARTMENT-SPECIFIC BRIEF & ACTION PLANS', margin, y); y += 8;
    renderMarkdownToPdf(doc, briefText, { x: margin, y, maxWidth: contentW, margin, bottom: pageH - 22 });

    // Footer on last page
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, pageH - 20, pageW - margin, pageH - 20);
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text('AI-generated official minutes brief dispatched post-meeting conclusion.', margin, pageH - 12);
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageW - margin - 60, pageH - 12);

    doc.save(`${meeting.agenda_title.replace(/\s+/g, '_')}_${deptName}_MOM.pdf`);
  };

  const todayLabel = today.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const greeting = today.getHours() < 12 ? 'Good Morning' : today.getHours() < 17 ? 'Good Afternoon' : 'Good Evening';

  return (
    <div className="page-wrapper">
      {/* Welcome bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <p className="text-sm text-surface-400 mb-1">{todayLabel}</p>
          <h1 className="text-2xl font-black text-surface-900">
            {greeting}, {profile?.full_name?.split(' ')[0] || 'Welcome'} 👋
          </h1>
          <p className="text-surface-500 text-sm mt-1">
            {currentYear ? `Academic Year ${currentYear.year_name}` : 'RNGPIT Academic Governance'} · {role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Dashboard'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/meetings/agendas/new" className="btn-primary text-sm"><Calendar size={14} /> New Agenda</Link>
          <Link to="/reports" className="btn-secondary text-sm"><FileText size={14} /> Reports</Link>
        </div>
      </div>

      {/* KPI Grid — all real */}
      {kpisLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[...Array(8)].map((_, i) => <SkeletonCard key={i} lines={3} />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <KPICard icon={Calendar}      label="Upcoming Meetings" value={upcomingMeetings}                    sub="Approved & circulated" color="bg-primary-50 border-primary-100 text-primary-600"   to="/meetings/agendas" />
          <KPICard icon={Clock}         label="Pending Approvals" value={pendingMeetings}                     sub="Awaiting review"       color="bg-warning-50 border-warning-100 text-warning-600"   to="/meetings/agendas" />
          <KPICard icon={FileText}      label="Documents Pending" value={pendingDocs || kpis?.pendingDocuments || 0} sub="Awaiting submission" color="bg-orange-50 border-orange-100 text-orange-600" to="/documents" />
          <KPICard icon={AlertTriangle} label="Actions Overdue"   value={overdueActions}                      sub="Needs attention"       color="bg-danger-50 border-danger-100 text-danger-600"      to="/meetings/action-items" />
          <KPICard icon={Users}         label="Active Students"   value={kpis?.activeStudents ?? 0}           sub="All departments"       color="bg-success-50 border-success-100 text-success-600"   to="/academics/attendance" />
          <KPICard icon={IndianRupee}   label="Fee Collection"    value={feePct == null ? '—' : `${feePct}%`} sub={currentYear?.year_name ? `AY ${currentYear.year_name}` : 'Collected vs payable'} color="bg-emerald-50 border-emerald-100 text-emerald-600" to="/fees" />
          <KPICard icon={GraduationCap} label="Placed Students"   value={placedCount}                         sub="Accepted offers"       color="bg-violet-50 border-violet-100 text-violet-600"      to="/placement" />
          <KPICard icon={CheckSquare}   label="Completed Actions" value={completedActions}                    sub="Closed action items"   color="bg-indigo-50 border-indigo-100 text-indigo-600"      to="/meetings/action-items" />
        </div>
      )}

      {/* AI MOM Brief Card for HOD / Faculty */}
      {postMeetingBrief && (
        <div className="card p-6 mb-6 border-l-4 border-violet-500 bg-gradient-to-r from-violet-50/50 to-indigo-50/10 shadow-md rounded-3xl overflow-hidden relative">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-5">
            <div className="flex items-start gap-4 flex-1">
              <div className="p-3 bg-violet-100 rounded-2xl text-violet-600 flex-shrink-0 mt-0.5">
                <CheckCircle2 size={24} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span className="text-[10px] bg-violet-100 text-violet-700 px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider">AI Generated MOM Brief</span>
                  <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-semibold">{formatDate(postMeetingBrief.meeting_date)}</span>
                </div>
                <h3 className="text-base font-black text-surface-900 leading-tight">MOM Actions Brief: {postMeetingBrief.agenda_title}</h3>
                <p className="text-xs text-surface-600 mt-2 leading-relaxed whitespace-pre-wrap font-medium bg-white/40 p-4 rounded-xl border border-violet-100/50">
                  {postMeetingBrief.ai_summary.departmentBriefs[userDeptCode]}
                </p>
              </div>
            </div>
            <button
              onClick={() => handleDownloadMOMPDF(postMeetingBrief, postMeetingBrief.ai_summary.departmentBriefs[userDeptCode], userDeptCode)}
              className="btn-primary text-xs bg-violet-600 hover:bg-violet-700 shadow-md border-0 flex items-center gap-1.5 font-bold shrink-0 self-end md:self-center"
            >
              <FileText size={14} /> Download Brief PDF
            </button>
          </div>
        </div>
      )}

      {/* Main content grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left: Charts */}
        <div className="xl:col-span-2 space-y-6">
          {/* Department document compliance */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-surface-900">Department Document Compliance</h3>
                <p className="text-xs text-surface-400 mt-0.5">Submitted &amp; approved share of required documents</p>
              </div>
              <Link to="/documents" className="text-xs text-primary-600 font-semibold hover:underline flex items-center gap-1">Documents <ArrowRight size={12} /></Link>
            </div>
            {deptCompliance.length === 0 ? (
              <p className="text-xs text-surface-400 text-center py-16">No document data yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={deptCompliance}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="dept" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={v => [`${v}%`]} />
                  <Bar dataKey="pct" name="Compliance %" radius={[4, 4, 0, 0]}>
                    {deptCompliance.map((e, i) => <Cell key={i} fill={e.pct >= 80 ? '#22c55e' : e.pct >= 60 ? '#f59e0b' : '#ef4444'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Activity Trend */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-surface-900">Activity Trend</h3>
                <p className="text-xs text-surface-400 mt-0.5">Meetings, documents &amp; actions · last 6 months</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                <Line type="monotone" dataKey="documents" name="Documents" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="actions" name="Actions" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 4 }} />
                <Line type="monotone" dataKey="meetings" name="Meetings" stroke="#22c55e" strokeWidth={2.5} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right: Lists & Pie */}
        <div className="space-y-5">
          {/* Document status pie */}
          <div className="card p-5">
            <h3 className="text-sm font-bold text-surface-800 mb-3">Document Status</h3>
            {docStatusPie.length === 0 ? (
              <p className="text-xs text-surface-400 text-center py-8">No documents yet.</p>
            ) : (
              <div className="flex items-center gap-3">
                <ResponsiveContainer width={100} height={100}>
                  <PieChart>
                    <Pie data={docStatusPie} cx="50%" cy="50%" outerRadius={45} innerRadius={25} dataKey="value" paddingAngle={2}>
                      {docStatusPie.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-1.5 flex-1">
                  {docStatusPie.map(s => (
                    <div key={s.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
                        <span className="text-xs text-surface-600">{s.name}</span>
                      </div>
                      <span className="text-xs font-bold text-surface-800">{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Upcoming meetings */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-surface-800">Upcoming Meetings</h3>
              <Link to="/meetings/agendas" className="text-xs text-primary-600 font-semibold hover:underline">View all</Link>
            </div>
            {meetingsLoading ? (
              <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
            ) : filteredMeetings.filter(m => !m.meeting_date || new Date(m.meeting_date) >= today).length === 0 ? (
              <p className="text-xs text-surface-400 text-center py-4">No upcoming meetings</p>
            ) : (
              <div className="space-y-2">
                {filteredMeetings
                  .filter(m => !m.meeting_date || new Date(m.meeting_date) >= today)
                  .slice(0, 4)
                  .map(m => (
                    <Link key={m.id} to={`/meetings/agendas/${m.id}`} className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-surface-50 transition-colors group">
                      <div className="w-9 h-9 rounded-xl bg-primary-50 flex flex-col items-center justify-center flex-shrink-0">
                        <span className="text-[10px] text-primary-500 font-semibold leading-tight">{new Date(m.meeting_date).toLocaleString('default', { month: 'short' })}</span>
                        <span className="text-sm font-black text-primary-700 leading-tight">{new Date(m.meeting_date).getDate()}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-surface-800 truncate group-hover:text-primary-700 transition-colors">{m.agenda_title}</p>
                        <span className={`badge text-[10px] mt-0.5 ${MEETING_STATUS_COLORS[m.status]}`}>{MEETING_STATUS_LABELS[m.status]}</span>
                      </div>
                    </Link>
                  ))}
              </div>
            )}
          </div>

          {/* Recent activity */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-surface-800">Recent Activity</h3>
            </div>
            {recentActivity.length === 0 ? (
              <p className="text-xs text-surface-400 text-center py-4">No recent activity logged.</p>
            ) : (
              <div className="space-y-3">
                {recentActivity.map((a, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-primary-100 text-primary-600">
                      <Activity size={12} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-surface-700 leading-snug capitalize">{a.text}</p>
                      <p className="text-[10px] text-surface-400 mt-0.5">{a.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* HOD compliance mini-table (real) */}
          {deptCompliance.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-surface-800">Dept Doc. Compliance</h3>
                <Link to="/documents" className="text-xs text-primary-600 font-semibold hover:underline">Details</Link>
              </div>
              <div className="space-y-2">
                {deptCompliance.slice(0, 8).map(d => (
                  <div key={d.dept} className="flex items-center gap-2">
                    <span className="text-xs font-semibold w-10 text-surface-700">{d.dept}</span>
                    <ProgressBar value={d.pct} showLabel={false} className="flex-1" />
                    <span className={`text-xs font-bold w-9 text-right ${d.pct >= 80 ? 'text-success-700' : d.pct >= 65 ? 'text-warning-700' : 'text-danger-700'}`}>{d.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
