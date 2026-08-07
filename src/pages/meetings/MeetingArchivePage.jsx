import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Search, ChevronDown, ChevronRight, FileText, Download, Paperclip, ListChecks, Users, ExternalLink, FolderOpen } from 'lucide-react';
import { useMeetingArchive } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { MEETING_STATUS_LABELS, MEETING_STATUS_COLORS, SEMESTER_BATCHES } from '../../lib/constants';
import { isOfficialMOM } from '../../lib/momFormat';
import { downloadOfficialMomPdf } from '../../lib/momPdf';
import { Spinner, EmptyState } from '../../components/ui/index';
import { format } from 'date-fns';

export default function MeetingArchivePage() {
  const { canViewAll } = useAuth();
  const { data: meetings = [], isLoading } = useMeetingArchive();
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState(null);

  const filtered = meetings.filter(m =>
    m.agenda_title?.toLowerCase().includes(search.toLowerCase()) ||
    m.venue?.toLowerCase().includes(search.toLowerCase()) ||
    m.category?.toLowerCase().includes(search.toLowerCase())
  );

  const withMom = meetings.filter(m => m.meeting_mom?.length).length;

  return (
    <div className="page-wrapper max-w-5xl mx-auto">
      <div className="section-header mb-6">
        <div>
          <h1 className="section-title flex items-center gap-2"><Archive size={22} className="text-primary-600" /> Meeting Archive</h1>
          <p className="section-subtitle">
            {canViewAll
              ? 'Full history of past meetings — Minutes, agendas, submissions and documents.'
              : 'Your past meetings — Minutes, agendas, materials and action points you were part of.'}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Meetings', value: meetings.length, color: 'text-primary-600' },
          { label: 'With Published MOM', value: withMom, color: 'text-success-600' },
          { label: 'Conducted', value: meetings.filter(m => m.status === 'conducted').length, color: 'text-accent-600' },
        ].map(s => (
          <div key={s.label} className="card p-4 text-center">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-surface-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="card p-4 mb-6">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="search"
            placeholder="Search past meetings…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="card p-12 flex justify-center"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Archive} title="No past meetings" description="Meetings you take part in will appear here once they've been circulated or conducted." />
      ) : (
        <div className="space-y-3">
          {filtered.map(m => (
            <ArchiveCard key={m.id} meeting={m} open={openId === m.id} onToggle={() => setOpenId(openId === m.id ? null : m.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchiveCard({ meeting, open, onToggle }) {
  const momRow = meeting.meeting_mom?.[0];
  const hasMom = momRow && isOfficialMOM(momRow);
  const agenda = (meeting.agenda_items || []).slice().sort((a, b) => (a.order_number || 0) - (b.order_number || 0));
  const docs = meeting.documents || [];
  const actions = meeting.action_items || [];
  const badgeClass = MEETING_STATUS_COLORS[meeting.status] || 'badge-surface';

  return (
    <div className="card overflow-hidden">
      {/* Header row */}
      <button onClick={onToggle} className="w-full flex items-center gap-4 p-4 text-left hover:bg-surface-50 transition-colors">
        <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-primary-50 border border-primary-100 flex flex-col items-center justify-center">
          <span className="text-base font-bold text-primary-700 leading-none">{new Date(meeting.meeting_date).getDate()}</span>
          <span className="text-[10px] text-primary-500 uppercase">{new Date(meeting.meeting_date).toLocaleString('default', { month: 'short' })}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-0.5">
            <span className={`badge ${badgeClass}`}>{MEETING_STATUS_LABELS[meeting.status]}</span>
            {meeting.category && <span className="badge-surface">{meeting.category}</span>}
            {meeting.semester_batch && SEMESTER_BATCHES[meeting.semester_batch] && (
              <span className={`badge text-xs ${SEMESTER_BATCHES[meeting.semester_batch].badge}`}>{SEMESTER_BATCHES[meeting.semester_batch].short}</span>
            )}
            {hasMom && <span className="badge-success text-xs flex items-center gap-1"><FileText size={10} /> MOM</span>}
          </div>
          <h3 className="text-sm font-semibold text-surface-900 truncate">{meeting.agenda_title}</h3>
          <p className="text-xs text-surface-500 flex flex-wrap gap-x-3">
            <span>{format(new Date(meeting.meeting_date), 'EEE, dd MMM yyyy')}</span>
            <span>📍 {meeting.venue}</span>
            <span>📋 {agenda.length} agenda</span>
          </p>
        </div>
        {open ? <ChevronDown size={18} className="text-surface-400 flex-shrink-0" /> : <ChevronRight size={18} className="text-surface-400 flex-shrink-0" />}
      </button>

      {/* Expanded */}
      {open && (
        <div className="border-t border-surface-100 p-4 space-y-5 bg-surface-50/40">
          {/* MOM */}
          <Section icon={FileText} title="Minutes of Meeting">
            {hasMom ? (
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/meetings/agendas/${meeting.id}/mom`} className="btn-secondary text-xs"><ExternalLink size={12} /> View MOM</Link>
                <button onClick={() => downloadOfficialMomPdf(momRow.mom_content, meeting.agenda_title)} className="btn-secondary text-xs"><Download size={12} /> Download PDF</button>
                <span className="text-[11px] text-surface-400 flex items-center gap-1"><Users size={11} /> {(momRow.mom_content?.presentInPerson?.length || 0) + (momRow.mom_content?.presentOnline?.length || 0)} attended</span>
              </div>
            ) : (
              <p className="text-xs text-surface-400">MOM has not been published for this meeting.</p>
            )}
          </Section>

          {/* Agenda */}
          {agenda.length > 0 && (
            <Section icon={ListChecks} title={`Agenda (${agenda.length})`}>
              <ul className="space-y-1">
                {agenda.map((a, i) => (
                  <li key={a.id} className="text-xs text-surface-700 flex gap-2">
                    <span className="text-surface-400 font-semibold">{i + 1}.</span>
                    <span>{a.title}{a.category ? <span className="text-surface-400"> · {a.category}</span> : null}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Documents / materials */}
          {docs.length > 0 && (
            <Section icon={Paperclip} title={`Documents & Materials (${docs.length})`}>
              <div className="space-y-1.5">
                {docs.map(d => (
                  <div key={d.id} className="flex items-center gap-2 text-xs">
                    <FolderOpen size={13} className="text-surface-400 flex-shrink-0" />
                    <span className="flex-1 truncate text-surface-700">{d.title || d.document_type || 'Document'}</span>
                    {d.file_url
                      ? <a href={d.file_url} target="_blank" rel="noreferrer" className="text-primary-600 hover:text-primary-700 flex items-center gap-1 font-medium"><Download size={12} /> Open</a>
                      : <span className="text-surface-300">no file</span>}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Action items */}
          {actions.length > 0 && (
            <Section icon={ListChecks} title={`Action Items (${actions.length})`}>
              <div className="space-y-1.5">
                {actions.map(a => (
                  <div key={a.id} className="flex items-center gap-2 text-xs">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${a.status === 'completed' ? 'bg-success-500' : a.status === 'in_progress' ? 'bg-warning-500' : 'bg-surface-300'}`} />
                    <span className="flex-1 truncate text-surface-700">{a.description}</span>
                    <span className="text-[10px] text-surface-400">{a.completion_percentage ?? 0}%</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <div className="pt-1">
            <Link to={`/meetings/agendas/${meeting.id}`} className="text-xs text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1">
              Open full meeting detail <ChevronRight size={12} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div>
      <h4 className="text-xs font-bold text-surface-600 flex items-center gap-1.5 mb-2 uppercase tracking-wide">
        <Icon size={13} className="text-primary-500" /> {title}
      </h4>
      {children}
    </div>
  );
}
