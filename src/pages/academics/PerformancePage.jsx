import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, Award, AlertTriangle, Users, Download, UserCog, BookOpen } from 'lucide-react';
import toast from 'react-hot-toast';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import { exportToCSV } from '../../lib/exportUtils';
import { useResultsList, useFacultyPerformance, useSubjects, useAssignSubjectFaculty, useUsers } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { Spinner, TabBar } from '../../components/ui/index';

// CO attainment target: a student "attains" the CO for an exam if they score >= 60%.
const CO_TARGET = 60;
const attColor = (v) => v == null ? 'text-surface-400' : v >= 70 ? 'text-success-700' : v >= 55 ? 'text-warning-700' : 'text-danger-700';
const attBar   = (v) => v >= 70 ? 'bg-success-500' : v >= 55 ? 'bg-warning-500' : 'bg-danger-500';

export default function PerformancePage() {
  const { canApprove } = useAuth();
  const [tab, setTab] = useState('dept');
  const [selectedDept, setSelectedDept] = useState('all');

  const { data: resultsRaw = [], isLoading } = useResultsList({});
  const { data: fp, isLoading: fpLoading } = useFacultyPerformance();
  const { data: subjects = [] } = useSubjects({});
  const { data: allUsers = [] } = useUsers({});
  const assignFaculty = useAssignSubjectFaculty();

  const teachers = allUsers.filter(u => ['faculty', 'hod'].includes(u.role));

  // ── Department metrics (computed from real exam marks) ──────────────────────
  const deptMetrics = useMemo(() => {
    const map = {};
    resultsRaw.forEach(r => {
      const code = r.student?.department?.code || 'Unknown';
      const name = r.student?.department?.name || code;
      if (!map[code]) {
        map[code] = { dept: code, fullName: name, exams: 0, pass: 0, backlogs: 0, attain: 0, sgpaSum: 0, sgpaCount: 0, studentSet: new Set() };
      }
      const d = map[code];
      d.studentSet.add(r.student_id);
      if (r.marks_obtained != null && r.total_marks != null && r.total_marks > 0) {
        d.exams += 1;
        const pct = (r.marks_obtained / r.total_marks) * 100;
        if (pct >= 40) d.pass += 1; else d.backlogs += 1;
        if (pct >= CO_TARGET) d.attain += 1;
      }
      if (r.sgpa) { d.sgpaSum += r.sgpa; d.sgpaCount += 1; }
    });
    return Object.values(map).map(d => ({
      dept:          d.dept,
      fullName:      d.fullName,
      students:      d.studentSet.size,
      result:        d.exams > 0 ? Math.round((d.pass / d.exams) * 100) : 0,
      pass:          d.exams > 0 ? Math.round((d.pass / d.exams) * 100) : 0,
      sgpa:          d.sgpaCount > 0 ? parseFloat((d.sgpaSum / d.sgpaCount).toFixed(2)) : 0,
      backlog:       d.backlogs,
      co_attainment: d.exams > 0 ? Math.round((d.attain / d.exams) * 100) : 0,
    })).sort((a, b) => a.dept.localeCompare(b.dept));
  }, [resultsRaw]);

  const data = selectedDept === 'all' ? deptMetrics : deptMetrics.filter(d => d.dept === selectedDept);

  const getColor = (v, t = [75, 60]) => v >= t[0] ? 'text-success-700' : v >= t[1] ? 'text-warning-700' : 'text-danger-700';
  const getBg    = (v, t = [75, 60]) => v >= t[0] ? 'bg-success-50 border-success-200' : v >= t[1] ? 'bg-warning-50 border-warning-200' : 'bg-danger-50 border-danger-200';

  const avgResult    = deptMetrics.length ? Math.round(deptMetrics.reduce((s, d) => s + d.result, 0) / deptMetrics.length) : 0;
  const avgSGPA      = deptMetrics.length ? (deptMetrics.reduce((s, d) => s + d.sgpa, 0) / deptMetrics.length).toFixed(2) : '—';
  const totalBacklog = deptMetrics.reduce((s, d) => s + d.backlog, 0);
  const totalStudents = deptMetrics.reduce((s, d) => s + d.students, 0);

  // ── Faculty-wise CO attainment (computed from mid-term & end-sem marks) ─────
  const facultyMetrics = useMemo(() => {
    const subs = fp?.subjects ?? [];
    const results = fp?.results ?? [];

    // Per-subject attainment split by exam type
    const bySubject = {};
    results.forEach(r => {
      if (r.total_marks == null || r.total_marks <= 0 || r.marks_obtained == null) return;
      const pct = (r.marks_obtained / r.total_marks) * 100;
      const s = bySubject[r.subject_id] || (bySubject[r.subject_id] = { mid: { t: 0, a: 0 }, end: { t: 0, a: 0 } });
      const bucket = r.exam_type === 'end_sem' ? s.end : (r.exam_type === 'mid_term' || r.exam_type === 'midsem') ? s.mid : null;
      if (bucket) { bucket.t += 1; if (pct >= CO_TARGET) bucket.a += 1; }
    });
    const subAtt = (id) => {
      const s = bySubject[id];
      if (!s) return { mid: null, end: null };
      return {
        mid: s.mid.t ? Math.round((s.mid.a / s.mid.t) * 100) : null,
        end: s.end.t ? Math.round((s.end.a / s.end.t) * 100) : null,
      };
    };

    const facMap = {};
    subs.forEach(sub => {
      const key = sub.faculty_id || '__unassigned__';
      if (!facMap[key]) {
        facMap[key] = {
          id: key,
          name: sub.faculty?.full_name || 'Unassigned',
          dept: sub.department?.code || '—',
          subjects: [], mid: [], end: [],
        };
      }
      const att = subAtt(sub.id);
      facMap[key].subjects.push({ ...sub, att });
      if (att.mid != null) facMap[key].mid.push(att.mid);
      if (att.end != null) facMap[key].end.push(att.end);
    });

    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    return Object.values(facMap).map(f => ({
      ...f,
      midAtt: avg(f.mid),
      endAtt: avg(f.end),
      overall: avg([...f.mid, ...f.end]),
      subjectCount: f.subjects.length,
    })).sort((a, b) => {
      if (a.id === '__unassigned__') return 1;
      if (b.id === '__unassigned__') return -1;
      return (b.overall ?? -1) - (a.overall ?? -1);
    });
  }, [fp]);

  const assigned = facultyMetrics.filter(f => f.id !== '__unassigned__');
  const facAvgMid = assigned.filter(f => f.midAtt != null);
  const facAvgEnd = assigned.filter(f => f.endAtt != null);
  const avgMid = facAvgMid.length ? Math.round(facAvgMid.reduce((s, f) => s + f.midAtt, 0) / facAvgMid.length) : null;
  const avgEnd = facAvgEnd.length ? Math.round(facAvgEnd.reduce((s, f) => s + f.endAtt, 0) / facAvgEnd.length) : null;

  const handleAssign = async (subjectId, facultyId) => {
    try {
      await assignFaculty.mutateAsync({ id: subjectId, facultyId });
      toast.success('Faculty assignment updated');
    } catch (err) { toast.error(err.message || 'Failed to assign faculty'); }
  };

  if (isLoading) {
    return <div className="page-wrapper min-h-[60vh] flex items-center justify-center"><Spinner size={40} /></div>;
  }

  return (
    <div className="page-wrapper">
      <div className="section-header mb-6">
        <div>
          <h1 className="section-title">Academic Performance</h1>
          <p className="section-subtitle">Department & faculty CO attainment from mid-term and end-semester exams</p>
        </div>
        <button
          onClick={() => exportToCSV(tab === 'dept' ? data : facultyMetrics.map(({ subjects: _s, mid: _m, end: _e, ...f }) => f), `${tab}_performance.csv`)}
          className="btn-secondary text-xs"
        >
          <Download size={13} /> Export
        </button>
      </div>

      <TabBar
        tabs={[
          { id: 'dept', label: 'By Department', icon: Award },
          { id: 'faculty', label: 'By Faculty (CO Attainment)', icon: UserCog },
        ]}
        active={tab}
        onChange={setTab}
      />

      {/* ══════════════════ DEPARTMENT VIEW ══════════════════ */}
      {tab === 'dept' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {[
              { icon: Award, val: `${avgResult}%`, label: 'Avg Result %', c: 'bg-primary-50 border-primary-100 text-primary-600' },
              { icon: TrendingUp, val: avgSGPA, label: 'Avg SGPA', c: 'bg-success-50 border-success-100 text-success-600' },
              { icon: AlertTriangle, val: totalBacklog, label: 'Total Backlogs', c: 'bg-warning-50 border-warning-100 text-warning-600' },
              { icon: Users, val: totalStudents, label: 'Students Evaluated', c: 'bg-danger-50 border-danger-100 text-danger-600' },
            ].map(k => {
              const Icon = k.icon;
              return (
                <div key={k.label} className="kpi-card">
                  <div className={`p-2.5 rounded-xl border w-fit ${k.c}`}><Icon size={20} /></div>
                  <p className="text-2xl font-bold text-surface-900">{k.val}</p>
                  <p className="text-sm font-medium text-surface-600">{k.label}</p>
                </div>
              );
            })}
          </div>

          {deptMetrics.length === 0 ? (
            <div className="card p-12 text-center">
              <Award size={40} className="mx-auto text-surface-300 mb-3" />
              <p className="text-sm font-semibold text-surface-500">No results data available yet.</p>
              <p className="text-xs text-surface-400 mt-1">Data appears once exam results are recorded (e.g. via meeting ingestion).</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                <div className="card p-5">
                  <h3 className="section-title text-base mb-4">Department Result Comparison</h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={deptMetrics} barGap={4}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="dept" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} unit="%" />
                      <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={v => [`${v}%`]} />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      <Bar dataKey="result" name="Result %" radius={[4, 4, 0, 0]} fill="#3b82f6" />
                      <Bar dataKey="co_attainment" name="CO Attainment %" radius={[4, 4, 0, 0]} fill="#22c55e" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="card p-5">
                  <h3 className="section-title text-base mb-4">CO Attainment by Department</h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={deptMetrics}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="dept" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} unit="%" />
                      <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px' }} formatter={v => [`${v}%`]} />
                      <Bar dataKey="co_attainment" name="CO Attainment %" radius={[4, 4, 0, 0]}>
                        {deptMetrics.map((e, i) => <Cell key={i} fill={e.co_attainment >= 70 ? '#22c55e' : e.co_attainment >= 55 ? '#f59e0b' : '#ef4444'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="card p-5 mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-title text-base">Department-wise Performance Details</h3>
                  <select value={selectedDept} onChange={e => setSelectedDept(e.target.value)} className="text-sm w-auto">
                    <option value="all">All Departments</option>
                    {deptMetrics.map(d => <option key={d.dept} value={d.dept}>{d.dept}</option>)}
                  </select>
                </div>
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead>
                      <tr><th>Department</th><th>Students</th><th>Result %</th><th>SGPA</th><th>Backlogs</th><th>CO Attainment</th></tr>
                    </thead>
                    <tbody>
                      {data.map(dept => (
                        <tr key={dept.dept}>
                          <td>
                            <p className="font-semibold text-surface-900">{dept.dept}</p>
                            <p className="text-xs text-surface-400">{dept.fullName}</p>
                          </td>
                          <td className="text-surface-600">{dept.students}</td>
                          <td>
                            <div className={`inline-flex items-center px-2.5 py-1 rounded-lg text-sm font-semibold border ${getBg(dept.result)}`}>
                              <span className={getColor(dept.result)}>{dept.result}%</span>
                            </div>
                          </td>
                          <td className={`font-semibold ${getColor(dept.sgpa * 10)}`}>{dept.sgpa}</td>
                          <td>
                            <span className={`font-semibold ${dept.backlog > 20 ? 'text-danger-600' : dept.backlog > 10 ? 'text-warning-600' : 'text-success-600'}`}>{dept.backlog}</span>
                            {dept.backlog > 0 && <Link to="/academics/weak-students" className="ml-2 text-xs text-primary-600 hover:underline">View →</Link>}
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <div className="progress w-16"><div className={`progress-bar ${attBar(dept.co_attainment)}`} style={{ width: `${dept.co_attainment}%` }} /></div>
                              <span className="text-xs font-semibold">{dept.co_attainment}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ══════════════════ FACULTY VIEW ══════════════════ */}
      {tab === 'faculty' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {[
              { icon: UserCog, val: assigned.length, label: 'Faculty Mapped', c: 'bg-primary-50 border-primary-100 text-primary-600' },
              { icon: BookOpen, val: subjects.length, label: 'Subjects', c: 'bg-violet-50 border-violet-100 text-violet-600' },
              { icon: TrendingUp, val: avgMid == null ? '—' : `${avgMid}%`, label: 'Avg Mid-Sem CO', c: 'bg-warning-50 border-warning-100 text-warning-600' },
              { icon: Award, val: avgEnd == null ? '—' : `${avgEnd}%`, label: 'Avg End-Sem CO', c: 'bg-success-50 border-success-100 text-success-600' },
            ].map(k => {
              const Icon = k.icon;
              return (
                <div key={k.label} className="kpi-card">
                  <div className={`p-2.5 rounded-xl border w-fit ${k.c}`}><Icon size={20} /></div>
                  <p className="text-2xl font-bold text-surface-900">{k.val}</p>
                  <p className="text-sm font-medium text-surface-600">{k.label}</p>
                </div>
              );
            })}
          </div>

          {fpLoading ? (
            <div className="card p-12 flex justify-center"><Spinner size={32} /></div>
          ) : (
            <div className="card p-5 mb-8">
              <h3 className="section-title text-base mb-1">Faculty-wise CO Attainment</h3>
              <p className="text-xs text-surface-400 mb-4">Attainment = share of students scoring ≥ {CO_TARGET}% in the faculty's subjects (mid-term &amp; end-semester).</p>
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr><th>Faculty</th><th>Dept</th><th>Subjects</th><th>Mid-Sem CO</th><th>End-Sem CO</th><th>Overall</th></tr>
                  </thead>
                  <tbody>
                    {facultyMetrics.length === 0 && (
                      <tr><td colSpan={6} className="text-center py-10 text-surface-400">No subjects found. Add subjects and assign faculty below.</td></tr>
                    )}
                    {facultyMetrics.map(f => (
                      <tr key={f.id} className={f.id === '__unassigned__' ? 'bg-surface-50/40' : ''}>
                        <td className="font-semibold text-surface-800">{f.name}</td>
                        <td className="text-surface-600 text-sm">{f.dept}</td>
                        <td className="text-surface-600 text-sm">{f.subjectCount}</td>
                        <td className={`font-semibold ${attColor(f.midAtt)}`}>{f.midAtt == null ? '—' : `${f.midAtt}%`}</td>
                        <td className={`font-semibold ${attColor(f.endAtt)}`}>{f.endAtt == null ? '—' : `${f.endAtt}%`}</td>
                        <td>
                          {f.overall == null ? <span className="text-surface-400">—</span> : (
                            <div className="flex items-center gap-2">
                              <div className="progress w-16"><div className={`progress-bar ${attBar(f.overall)}`} style={{ width: `${f.overall}%` }} /></div>
                              <span className={`text-xs font-bold ${attColor(f.overall)}`}>{f.overall}%</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Faculty → Subject assignment (admins) */}
          {canApprove && (
            <div className="card p-5">
              <h3 className="section-title text-base mb-1">Assign Faculty to Subjects</h3>
              <p className="text-xs text-surface-400 mb-4">Map each subject to its teaching faculty so CO attainment rolls up correctly.</p>
              {subjects.length === 0 ? (
                <p className="text-sm text-surface-400 text-center py-6">No subjects found in the system yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table-base">
                    <thead><tr><th>Subject</th><th>Code</th><th>Sem</th><th>Dept</th><th>Faculty</th></tr></thead>
                    <tbody>
                      {subjects.map(s => (
                        <tr key={s.id}>
                          <td className="font-medium text-surface-800">{s.subject_name}</td>
                          <td className="text-surface-500 text-xs font-mono">{s.subject_code}</td>
                          <td className="text-surface-600 text-sm">{s.semester}</td>
                          <td className="text-surface-600 text-sm">{s.department?.code || '—'}</td>
                          <td>
                            <select
                              value={s.faculty_id || ''}
                              onChange={e => handleAssign(s.id, e.target.value || null)}
                              className="text-xs w-auto min-w-[180px]"
                            >
                              <option value="">— Unassigned —</option>
                              {teachers.map(t => (
                                <option key={t.id} value={t.id}>
                                  {t.full_name}{t.department?.code ? ` (${t.department.code})` : ''}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
