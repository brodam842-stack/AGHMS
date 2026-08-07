import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Square, Send, Bot, FileText, Download, Check, AlertTriangle, Sparkles, RefreshCw, BarChart2, CheckCircle2, Edit2, Loader2, Users, UserPlus, UserMinus, Wifi } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../../lib/supabase';
import { useMeeting, useAgendaSubmissions, useDepartments, useUpsertMOM } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { compileMeetingData, generateLiveDashboard, askMeetingChatbot, synthesizeOfficialMOM } from '../../lib/ai';
import { buildOfficialMOM, attendeeFromUser, mergePresence } from '../../lib/momFormat';
import { downloadOfficialMomPdf } from '../../lib/momPdf';
import { meetingsService } from '../../lib/services';
import { runAutomatedDataIngestion } from '../../lib/ingestion';
import { emailService } from '../../lib/emailService';
import { Spinner, Modal, DateInput } from '../../components/ui/index';
import Markdown from '../../components/ui/Markdown';
import { formatDMY, formatCellValue } from '../../lib/dateFormat';
import { SEMESTER_BATCHES } from '../../lib/constants';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

export default function MeetingWorkspacePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, role, profile } = useAuth();
  
  const { data: meeting, isLoading: loadingMeeting } = useMeeting(id);
  const { data: submissions = [] } = useAgendaSubmissions(id);
  const { data: departments = [] } = useDepartments();
  const upsertMOM = useUpsertMOM();

  // ── Live attendance (presence-driven) ──────────────────────────────────────
  const [attendance, setAttendance] = useState([]);      // roster of members
  const [expectedMembers, setExpectedMembers] = useState([]); // seed pool
  const [presenceMembers, setPresenceMembers] = useState([]); // currently connected
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberDesig, setNewMemberDesig] = useState('');
  const attendanceRef = useRef([]);
  useEffect(() => { attendanceRef.current = attendance; }, [attendance]);

  // State variables
  const [localSubmissions, setLocalSubmissions] = useState([]);
  const [activeTab, setActiveTab] = useState('');
  // ── Notes: isolated JSON object { admin: '...', CSE: '...', MECH: '...' } ────
  // Parse live_notes string from DB into object
  const parseNotesObject = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      if (raw.trim().startsWith('{')) return JSON.parse(raw);
    } catch { /* not JSON — fall through to the legacy shape below */ }
    // Legacy fallback: treat raw text as admin note
    return { admin: raw };
  };

  const [notesObj, setNotesObj] = useState({});
  const [notesViewTab, setNotesViewTab] = useState('mine'); // 'mine' | dept-code for admin viewing HOD notes
  const [isTypingNotes, setIsTypingNotes] = useState(false);
  const [chatQuestion, setChatQuestion] = useState('');
  const [chatHistory, setChatHistory] = useState([
    { role: 'assistant', content: 'Hello! I am your AI Meeting Copilot. I have analyzed all uploaded spreadsheets for this meeting. Ask me anything about the data (e.g. "which department has the highest pending fees?" or "what are the weak students counts?").' }
  ]);
  const [isThinkingChat, setIsThinkingChat] = useState(false);
  const [aiDashboard, setAiDashboard] = useState(null);
  const [isReanalyzingDashboard, setIsReanalyzingDashboard] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [isEndingMeeting, setIsEndingMeeting] = useState(false);
  const [concludedSummary, setConcludedSummary] = useState(null);
  
  // Spreadsheet Editing State
  const [editingCell, setEditingCell] = useState(null); // { subId, rowIndex, colName }
  const [editingValue, setEditingValue] = useState('');

  const typingTimeoutRef = useRef(null);
  const realtimeChannelRef = useRef(null);

  const isAdminOrPrincipal = ['admin', 'principal', 'director'].includes(role);

  // Sync loaded submissions to local editable state
  useEffect(() => {
    if (submissions && submissions.length > 0) {
      setLocalSubmissions(submissions);
      if (!activeTab) {
        setActiveTab(submissions[0].id);
      }
    }
  }, [submissions]);

  // Load live notes and dashboard from meeting record
  useEffect(() => {
    if (meeting) {
      if (meeting.live_notes) {
        setNotesObj(parseNotesObject(meeting.live_notes));
      }
      if (meeting.ai_summary?.dashboard) {
        setAiDashboard(meeting.ai_summary.dashboard);
      }
    }
  }, [meeting]);

  // Fetch the pool of expected council members (governance roles) to seed the
  // attendance roster with everyone who *should* attend (absentees show up too).
  useEffect(() => {
    supabase
      .from('users')
      .select('id, full_name, role, designation, department:departments(id, code, name)')
      .in('role', ['principal', 'director', 'hod', 'tpo', 'exam_cell', 'accounts'])
      .eq('is_active', true)
      .then(({ data }) => setExpectedMembers(data || []));
  }, []);

  // Seed the roster and union in every expected council member (so members who
  // never join still appear as absentees). Runs idempotently as data loads.
  useEffect(() => {
    if (!meeting) return;
    const saved = Array.isArray(meeting.attendance) ? meeting.attendance : [];
    setAttendance(prev => {
      const base = prev.length ? prev : saved;
      if (!expectedMembers.length) return base;
      const known = new Set(base.map(r => r.user_id));
      const additions = expectedMembers.filter(u => !known.has(u.id)).map(u => attendeeFromUser(u));
      return additions.length ? [...base, ...additions] : base;
    });
  }, [meeting, expectedMembers]);

  // Merge live presence into the roster: anyone connected is marked present/online.
  // Present users missing from the roster (e.g. faculty) are added on the fly.
  useEffect(() => {
    if (!presenceMembers.length) return;
    const nowIso = new Date().toISOString();
    setAttendance(prev => {
      let next = mergePresence(prev, presenceMembers.map(p => p.user_id), nowIso);
      const known = new Set(next.map(r => r.user_id));
      presenceMembers.forEach(p => {
        if (p.user_id && !known.has(p.user_id)) {
          next = [...next, attendeeFromUser(
            { id: p.user_id, full_name: p.full_name, role: p.role, department: { code: p.dept_code, name: p.dept_name } },
            { present: true, joined_at: nowIso }
          )];
          known.add(p.user_id);
        }
      });
      return next;
    });
  }, [presenceMembers]);

  // Persist the roster (admin/principal owns the write to avoid multi-writer races).
  useEffect(() => {
    if (!isAdminOrPrincipal || !meeting || attendance.length === 0) return;
    const t = setTimeout(() => { meetingsService.saveAttendance(id, attendance).catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [attendance, isAdminOrPrincipal, meeting, id]);

  // Attendance roster editing helpers
  const togglePresent = (uid) => setAttendance(prev => prev.map(a => a.user_id === uid ? { ...a, present: !a.present } : a));
  const setMode = (uid, mode) => setAttendance(prev => prev.map(a => a.user_id === uid ? { ...a, mode } : a));
  const removeMember = (uid) => setAttendance(prev => prev.filter(a => a.user_id !== uid));
  const addInPersonMember = () => {
    const name = newMemberName.trim();
    if (!name) return;
    setAttendance(prev => [...prev, {
      user_id: `manual-${Date.now()}`,
      full_name: name,
      role: 'member',
      department_code: null,
      department_name: null,
      designation: newMemberDesig.trim() || 'Member',
      mode: 'in_person',
      present: true,
      joined_at: new Date().toISOString(),
      source: 'manual',
    }]);
    setNewMemberName(''); setNewMemberDesig('');
  };
  const presentCount = attendance.filter(a => a.present).length;

  // Supabase Realtime Channel Configuration
  useEffect(() => {
    if (!id) return;

    // Connect to meeting workspace channel (with presence for live attendance)
    const channelName = `meeting_workspace_${id}`;
    const channel = supabase.channel(channelName, { config: { presence: { key: user.id } } });
    realtimeChannelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const members = Object.values(state).flat()
          .filter(p => p.user_id)
          .map(p => ({ user_id: p.user_id, full_name: p.full_name, role: p.role, dept_code: p.dept_code, dept_name: p.dept_name }));
        // de-dupe by user_id
        const seen = new Set();
        setPresenceMembers(members.filter(m => (seen.has(m.user_id) ? false : seen.add(m.user_id))));
      })
      .on('broadcast', { event: 'notes_update' }, (payload) => {
        if (payload.payload.senderId !== user.id) {
          const { noteKey, notes } = payload.payload;
          setNotesObj(prev => ({ ...prev, [noteKey]: notes }));
        }
      })
      .on('broadcast', { event: 'cell_update' }, (payload) => {
        const { subId, rowIndex, colName, value } = payload.payload;
        setLocalSubmissions(prev => prev.map(sub => {
          if (sub.id === subId) {
            const updatedData = [...sub.submitted_data];
            updatedData[rowIndex] = { ...updatedData[rowIndex], [colName]: value };
            return { ...sub, submitted_data: updatedData };
          }
          return sub;
        }));
      })
      .on('broadcast', { event: 'meeting_ended' }, () => {
        toast.success('This meeting has been concluded by the administrator!');
        navigate(`/meetings/agendas/${id}`);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // Announce my presence so I'm counted in live attendance.
          await channel.track({
            user_id: user.id,
            full_name: profile?.full_name,
            role,
            dept_code: profile?.department?.code || null,
            dept_name: profile?.department?.name || null,
          });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, user.id, navigate, profile?.full_name, profile?.department?.code, role]);

  // Debounced database sync helper for notepad
  const syncNotesToDatabase = useCallback(async (updatedObj) => {
    try {
      await supabase
        .from('meetings')
        .update({ live_notes: JSON.stringify(updatedObj) })
        .eq('id', id);
    } catch (err) {
      console.error('Failed to autosave notes:', err);
    }
  }, [id]);

  const saveNotesDebounced = useRef(
    debounce((updatedObj) => {
      syncNotesToDatabase(updatedObj);
    }, 1500)
  ).current;

  // Determine the note key for the current user
  const myNoteKey = isAdminOrPrincipal ? 'admin' : (profile?.department?.code || role || 'unknown');

  // Handle local notes typing and broadcast
  const handleNotesChange = (e) => {
    const value = e.target.value;
    const updated = { ...notesObj, [myNoteKey]: value };
    setNotesObj(updated);
    setIsTypingNotes(true);

    // Broadcast only this user's portion
    if (realtimeChannelRef.current) {
      realtimeChannelRef.current.send({
        type: 'broadcast',
        event: 'notes_update',
        payload: { noteKey: myNoteKey, notes: value, senderId: user.id }
      });
    }

    // Debounced save
    saveNotesDebounced(updated);

    // Typing reset timeout
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      setIsTypingNotes(false);
    }, 2000);
  };

  // Debounced database sync for cell changes
  const saveSubmissionToDatabase = useCallback(async (subId, data) => {
    try {
      await supabase
        .from('agenda_submissions')
        .update({ submitted_data: data, updated_at: new Date().toISOString() })
        .eq('id', subId);
    } catch (err) {
      console.error('Failed to autosave cell to database:', err);
    }
  }, []);

  const saveSubmissionDebounced = useRef(
    debounce((subId, data) => {
      saveSubmissionToDatabase(subId, data);
    }, 1000)
  ).current;

  // Cell Editing
  const startEditing = (subId, rowIndex, colName, currentValue) => {
    setEditingCell({ subId, rowIndex, colName });
    setEditingValue(currentValue || '');
  };

  const saveCellEdit = () => {
    if (!editingCell) return;

    const { subId, rowIndex, colName } = editingCell;
    const value = editingValue;

    // Update local state
    let targetSubmission = null;
    setLocalSubmissions(prev => prev.map(sub => {
      if (sub.id === subId) {
        const updatedData = [...sub.submitted_data];
        updatedData[rowIndex] = { ...updatedData[rowIndex], [colName]: value };
        targetSubmission = { ...sub, submitted_data: updatedData };
        
        // Save to database
        saveSubmissionDebounced(subId, updatedData);
        
        return targetSubmission;
      }
      return sub;
    }));

    // Broadcast to other users
    if (realtimeChannelRef.current) {
      realtimeChannelRef.current.send({
        type: 'broadcast',
        event: 'cell_update',
        payload: { subId, rowIndex, colName, value }
      });
    }

    setEditingCell(null);
    toast.success('Cell updated and synced in real-time!', { duration: 1500 });
  };

  // AI Chatbot Interface
  const handleSendChatMessage = async () => {
    if (!chatQuestion.trim()) return;
    const question = chatQuestion;
    setChatQuestion('');

    const newHistory = [...chatHistory, { role: 'user', content: question }];
    setChatHistory(newHistory);
    setIsThinkingChat(true);

    try {
      const compiledText = compileMeetingData(localSubmissions, departments);
      const answer = await askMeetingChatbot(compiledText, chatHistory, question);
      setChatHistory(prev => [...prev, { role: 'assistant', content: answer }]);
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'Failed to get answer from AI copilot');
      setChatHistory(prev => [...prev, { role: 'assistant', content: 'I encountered an error querying the AI gateway. Please try again.' }]);
    } finally {
      setIsThinkingChat(false);
    }
  };

  // Re-run AI analytics dashboard
  const handleReanalyzeDashboard = async () => {
    setIsReanalyzingDashboard(true);
    try {
      const compiledText = compileMeetingData(localSubmissions, departments);
      const dashboard = await generateLiveDashboard(compiledText);
      setAiDashboard(dashboard);

      // Save to meeting table
      const updatedSummary = {
        ...(meeting.ai_summary || {}),
        dashboard
      };
      await supabase
        .from('meetings')
        .update({ ai_summary: updatedSummary })
        .eq('id', id);

      toast.success('AI Meeting Analytics Dashboard updated successfully!');
    } catch (err) {
      console.error(err);
      toast.error(err.message || 'Failed to regenerate dashboard');
    } finally {
      setIsReanalyzingDashboard(false);
    }
  };

  // Conclude Meeting Workflow (Admin Only)
  const handleConcludeMeeting = async () => {
    setIsEndingMeeting(true);
    try {
      const compiledText = compileMeetingData(localSubmissions, departments);
      const finalAttendance = attendanceRef.current;
      const deptCodes = [...new Set(localSubmissions.map(s => s.department?.code).filter(Boolean))];

      // 1. Synthesize the OFFICIAL RNGPIT-format MOM narrative from the real
      //    agenda, the data faculties provided, and the live notes.
      toast.loading('AI is drafting the official Minutes of Meeting...', { id: 'end-meeting' });
      const narrative = await synthesizeOfficialMOM({
        meeting,
        agendaItems: meeting.agenda_items || [],
        compiledText,
        notesInput: notesObj,
        deptCodes,
      });

      // 2. Assemble the full MOM (attendance + header + signatures from real data)
      const chairperson = expectedMembers.find(u => u.role === 'principal')
        || expectedMembers.find(u => u.role === 'director') || null;
      const mom = buildOfficialMOM({
        meeting,
        narrative,
        attendance: finalAttendance,
        chairperson,
        preparedBy: profile,
      });

      // 3. Run post-meeting automated data ingestion
      toast.loading('Auto-ingesting spreadsheet data into academic databases...', { id: 'end-meeting' });
      const ingestionResult = await runAutomatedDataIngestion(meeting, localSubmissions);

      // 4. Persist: meeting status + snapshot, and the MOM row
      const finalSummary = {
        ...(meeting.ai_summary || {}),
        mom,
        departmentBriefs: narrative.departmentBriefs,
        ingestionLogs: ingestionResult.logs,
        recordsIngested: ingestionResult.recordsIngested,
      };
      await supabase
        .from('meetings')
        .update({
          status: 'conducted',
          live_notes: JSON.stringify(notesObj),
          ai_summary: finalSummary,
          attendance: finalAttendance,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);

      await upsertMOM.mutateAsync({
        meetingId: id,
        payload: { mom_content: mom, attendees: finalAttendance, created_by: user.id },
      });

      // 5. Notify HODs of their department directives
      toast.loading('Publishing MOM and notifying HODs...', { id: 'end-meeting' });
      const allBriefsKeys = Object.keys(narrative.departmentBriefs || {});
      if (allBriefsKeys.length > 0) {
        const { data: users = [] } = await supabase
          .from('users')
          .select('id, role, department:departments(code)');
        const notifPayloads = users
          .filter(u => u.department?.code && allBriefsKeys.includes(u.department.code))
          .map(u => ({
            user_id: u.id,
            title: `MOM Published: ${meeting.agenda_title}`,
            message: `The meeting has concluded and the official Minutes of Meeting are available. Review your department's action points in the meeting archive.`,
            read_status: false,
            notification_type: 'meeting',
            priority: 'high',
            action_url: `/meetings/agendas/${id}/mom`,
            created_at: new Date().toISOString(),
          }));
        if (notifPayloads.length > 0) {
          await supabase.from('notifications').insert(notifPayloads);
        }
      }

      // 6. Broadcast to other active clients to close their workspace
      if (realtimeChannelRef.current) {
        realtimeChannelRef.current.send({ type: 'broadcast', event: 'meeting_ended', payload: {} });
      }

      toast.dismiss('end-meeting');
      toast.success('Meeting concluded — official MOM generated and data ingested!');

      // 📧 Emails (fire-and-forget)
      emailService.meetingConcludedAdmin(meeting, `${mom.openingParagraph}\n\n${mom.concludingNote}`);
      emailService.meetingConcludedDeptBriefs(meeting, narrative.departmentBriefs);

      setConcludedSummary({ mom, ingestionResult });
    } catch (err) {
      console.error(err);
      toast.dismiss('end-meeting');
      toast.error(err.message || 'Failed to conclude meeting');
    } finally {
      setIsEndingMeeting(false);
    }
  };

  // PDF Exporter — official RNGPIT MOM format
  const downloadMOMpdf = () => {
    const mom = concludedSummary?.mom || meeting?.ai_summary?.mom;
    if (!mom) return toast.error('No MOM data found to export');
    downloadOfficialMomPdf(mom, meeting.agenda_title);
    toast.success('Official MOM PDF downloaded!');
  };

  if (loadingMeeting) {
    return (
      <div className="page-wrapper min-h-[70vh] flex items-center justify-center">
        <Spinner size={48} />
      </div>
    );
  }

  if (!meeting) {
    return (
      <div className="page-wrapper">
        <div className="alert-danger">Meeting details could not be found or loaded.</div>
      </div>
    );
  }

  const selectedSubmission = localSubmissions.find(s => s.id === activeTab);
  const schemaCols = meeting.agenda_template_id
    ? selectedSubmission?.agenda_template?.format_schema?.columns || []
    : [];

  return (
    <div className="page-wrapper max-w-7xl mx-auto flex flex-col gap-6">
      
      {/* 1. Header Bar */}
      <div className="bg-slate-900 text-white rounded-3xl p-6 shadow-xl relative overflow-hidden flex flex-col md:flex-row md:items-center justify-between gap-6 border border-slate-800">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-indigo-900/40 via-transparent to-transparent pointer-events-none" />
        <div className="relative z-10 flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <span className="bg-indigo-500 text-white text-[10px] uppercase font-bold tracking-widest px-2.5 py-1 rounded-full animate-pulse">
              Live Meeting Workspace
            </span>
            <span className="text-slate-400 text-xs font-semibold">• Real-Time Sync Active</span>
            {meeting.semester_batch && SEMESTER_BATCHES[meeting.semester_batch] && (
              <span className="bg-white/10 text-white text-[10px] font-bold px-2.5 py-1 rounded-full border border-white/15">
                {SEMESTER_BATCHES[meeting.semester_batch].short} · Sem {SEMESTER_BATCHES[meeting.semester_batch].semesters.join(', ')}
              </span>
            )}
          </div>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white mb-1 truncate">{meeting.agenda_title}</h1>
          <p className="text-slate-400 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>Venue: <b>{meeting.venue}</b></span>
            <span>Date: <b>{formatDMY(meeting.meeting_date, '—')}</b></span>
            <span>Time: <b>{meeting.meeting_time || '10:00 AM'}</b></span>
          </p>
        </div>

        <div className="flex items-center gap-3 z-10">
          <Link to={`/meetings/agendas/${id}`} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl transition-all border border-slate-700">
            Exit Workspace
          </Link>
          {isAdminOrPrincipal && (
            <button
              onClick={() => setShowEndModal(true)}
              className="px-5 py-2 bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-600 hover:to-rose-700 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-red-500/20 border border-red-400 flex items-center gap-1.5"
            >
              <Square size={13} fill="white" /> End Meeting
            </button>
          )}
        </div>
      </div>

      {/* 2. Responsive Workspace Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* LEFT COLUMN: Collaborative Pad and Editable Grid (Span 7) */}
        <div className="lg:col-span-7 space-y-6">
          
          {/* A. Collaborative Live Notepad */}
          <div className="card p-6 border border-slate-200 bg-white rounded-3xl relative shadow-md">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-indigo-50 rounded-lg text-indigo-600">
                  <FileText size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">Meeting Notepad</h3>
                  <p className="text-[10px] text-slate-400">
                    {isAdminOrPrincipal ? 'Admin notes — view HOD notes read-only' : 'Your notes — admin notes read-only'}
                  </p>
                </div>
              </div>
              
              {isTypingNotes ? (
                <span className="text-[10px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" /> Saving...
                </span>
              ) : (
                <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-medium">Synced</span>
              )}
            </div>

            {/* Admin: tabs to switch between own notes and each HOD's read-only notes */}
            {isAdminOrPrincipal && (
              <div className="flex flex-wrap gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100 mb-3">
                <button
                  onClick={() => setNotesViewTab('mine')}
                  className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                    notesViewTab === 'mine'
                      ? 'bg-white text-indigo-700 shadow-sm border border-slate-200/50'
                      : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  My Notes (Admin)
                </button>
                {Object.keys(notesObj).filter(k => k !== 'admin').map(deptCode => (
                  <button
                    key={deptCode}
                    onClick={() => setNotesViewTab(deptCode)}
                    className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                      notesViewTab === deptCode
                        ? 'bg-white text-indigo-700 shadow-sm border border-slate-200/50'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {deptCode} (read-only)
                  </button>
                ))}
              </div>
            )}

            {/* HOD: tabs - own notes and read-only admin */}
            {!isAdminOrPrincipal && (
              <div className="flex flex-wrap gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100 mb-3">
                <button
                  onClick={() => setNotesViewTab('mine')}
                  className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                    notesViewTab === 'mine'
                      ? 'bg-white text-indigo-700 shadow-sm border border-slate-200/50'
                      : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  My Notes
                </button>
                {notesObj['admin'] !== undefined && (
                  <button
                    onClick={() => setNotesViewTab('admin')}
                    className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                      notesViewTab === 'admin'
                        ? 'bg-white text-indigo-700 shadow-sm border border-slate-200/50'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    Admin Notes (read-only)
                  </button>
                )}
              </div>
            )}

            {/* Editable textarea for own notes */}
            {notesViewTab === 'mine' ? (
              <textarea
                value={notesObj[myNoteKey] || ''}
                onChange={handleNotesChange}
                placeholder="Take your own meeting notes here. Your notes are private until the meeting ends and AI synthesizes them."
                rows={8}
                className="w-full border-slate-200 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 text-xs leading-relaxed font-normal bg-slate-50/40 rounded-2xl p-4 shadow-inner"
              />
            ) : (
              /* Read-only view of another participant's notes */
              <div className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 min-h-[190px] text-xs leading-relaxed text-slate-600 font-normal overflow-y-auto shadow-inner">
                {notesObj[notesViewTab]
                  ? <pre className="whitespace-pre-wrap font-sans">{notesObj[notesViewTab]}</pre>
                  : <span className="text-slate-400 italic">No notes written yet for this participant.</span>
                }
              </div>
            )}
            <div className="text-[10px] text-slate-400 mt-2 flex items-center gap-1 bg-slate-50 p-2 rounded-xl">
              <Sparkles size={12} className="text-indigo-500" />
              <span>All notes are synthesized by AI into a structured MOM Report when the meeting ends.</span>
            </div>
          </div>

          {/* A2. Live Attendance (presence-driven) */}
          <div className="card p-6 border border-slate-200 bg-white rounded-3xl shadow-md">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-emerald-50 rounded-lg text-emerald-600"><Users size={18} /></span>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">Live Attendance</h3>
                  <p className="text-[10px] text-slate-400">
                    {isAdminOrPrincipal ? 'Auto-tracked from who joins — edit before ending the meeting' : 'Auto-tracked from who joins the live workspace'}
                  </p>
                </div>
              </div>
              <span className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                <Wifi size={10} /> {presentCount}/{attendance.length} present
              </span>
            </div>

            <div className="space-y-1.5 max-h-[280px] overflow-y-auto no-scrollbar pr-1">
              {attendance.length === 0 ? (
                <p className="text-[11px] text-slate-400 text-center py-4">Waiting for members to join the live meeting…</p>
              ) : attendance.map(a => (
                <div key={a.user_id} className={`flex items-center gap-2 p-2 rounded-xl border transition-all ${a.present ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-150 bg-slate-50 opacity-70'}`}>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${a.present ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-slate-800 truncate">{a.full_name}</p>
                    <p className="text-[9px] text-slate-400 truncate">{a.designation}</p>
                  </div>
                  {isAdminOrPrincipal ? (
                    <>
                      <select
                        value={a.mode}
                        onChange={e => setMode(a.user_id, e.target.value)}
                        className="text-[9px] py-0.5 px-1 rounded-md border-slate-200 bg-white text-slate-600"
                      >
                        <option value="online">Online</option>
                        <option value="in_person">In-person</option>
                      </select>
                      <button
                        onClick={() => togglePresent(a.user_id)}
                        className={`text-[9px] font-bold px-2 py-1 rounded-md transition-colors ${a.present ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}
                      >
                        {a.present ? 'Present' : 'Absent'}
                      </button>
                      {a.source === 'manual' && (
                        <button onClick={() => removeMember(a.user_id)} className="text-slate-300 hover:text-red-500" title="Remove"><UserMinus size={12} /></button>
                      )}
                    </>
                  ) : (
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md ${a.present ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
                      {a.present ? (a.mode === 'in_person' ? 'In-person' : 'Online') : 'Absent'}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {isAdminOrPrincipal && (
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
                <input
                  value={newMemberName}
                  onChange={e => setNewMemberName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addInPersonMember()}
                  placeholder="Add in-person member name"
                  className="flex-1 text-[10px] border-slate-200 rounded-lg py-1.5"
                />
                <input
                  value={newMemberDesig}
                  onChange={e => setNewMemberDesig(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addInPersonMember()}
                  placeholder="Designation"
                  className="w-28 text-[10px] border-slate-200 rounded-lg py-1.5"
                />
                <button onClick={addInPersonMember} className="p-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg flex-shrink-0" title="Add member">
                  <UserPlus size={13} />
                </button>
              </div>
            )}
          </div>

          {/* B. Live Spreadsheet Editor */}
          {localSubmissions.length === 0 ? (
            <div className="card p-8 text-center bg-slate-50 border border-slate-150 rounded-3xl shadow-sm">
              <AlertTriangle size={24} className="mx-auto text-amber-500 mb-2" />
              <h4 className="text-xs font-bold text-slate-700">No Spreadsheet Submissions Linked</h4>
              <p className="text-[10px] text-slate-400 mt-1 max-w-sm mx-auto">
                Once departments upload Excel spreadsheets, they will render here as editable real-time synchronized grids.
              </p>
            </div>
          ) : (
            <div className="card p-6 border border-slate-200 bg-white rounded-3xl shadow-md overflow-hidden">

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-3 mb-4">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">Live Operational Data Editor</h3>
                  <p className="text-[10px] text-slate-400">Double-click or click edit icon in any cell to change operational data in real-time</p>
                </div>
                
                {/* Department tabs */}
                <div className="flex flex-wrap gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100">
                  {localSubmissions.map(sub => (
                    <button
                      key={sub.id}
                      onClick={() => setActiveTab(sub.id)}
                      className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                        activeTab === sub.id
                          ? 'bg-white text-indigo-700 shadow-sm border border-slate-200/50'
                          : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {sub.department?.code || 'DEPT'}
                    </button>
                  ))}
                </div>
              </div>

              {selectedSubmission && schemaCols.length > 0 ? (
                <div className="space-y-4">
                  {/* File info banner */}
                  <div className="bg-slate-50 px-4 py-2 border border-slate-100 rounded-xl flex items-center justify-between text-[10px] text-slate-600">
                    <span className="font-mono">Active Sheet: <b>{selectedSubmission.file_name}</b></span>
                    <span>Uploaded by: <b>{selectedSubmission.user?.full_name}</b></span>
                  </div>

                  {/* Grid table */}
                  <div className="overflow-x-auto border border-slate-200 rounded-2xl shadow-inner max-h-[360px] overflow-y-auto no-scrollbar">
                    <table className="w-full text-left text-[11px] border-collapse bg-white">
                      <thead>
                        <tr className="bg-slate-50/80 sticky top-0 border-b border-slate-200 backdrop-blur z-10">
                          <th className="p-2.5 w-10 border-r border-slate-200 text-center font-bold text-slate-400">#</th>
                          {schemaCols.map((c, i) => (
                            <th key={i} className="p-2.5 border-r border-slate-250 font-bold text-slate-700 bg-slate-50 min-w-[120px]">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(selectedSubmission.submitted_data || []).map((row, rIdx) => (
                          <tr key={rIdx} className="border-b border-slate-100 hover:bg-indigo-50/10">
                            <td className="p-2.5 border-r border-slate-200 text-center text-slate-400 font-medium bg-slate-50/20">
                              {rIdx + 1}
                            </td>
                            {schemaCols.map((col, cIdx) => {
                              const isEditing = editingCell?.subId === selectedSubmission.id &&
                                                editingCell?.rowIndex === rIdx &&
                                                editingCell?.colName === col.name;
                              const cellValue = row[col.name] || '';

                              return (
                                <td
                                  key={cIdx}
                                  className="p-1 border-r border-slate-100 text-slate-700 min-w-[120px] transition-all relative group"
                                  onClick={() => !isEditing && startEditing(selectedSubmission.id, rIdx, col.name, cellValue)}
                                >
                                  {isEditing ? (
                                    <div className="flex items-center gap-1 w-full z-20 bg-white">
                                      {col.type === 'date' ? (
                                        <DateInput
                                          value={editingValue}
                                          onChange={setEditingValue}
                                          onCommit={saveCellEdit}
                                          autoFocus
                                        />
                                      ) : (
                                        <input
                                          type="text"
                                          value={editingValue}
                                          onChange={e => setEditingValue(e.target.value)}
                                          onBlur={saveCellEdit}
                                          onKeyDown={e => e.key === 'Enter' && saveCellEdit()}
                                          autoFocus
                                          className="w-full border-1 border-indigo-400 p-1 rounded text-[11px] h-7 focus:ring-0 focus:border-indigo-500"
                                        />
                                      )}
                                      <button onClick={saveCellEdit} className="p-1 text-emerald-600 bg-emerald-50 rounded">
                                        <Check size={11} />
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center justify-between gap-1 w-full min-h-[22px] px-1.5 cursor-text">
                                      <span className="truncate">{formatCellValue(cellValue, col.type) || '—'}</span>
                                      <Edit2 size={10} className="text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity ml-1" />
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400 text-center py-4">Select a department above to view operational data.</p>
              )}
            </div>
          )}

        </div>

        {/* RIGHT COLUMN: AI Copilot and Analytics Dashboard (Span 5) */}
        <div className="lg:col-span-5 space-y-6">
          
          {/* C. Interactive AI Meeting Chatbot */}
          <div className="card p-6 border border-slate-200 bg-white rounded-3xl shadow-md flex flex-col h-[400px]">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-indigo-500/10 rounded-lg text-indigo-600">
                  <Bot size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">AI Meeting Chatbot</h3>
                  <p className="text-[10px] text-slate-400">Contextual answers from uploaded files</p>
                </div>
              </div>
              
              <span className="text-[9px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-semibold">
                OpenRouter AI
              </span>
            </div>

            {/* Chat List */}
            <div className="flex-1 overflow-y-auto pr-1 space-y-3 mb-3 text-xs no-scrollbar">
              {chatHistory.map((chat, idx) => (
                <div
                  key={idx}
                  className={`flex ${chat.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl leading-relaxed shadow-sm ${
                      chat.role === 'user'
                        ? 'bg-indigo-600 text-white rounded-tr-none whitespace-pre-wrap'
                        : 'bg-slate-50 text-slate-700 border border-slate-100 rounded-tl-none'
                    }`}
                  >
                    {chat.role === 'user'
                      ? chat.content
                      : <Markdown content={chat.content} />}
                  </div>
                </div>
              ))}
              {isThinkingChat && (
                <div className="flex justify-start">
                  <div className="bg-slate-50 text-slate-400 border border-slate-150 px-3 py-2.5 rounded-2xl rounded-tl-none flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin text-indigo-600" /> Thinking...
                  </div>
                </div>
              )}
            </div>

            {/* Chat Input */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <input
                type="text"
                value={chatQuestion}
                onChange={e => setChatQuestion(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendChatMessage()}
                placeholder="Ask about attendance, fees, weak students..."
                className="flex-1 text-xs border-slate-200 focus:border-indigo-400 focus:ring-indigo-400 rounded-xl"
              />
              <button
                type="button"
                onClick={handleSendChatMessage}
                disabled={isThinkingChat || !chatQuestion.trim()}
                className="p-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-md transition-all flex-shrink-0"
              >
                <Send size={14} />
              </button>
            </div>
          </div>

          {/* D. Live AI Analytics Dashboard */}
          <div className="card p-6 border border-slate-200 bg-white rounded-3xl shadow-md space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-indigo-50 rounded-lg text-indigo-600">
                  <BarChart2 size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">AI Analytics Dashboard</h3>
                  <p className="text-[10px] text-slate-400">visual insights derived from documents</p>
                </div>
              </div>
              
              <button
                onClick={handleReanalyzeDashboard}
                disabled={isReanalyzingDashboard || localSubmissions.length === 0}
                className="text-[10px] text-indigo-600 hover:text-indigo-800 font-bold flex items-center gap-1 bg-transparent border-0 cursor-pointer disabled:opacity-50"
                title="Refresh AI Analysis"
              >
                <RefreshCw size={11} className={isReanalyzingDashboard ? 'animate-spin' : ''} /> Analyze Data
              </button>
            </div>

            {aiDashboard ? (
              <div className="space-y-6">
                {/* Executive Summary */}
                {aiDashboard.executiveSummary && (
                  <div className="bg-slate-50 border border-slate-150 p-4 rounded-2xl text-[11px] text-slate-600 leading-relaxed">
                    <b className="text-slate-800 block mb-1">Executive Summary:</b>
                    {aiDashboard.executiveSummary}
                  </div>
                )}

                {/* KPIs Grid */}
                {aiDashboard.kpis && aiDashboard.kpis.length > 0 && (
                  <div className="grid grid-cols-2 gap-3">
                    {aiDashboard.kpis.slice(0, 4).map((kpi, kIdx) => (
                      <div key={kIdx} className="bg-white border border-slate-200 p-3 rounded-2xl shadow-sm text-center">
                        <p className="text-[10px] text-slate-400 font-semibold truncate uppercase">{kpi.label}</p>
                        <p className="text-base font-black text-indigo-600 mt-1">{kpi.value}</p>
                        <span className="text-[8px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-full inline-block mt-1 font-medium">{kpi.change}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Visual Chart */}
                {aiDashboard.visuals && aiDashboard.visuals.length > 0 && (
                  <div className="space-y-4">
                    {aiDashboard.visuals.slice(0, 2).map((chart, cIdx) => (
                      <div key={cIdx} className="bg-slate-50/50 border border-slate-200/50 p-3 rounded-2xl">
                        <h4 className="text-[10px] font-bold text-slate-700 mb-3 text-center">{chart.title}</h4>
                        
                        {chart.type === 'bar' && (
                          <ResponsiveContainer width="100%" height={180}>
                            <BarChart data={chart.data} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                              <XAxis dataKey="name" stroke="#94a3b8" fontSize={9} tickLine={false} />
                              <YAxis stroke="#94a3b8" fontSize={9} tickLine={false} />
                              <Tooltip contentStyle={{ background: '#0f172a', borderRadius: '8px', border: 'none', color: '#fff', fontSize: '10px' }} />
                              {chart.keys.map((key, keyIdx) => (
                                <Bar key={key} dataKey={key} fill={keyIdx === 0 ? '#6366f1' : '#10b981'} radius={[3, 3, 0, 0]} />
                              ))}
                            </BarChart>
                          </ResponsiveContainer>
                        )}

                        {chart.type === 'line' && (
                          <ResponsiveContainer width="100%" height={180}>
                            <LineChart data={chart.data} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                              <XAxis dataKey="name" stroke="#94a3b8" fontSize={9} tickLine={false} />
                              <YAxis stroke="#94a3b8" fontSize={9} tickLine={false} />
                              <Tooltip contentStyle={{ background: '#0f172a', borderRadius: '8px', border: 'none', color: '#fff', fontSize: '10px' }} />
                              {chart.keys.map((key, keyIdx) => (
                                <Line key={key} type="monotone" dataKey={key} stroke={keyIdx === 0 ? '#6366f1' : '#10b981'} strokeWidth={2} dot={{ r: 2 }} />
                              ))}
                            </LineChart>
                          </ResponsiveContainer>
                        )}

                        {chart.type === 'pie' && (
                          <ResponsiveContainer width="100%" height={180}>
                            <PieChart>
                              <Pie
                                data={chart.data}
                                dataKey={chart.keys[0]}
                                nameKey="name"
                                cx="50%"
                                cy="50%"
                                outerRadius={60}
                                fill="#6366f1"
                                label={{ fontSize: 8 }}
                              >
                                {chart.data.map((entry, idx) => (
                                  <Cell key={`cell-${idx}`} fill={['#6366f1', '#10b981', '#f59e0b', '#3b82f6'][idx % 4]} />
                                ))}
                              </Pie>
                              <Tooltip contentStyle={{ background: '#0f172a', borderRadius: '8px', border: 'none', color: '#fff', fontSize: '10px' }} />
                            </PieChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8 text-slate-400 text-xs">
                <Sparkles size={20} className="mx-auto mb-2 text-indigo-400" />
                Click "Analyze Data" above to synthesize and generate dynamic KPI widgets and recharts graphs.
              </div>
            )}
          </div>

        </div>

      </div>

      {/* 3. Conclude / End Meeting Confirmation Modal */}
      <Modal
        open={showEndModal}
        onClose={() => !isEndingMeeting && setShowEndModal(false)}
        title="Conclude Live HOD Meeting"
        footer={
          <>
            <button
              onClick={() => setShowEndModal(false)}
              disabled={isEndingMeeting}
              className="btn-ghost text-xs"
            >
              Cancel
            </button>
            <button
              onClick={handleConcludeMeeting}
              disabled={isEndingMeeting}
              className="btn-danger text-xs flex items-center gap-1 bg-red-600 hover:bg-red-700"
            >
              {isEndingMeeting ? <Spinner size={12} className="border-t-white border-white/30" /> : <CheckCircle2 size={13} />}
              Confirm End Meeting
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="alert-warning text-xs">
            <AlertTriangle size={16} />
            Ending the meeting will instantly freeze real-time document editing and lock the collaborative notepad.
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            By concluding this meeting, the system will trigger the following automated governance workflows:
          </p>
          <ul className="list-disc pl-5 text-xs text-slate-500 space-y-2">
            <li><b>AI MOM Synthesis</b>: Generates high-level executive summaries and department-specific briefs.</li>
            <li><b>Database Auto-Ingestion</b>: Extracts spreadsheet rows (Student Fees/Weak Students) and automatically categorizes/inserts them into dashboard tables.</li>
            <li><b>HOD Dashboard Push</b>: Directives and action items are pushed directly to each department’s calendar and HOD dashboard.</li>
          </ul>
        </div>
      </Modal>

      {/* 4. Concluded Summary / Success Modal */}
      <Modal
        open={!!concludedSummary}
        onClose={() => {
          setConcludedSummary(null);
          navigate(`/meetings/agendas/${id}`);
        }}
        title="Meeting Concluded Successfully! 🎉"
        footer={
          <button
            onClick={() => {
              setConcludedSummary(null);
              navigate(`/meetings/agendas/${id}`);
            }}
            className="btn-primary text-xs"
          >
            Go Back to Agenda Detail
          </button>
        }
      >
        <div className="space-y-5 text-xs leading-relaxed max-h-[70vh] overflow-y-auto pr-1 no-scrollbar">
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-2xl flex items-start gap-2.5">
            <CheckCircle2 size={18} className="text-emerald-600 mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-bold">Automated Ingestion Engine: Success</h4>
              <p className="text-[10px] text-emerald-700 mt-0.5">
                Ingested <b>{concludedSummary?.ingestionResult?.recordsIngested || 0} records</b> into the operational dashboard. All fee collection and weak student backlogs are updated.
              </p>
            </div>
          </div>

          <div>
            <h4 className="font-bold text-slate-800 mb-2">Official Minutes of Meeting</h4>
            <div className="bg-slate-50 border border-slate-200 p-4 rounded-2xl text-[11px] text-slate-600 leading-relaxed space-y-2">
              <p>{concludedSummary?.mom?.openingParagraph}</p>
              <div className="flex flex-wrap gap-3 text-[10px] text-slate-500 pt-1 border-t border-slate-150 mt-2">
                <span><b className="text-slate-700">{(concludedSummary?.mom?.presentInPerson?.length || 0) + (concludedSummary?.mom?.presentOnline?.length || 0)}</b> present</span>
                <span><b className="text-slate-700">{concludedSummary?.mom?.absentees?.length || 0}</b> absent</span>
                <span><b className="text-slate-700">{concludedSummary?.mom?.agenda?.length || 0}</b> agenda items minuted</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 justify-center pt-3 border-t border-slate-100">
            <button
              onClick={downloadMOMpdf}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-md shadow-indigo-100 flex items-center gap-1.5"
            >
              <Download size={13} /> Download Official MOM PDF
            </button>
            <Link
              to={`/meetings/agendas/${id}/mom`}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5"
            >
              <FileText size={13} /> View MOM
            </Link>
          </div>
        </div>
      </Modal>

    </div>
  );
}

// Simple debounce helper function
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
