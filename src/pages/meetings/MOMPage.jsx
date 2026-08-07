import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Download, Printer, Save, Sparkles, Edit3, X, Users, UserPlus, UserMinus, RefreshCw, FileText, CheckCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useMeeting, useMOM, useUpsertMOM, useAgendaSubmissions, useDepartments } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { compileMeetingData, synthesizeOfficialMOM } from '../../lib/ai';
import { buildOfficialMOM, isOfficialMOM, attendeeFromUser, ordinal, formatLongDate } from '../../lib/momFormat';
import { downloadOfficialMomPdf } from '../../lib/momPdf';
import { Spinner } from '../../components/ui/index';

export default function MOMPage() {
  const { id } = useParams();
  const { user, profile, canManageMeetings } = useAuth();
  const { data: meeting, isLoading: meetingLoading } = useMeeting(id);
  const { data: momRow, isLoading: momLoading } = useMOM(id);
  const { data: submissions = [] } = useAgendaSubmissions(id);
  const { data: departments = [] } = useDepartments();
  const upsertMOM = useUpsertMOM();

  const [mom, setMom] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expectedMembers, setExpectedMembers] = useState([]);
  const [newName, setNewName] = useState('');
  const [newDesig, setNewDesig] = useState('');

  // Load existing official MOM
  useEffect(() => {
    if (momRow && isOfficialMOM(momRow)) setMom(momRow.mom_content);
  }, [momRow]);

  // Pool of expected members for seeding attendance if none was captured live
  useEffect(() => {
    supabase
      .from('users')
      .select('id, full_name, role, designation, department:departments(id, code, name)')
      .in('role', ['principal', 'director', 'hod', 'tpo', 'exam_cell', 'accounts'])
      .eq('is_active', true)
      .then(({ data }) => setExpectedMembers(data || []));
  }, []);

  const generate = async () => {
    if (!meeting) return;
    setGenerating(true);
    try {
      const compiledText = compileMeetingData(submissions, departments);
      const deptCodes = [...new Set(submissions.map(s => s.department?.code).filter(Boolean))];
      const narrative = await synthesizeOfficialMOM({
        meeting,
        agendaItems: meeting.agenda_items || [],
        compiledText,
        notesInput: safeParseNotes(meeting.live_notes),
        deptCodes,
      });
      const attendance = (Array.isArray(meeting.attendance) && meeting.attendance.length)
        ? meeting.attendance
        : expectedMembers.map(u => attendeeFromUser(u, { present: true }));
      const chairperson = expectedMembers.find(u => u.role === 'principal')
        || expectedMembers.find(u => u.role === 'director') || null;
      const built = buildOfficialMOM({ meeting, narrative, attendance, chairperson, preparedBy: profile });
      setMom(built);
      await upsertMOM.mutateAsync({
        meetingId: id,
        payload: { mom_content: built, attendees: attendance, created_by: user?.id },
      });
      toast.success('Official MOM generated');
    } catch (err) {
      toast.error(err.message || 'Failed to generate MOM');
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    if (!mom) return;
    setSaving(true);
    try {
      await upsertMOM.mutateAsync({
        meetingId: id,
        payload: { mom_content: mom, attendees: buildRoster(mom), created_by: user?.id },
      });
      setEditMode(false);
      toast.success('MOM saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save MOM');
    } finally {
      setSaving(false);
    }
  };

  if (meetingLoading || momLoading) {
    return <div className="page-wrapper"><div className="skeleton h-10 w-1/2 rounded mb-4" /><div className="skeleton h-96 rounded" /></div>;
  }

  return (
    <div className="page-wrapper max-w-4xl mx-auto">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-6 print:hidden">
        <Link to={`/meetings/agendas/${id}`} className="btn-ghost p-2"><ArrowLeft size={18} /></Link>
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-surface-900">Minutes of Meeting</h1>
          {meeting && <p className="text-sm text-surface-500 truncate">{meeting.agenda_title} · {formatLongDate(meeting.meeting_date)}</p>}
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {mom && (
            <>
              <button onClick={() => window.print()} className="btn-secondary text-sm"><Printer size={14} /> Print</button>
              <button onClick={() => downloadOfficialMomPdf(mom, meeting?.agenda_title)} className="btn-secondary text-sm"><Download size={14} /> PDF</button>
            </>
          )}
          {canManageMeetings && mom && !editMode && (
            <button onClick={() => setEditMode(true)} className="btn-secondary text-sm"><Edit3 size={14} /> Edit</button>
          )}
          {canManageMeetings && mom && (
            <button onClick={generate} disabled={generating} className="btn-secondary text-sm" title="Re-run AI synthesis">
              <RefreshCw size={14} className={generating ? 'animate-spin' : ''} /> Regenerate
            </button>
          )}
          {canManageMeetings && editMode && (
            <button onClick={save} disabled={saving} className="btn-primary text-sm">
              {saving ? <Spinner size={14} className="border-t-white border-white/30" /> : <Save size={14} />} Save
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {!mom && (
        <div className="card p-12 text-center">
          <FileText size={40} className="mx-auto text-surface-300 mb-3" />
          <h3 className="text-surface-700 font-semibold">No Minutes prepared yet</h3>
          <p className="text-surface-400 text-sm mt-1 max-w-md mx-auto">
            {canManageMeetings
              ? 'Generate the official RNGPIT-format Minutes of Meeting from the agenda, the data submitted by departments, and the notes taken during the meeting.'
              : 'The Minutes of Meeting for this session have not been published yet.'}
          </p>
          {canManageMeetings && (
            <button onClick={generate} disabled={generating} className="btn-primary text-sm mx-auto mt-5">
              {generating ? <Spinner size={14} className="border-t-white border-white/30" /> : <Sparkles size={14} />}
              Generate Official MOM
            </button>
          )}
        </div>
      )}

      {/* The MOM document */}
      {mom && (
        <div className="card p-8 bg-white text-slate-900 font-serif leading-relaxed print:shadow-none" id="mom-doc">
          {editMode ? <MomEditor mom={mom} setMom={setMom} newName={newName} setNewName={setNewName} newDesig={newDesig} setNewDesig={setNewDesig} />
                    : <MomView mom={mom} />}
        </div>
      )}
    </div>
  );
}

// ── Read-only document view ──────────────────────────────────────────────────
function MomView({ mom }) {
  return (
    <>
      <div className="flex justify-between items-start text-sm mb-5">
        <p><b>Ref. No.:</b> {mom.refNo}</p>
        <p><b>Date:</b> {formatLongDate(mom.date)}</p>
      </div>

      <p className="text-sm mb-3">
        <b>Present Members:</b> The following members were present in the {ordinal(mom.meetingNo || 1)} {mom.meetingType} meeting held on {formatLongDate(mom.date)}.
      </p>

      {mom.presentInPerson?.length > 0 && <AttTable rows={mom.presentInPerson} />}
      {mom.presentOnline?.length > 0 && (
        <>
          <p className="text-sm font-semibold mt-4 mb-2">Following members were present through the AGHMS live platform (Online Mode):</p>
          <AttTable rows={mom.presentOnline} />
        </>
      )}
      {mom.absentees?.length > 0 && (
        <div className="mt-4 text-sm">
          <p className="font-semibold mb-1">Absent:</p>
          <ul className="list-disc pl-6 space-y-0.5 text-slate-700">
            {mom.absentees.map((a, i) => <li key={i}>{a.name}{a.note ? `, ${a.note}` : ''} — was absent.</li>)}
          </ul>
        </div>
      )}

      {mom.openingParagraph && <p className="text-sm mt-5 mb-4">{mom.openingParagraph}</p>}

      {/* Agenda table */}
      <div className="border border-slate-400 mt-2">
        <div className="grid grid-cols-[70px_1fr] bg-slate-100 border-b border-slate-400 text-sm font-bold text-center">
          <div className="p-2 border-r border-slate-400">Agenda No.</div>
          <div className="p-2">Discussions</div>
        </div>
        {(mom.agenda || []).map((item, i) => (
          <div key={i} className="grid grid-cols-[70px_1fr] border-b border-slate-400 text-sm">
            <div className="p-2 border-r border-slate-400 text-center font-bold">{item.no}</div>
            <div className="p-3">
              <p className="font-bold mb-1">{item.title}</p>
              {item.discussion?.length > 0 && (
                <>
                  <p className="font-semibold mt-1">Discussion:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-slate-700">{item.discussion.map((d, j) => <li key={j}>{d}</li>)}</ul>
                </>
              )}
              {item.resolutions?.length > 0 && (
                <>
                  <p className="font-semibold mt-2">Resolutions:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-slate-700">{item.resolutions.map((r, j) => <li key={j}>{r}</li>)}</ul>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {mom.concludingNote && <p className="text-sm mt-5">{mom.concludingNote}</p>}

      {/* Signature block */}
      <div className="grid grid-cols-2 border border-slate-400 mt-8 text-sm">
        <div className="p-3 border-r border-slate-400">
          <p className="font-bold mb-10">Prepared By:</p>
          <p className="font-bold">{mom.preparedBy?.name}</p>
          <p className="text-slate-600">{mom.preparedBy?.designation}</p>
        </div>
        <div className="p-3">
          <p className="font-bold mb-10">Approved By:</p>
          <p className="font-bold">{mom.approvedBy?.name}</p>
          <p className="text-slate-600">{mom.approvedBy?.designation}</p>
        </div>
      </div>

      {/* Department action briefs (extra, not part of the formal MOM) */}
      {mom.departmentBriefs && Object.keys(mom.departmentBriefs).length > 0 && (
        <div className="mt-8 pt-5 border-t border-slate-200 print:hidden">
          <p className="font-bold text-sm mb-2 flex items-center gap-1.5"><CheckCircle size={14} className="text-emerald-600" /> Department Action Points</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {Object.entries(mom.departmentBriefs).map(([dept, text]) => (
              <div key={dept} className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <p className="text-xs font-bold text-primary-700 mb-1">{dept}</p>
                <p className="text-xs text-slate-600 whitespace-pre-wrap font-sans">{String(text)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function AttTable({ rows }) {
  return (
    <table className="w-full border border-slate-400 text-sm border-collapse">
      <thead>
        <tr className="bg-slate-100">
          <th className="border border-slate-400 p-1.5 w-14">Sr. No.</th>
          <th className="border border-slate-400 p-1.5 text-left w-2/5">Name</th>
          <th className="border border-slate-400 p-1.5 text-left">Designation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m, i) => (
          <tr key={i}>
            <td className="border border-slate-400 p-1.5 text-center">{m.sr}</td>
            <td className="border border-slate-400 p-1.5">{m.name}</td>
            <td className="border border-slate-400 p-1.5">{m.designation}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Editor ────────────────────────────────────────────────────────────────────
function MomEditor({ mom, setMom, newName, setNewName, newDesig, setNewDesig }) {
  const set = (patch) => setMom(m => ({ ...m, ...patch }));
  const roster = buildRoster(mom);

  const setRoster = (next) => {
    const present = next.filter(r => r.present);
    setMom(m => ({
      ...m,
      presentInPerson: present.filter(r => r.mode === 'in_person').map((r, i) => ({ sr: i + 1, name: r.full_name, designation: r.designation })),
      presentOnline: present.filter(r => r.mode !== 'in_person').map((r, i) => ({ sr: i + 1, name: r.full_name, designation: r.designation })),
      absentees: next.filter(r => !r.present).map(r => ({ name: r.full_name, note: r.designation })),
      _roster: next,
    }));
  };
  const toggle = (i) => setRoster(roster.map((r, j) => j === i ? { ...r, present: !r.present } : r));
  const mode = (i, v) => setRoster(roster.map((r, j) => j === i ? { ...r, mode: v } : r));
  const remove = (i) => setRoster(roster.filter((_, j) => j !== i));
  const add = () => {
    if (!newName.trim()) return;
    setRoster([...roster, { full_name: newName.trim(), designation: newDesig.trim() || 'Member', present: true, mode: 'in_person', source: 'manual' }]);
    setNewName(''); setNewDesig('');
  };

  const updAgenda = (idx, field, value) => {
    setMom(m => ({ ...m, agenda: m.agenda.map((a, i) => i === idx ? { ...a, [field]: value } : a) }));
  };
  const updAgendaLines = (idx, field, text) => updAgenda(idx, field, text.split('\n').map(s => s.replace(/^[-•]\s*/, '').trim()).filter(Boolean));
  const addAgenda = () => setMom(m => ({ ...m, agenda: [...(m.agenda || []), { no: (m.agenda?.length || 0) + 1, title: '', discussion: [], resolutions: [] }] }));
  const removeAgenda = (idx) => setMom(m => ({ ...m, agenda: m.agenda.filter((_, i) => i !== idx).map((a, i) => ({ ...a, no: i + 1 })) }));

  return (
    <div className="font-sans space-y-6">
      {/* Header config */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Reference Number"><input value={mom.refNo || ''} onChange={e => set({ refNo: e.target.value })} className="text-sm" /></Field>
        <Field label="Meeting Type (e.g. Academic Council / HOD)"><input value={mom.meetingType || ''} onChange={e => set({ meetingType: e.target.value })} className="text-sm" /></Field>
        <Field label="Meeting Number"><input type="number" value={mom.meetingNo || 1} onChange={e => set({ meetingNo: Number(e.target.value) })} className="text-sm" /></Field>
        <Field label="Chairperson"><input value={mom.chairperson || ''} onChange={e => set({ chairperson: e.target.value, approvedBy: { ...mom.approvedBy, name: e.target.value } })} className="text-sm" /></Field>
      </div>

      {/* Attendance editor */}
      <div>
        <h3 className="text-sm font-bold text-surface-800 flex items-center gap-2 mb-2"><Users size={15} className="text-emerald-600" /> Attendance</h3>
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
          {roster.map((r, i) => (
            <div key={i} className={`flex items-center gap-2 p-2 rounded-lg border ${r.present ? 'border-emerald-200 bg-emerald-50/40' : 'border-surface-200 bg-surface-50 opacity-70'}`}>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-surface-800 truncate">{r.full_name}</p>
                <p className="text-[10px] text-surface-400 truncate">{r.designation}</p>
              </div>
              <select value={r.mode} onChange={e => mode(i, e.target.value)} className="text-[10px] py-1 px-1.5 rounded-md">
                <option value="online">Online</option>
                <option value="in_person">In-person</option>
              </select>
              <button onClick={() => toggle(i)} className={`text-[10px] font-bold px-2 py-1 rounded-md ${r.present ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-200 text-surface-500'}`}>{r.present ? 'Present' : 'Absent'}</button>
              <button onClick={() => remove(i)} className="text-surface-300 hover:text-danger-500"><UserMinus size={13} /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Add member name" className="flex-1 text-xs py-1.5" />
          <input value={newDesig} onChange={e => setNewDesig(e.target.value)} placeholder="Designation" className="w-40 text-xs py-1.5" />
          <button onClick={add} className="btn-secondary text-xs"><UserPlus size={13} /> Add</button>
        </div>
      </div>

      {/* Opening */}
      <Field label="Opening Paragraph">
        <textarea rows={3} value={mom.openingParagraph || ''} onChange={e => set({ openingParagraph: e.target.value })} className="text-sm" />
      </Field>

      {/* Agenda editor */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-surface-800">Agenda &amp; Resolutions</h3>
          <button onClick={addAgenda} className="btn-secondary text-xs"><FileText size={12} /> Add Item</button>
        </div>
        <div className="space-y-3">
          {(mom.agenda || []).map((item, idx) => (
            <div key={idx} className="border border-surface-200 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-bold text-primary-600">#{item.no}</span>
                <input value={item.title} onChange={e => updAgenda(idx, 'title', e.target.value)} placeholder="Agenda title" className="flex-1 text-sm font-semibold" />
                <button onClick={() => removeAgenda(idx)} className="text-surface-300 hover:text-danger-500"><X size={14} /></button>
              </div>
              <Field label="Discussion (one point per line)">
                <textarea rows={2} value={(item.discussion || []).join('\n')} onChange={e => updAgendaLines(idx, 'discussion', e.target.value)} className="text-xs" />
              </Field>
              <div className="h-2" />
              <Field label="Resolutions (one point per line)">
                <textarea rows={2} value={(item.resolutions || []).join('\n')} onChange={e => updAgendaLines(idx, 'resolutions', e.target.value)} className="text-xs" />
              </Field>
            </div>
          ))}
        </div>
      </div>

      {/* Concluding */}
      <Field label="Concluding Note">
        <textarea rows={2} value={mom.concludingNote || ''} onChange={e => set({ concludingNote: e.target.value })} className="text-sm" />
      </Field>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-surface-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────
function safeParseNotes(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { if (raw.trim().startsWith('{')) return JSON.parse(raw); } catch { /* ignore */ }
  return { admin: raw };
}

// Reconstruct an editable roster from the split present/absent lists (used by the editor).
function buildRoster(mom) {
  if (Array.isArray(mom._roster)) return mom._roster;
  const rows = [];
  (mom.presentInPerson || []).forEach(m => rows.push({ full_name: m.name, designation: m.designation, present: true, mode: 'in_person' }));
  (mom.presentOnline || []).forEach(m => rows.push({ full_name: m.name, designation: m.designation, present: true, mode: 'online' }));
  (mom.absentees || []).forEach(m => rows.push({ full_name: m.name, designation: m.note, present: false, mode: 'online' }));
  return rows;
}
