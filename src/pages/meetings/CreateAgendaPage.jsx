import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Trash2, Save, Send, ChevronUp, ChevronDown, AlertCircle, FileSpreadsheet, Database, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { useCreateMeeting, useUpdateMeeting, useMeeting, useAgendaTemplates, useAgendaSubmissions, useAgendaTemplate } from '../../hooks/useData';
import { agendaService } from '../../lib/services';
import { emailService } from '../../lib/emailService';
import { downloadMeetingSubmissionsWorkbook, downloadSubmissionWorkbook } from '../../lib/agendaExcel';
import { useDepartments } from '../../hooks/useData';
import { MEETING_CATEGORIES, DOCUMENT_TYPES, VENUE_OPTIONS, SEMESTER_BATCHES } from '../../lib/constants';
import { PageHeader, FormField, Spinner, Modal } from '../../components/ui/index';
import { isConsultancyTemplate, consultConfigured, fetchConsultancyFaculty, groupConsultancyByDept, migrateConsultancyToMeeting, CONSULT_SOURCES, CONSULT_COLUMNS } from '../../lib/consultancy';

// Local YYYY-MM-DD for "today" (used as the min for date inputs / past-date checks)
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const NOT_APPLICABLE = 'Not Applicable';

const agendaItemSchema = z.object({
  category:    z.string().min(1, 'Category required'),
  title:       z.string().min(3, 'Title required'),
  description: z.string().optional(),
  responsible_department_id: z.string().optional(),
  priority_level: z.number().min(1).max(4).default(2),
  deadline:    z.string().optional(),
  required_documents: z.array(z.string()).default([]),
}).refine(
  (item) => !item.deadline || item.deadline >= todayStr(),
  { message: 'Deadline cannot be before today', path: ['deadline'] }
);

const schema = z.object({
  agenda_title: z.string().min(5, 'Title must be at least 5 characters'),
  meeting_date: z.string().min(1, 'Meeting date required'),
  meeting_time: z.string().optional(),
  venue:        z.string().min(3, 'Venue required'),
  semester_batch: z.enum(['odd', 'even'], { required_error: 'Select a semester batch' }),
  agenda_items: z.array(agendaItemSchema).min(1, 'Add at least one agenda item'),
  agenda_template_id: z.string().nullable().optional(),
  invited_departments: z.array(z.string()).default([]),
}).refine(
  (data) => {
    if (!data.meeting_date) return true;
    // Combine date + time and require it to be now or later
    const when = new Date(`${data.meeting_date}T${data.meeting_time || '23:59'}`);
    return when.getTime() >= Date.now();
  },
  { message: 'Meeting date & time cannot be in the past', path: ['meeting_date'] }
);

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };

export default function CreateAgendaPage() {
  const { id } = useParams();
  const isEditMode = !!id;
  const { user, canViewAll } = useAuth();
  const navigate = useNavigate();

  const createMeeting = useCreateMeeting();
  const updateMeeting = useUpdateMeeting();
  const { data: meetingData, isLoading: loadingMeeting } = useMeeting(id);
  const { data: templates = [] } = useAgendaTemplates();
  const { data: departments = [] } = useDepartments();

  // The data HODs have already submitted against this meeting's saved template,
  // so an admin can pull it out as Excel without leaving the edit screen.
  const { data: submissions = [] } = useAgendaSubmissions(isEditMode ? id : null);
  const { data: savedTemplate } = useAgendaTemplate(meetingData?.agenda_template_id);
  const submissionsWithData = submissions.filter(s => (s.submitted_data?.length || 0) > 0);

  const handleDownloadAllSubmissions = () => {
    try {
      const res = downloadMeetingSubmissionsWorkbook({
        meeting: meetingData, template: savedTemplate, submissions, departments,
      });
      toast.success(`Exported ${res.rows} rows from ${res.departments} department(s).`);
    } catch (err) {
      toast.error(err.message || 'Failed to export submissions');
    }
  };

  const handleDownloadSubmission = (submission) => {
    try {
      downloadSubmissionWorkbook({ meeting: meetingData, template: savedTemplate, submission });
      toast.success(`Downloaded ${submission.department?.code || 'department'} data as Excel.`);
    } catch (err) {
      toast.error(err.message || 'Failed to export this submission');
    }
  };

  const [saving, setSaving] = useState(false);
  const [templateId, setTemplateId] = useState('');

  // Consultancy auto-migration state
  const [consultSource, setConsultSource] = useState('primary');
  const [migrateConsult, setMigrateConsult] = useState(true);
  const [consultPreviewOpen, setConsultPreviewOpen] = useState(false);
  const [consultLoading, setConsultLoading] = useState(false);
  const [consultPreview, setConsultPreview] = useState(null); // { byDept, skipped, mapped }
  const [consultError, setConsultError] = useState('');

  const { register, control, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      agenda_title: '',
      meeting_date: '',
      meeting_time: '10:00',
      venue: VENUE_OPTIONS[0],
      semester_batch: 'odd',
      agenda_template_id: '',
      invited_departments: [],
      agenda_items: [
        { category: 'Academic Review', title: '', description: '', priority_level: 2, required_documents: [] },
      ],
    },
  });

  const { fields, append, remove, move } = useFieldArray({ control, name: 'agenda_items' });

  // Auto-select all departments in create mode
  useEffect(() => {
    if (departments.length > 0 && !isEditMode && watch('invited_departments')?.length === 0) {
      setValue('invited_departments', departments.map(d => d.id));
    }
  }, [departments, isEditMode, setValue]);

  // Load meeting details if in edit mode
  useEffect(() => {
    if (meetingData && isEditMode) {
      reset({
        agenda_title: meetingData.agenda_title,
        meeting_date: meetingData.meeting_date,
        meeting_time: meetingData.meeting_time || '10:00',
        venue: meetingData.venue || VENUE_OPTIONS[0],
        semester_batch: meetingData.semester_batch || 'odd',
        agenda_template_id: meetingData.agenda_template_id || '',
        invited_departments: meetingData.invited_departments || [],
        agenda_items: meetingData.agenda_items?.map(item => ({
          category: item.category,
          title: item.title,
          description: item.description || '',
          responsible_department_id: item.responsible_department_id || '',
          priority_level: item.priority_level || 2,
          deadline: item.deadline || '',
          required_documents: item.required_documents || [],
        })) || [{ category: 'Academic Review', title: '', description: '', priority_level: 2, required_documents: [] }],
      });
      setTemplateId(meetingData.agenda_template_id || '');
    }
  }, [meetingData, isEditMode, reset]);

  // Fetch + format consultancy data for the preview popup
  const loadConsultPreview = async (src = consultSource) => {
    if (!consultConfigured) {
      setConsultError('Consultancy portal not configured — set VITE_CONSULT_SUPABASE_URL and VITE_CONSULT_SUPABASE_ANON_KEY in .env.');
      setConsultPreview(null);
      return;
    }
    setConsultLoading(true);
    setConsultError('');
    try {
      const faculty = await fetchConsultancyFaculty(src);
      setConsultPreview(groupConsultancyByDept(faculty, departments));
    } catch (err) {
      setConsultError(err.message || 'Failed to load consultancy data');
      setConsultPreview(null);
    } finally {
      setConsultLoading(false);
    }
  };

  // Handle template selection
  const handleTemplateChange = (e) => {
    const selectedId = e.target.value;
    setTemplateId(selectedId);
    setValue('agenda_template_id', selectedId);

    if (selectedId) {
      const template = templates.find(t => t.id === selectedId);
      if (template) {
        setValue('agenda_title', template.title);
        
        const prefilledItems = template.agenda_items?.map(item => ({
          category: item.category,
          title: item.title,
          description: item.description || '',
          responsible_department_id: '',
          priority_level: item.priority_level || 2,
          deadline: '',
          required_documents: item.required_documents || [],
        })) || [];

        if (prefilledItems.length > 0) {
          setValue('agenda_items', prefilledItems);
        }
        toast.success(`Loaded predefined template: ${template.title}`);

        // Consultancy agenda → open the auto-migration popup
        if (isConsultancyTemplate(template)) {
          setMigrateConsult(true);
          setConsultPreviewOpen(true);
          loadConsultPreview(consultSource);
        }
      }
    }
  };

  const onSubmit = async (data, status = 'draft') => {
    setSaving(true);
    try {
      const { agenda_items: _items, ...meetingPayload } = data;
      let meeting;
      
      const payload = {
        ...meetingPayload,
        status,
        agenda_template_id: templateId || null,
      };

      if (isEditMode) {
        meeting = await updateMeeting.mutateAsync({
          id,
          ...payload,
        });
        
        // Recreate agenda items in edit mode
        const { supabase } = await import('../../lib/supabase');
        await supabase.from('agenda_items').delete().eq('meeting_id', id);
      } else {
        meeting = await createMeeting.mutateAsync({
          ...payload,
          created_by: user.id,
        });
      }

      const targetMeetingId = isEditMode ? id : meeting?.id;

      // Create agenda items linked to meeting
      if (targetMeetingId) {
        await agendaService.bulkCreate(
          data.agenda_items.map((item, i) => ({
            ...item,
            meeting_id: targetMeetingId,
            order_number: i + 1,
            responsible_department_id: item.responsible_department_id || null,
            deadline: item.deadline || null,
            required_documents: item.required_documents || [],
          }))
        );

        // Send notifications to all active faculty/HODs if this meeting is being circulated or submitted for approval
        if (status !== 'draft') {
          try {
            const { usersService, notificationsService } = await import('../../lib/services');
            const allUsers = await usersService.list({ isActive: true });
            
            const notifPayloads = allUsers
              .filter(u => ['faculty', 'hod', 'director', 'principal'].includes(u.role))
              .map(u => ({
                user_id: u.id,
                title: isEditMode ? `Meeting Updated: ${data.agenda_title}` : `New Meeting Scheduled: ${data.agenda_title}`,
                message: `A meeting agenda has been ${isEditMode ? 'updated' : 'scheduled'} for ${data.meeting_date} at ${data.meeting_time || '10:00'}. Please review the agenda items and upload any required formatted reports.`,
                read_status: false,
                notification_type: 'meeting',
                priority: 'medium',
                action_url: `/meetings/agendas/${targetMeetingId}`,
                created_at: new Date().toISOString()
              }));

            if (notifPayloads.length > 0) {
              await notificationsService.bulkCreate(notifPayloads);
            }
          } catch (notifErr) {
            console.error('Failed to dispatch notifications:', notifErr);
          }
        }
      }

      toast.success(
        isEditMode ? 'Meeting agenda updated successfully'
        : status === 'pending_approval' ? 'Agenda submitted for approval!'
        : 'Agenda saved as draft'
      );

      // 📧 Send email notification when submitted for approval
      if (status !== 'draft' && targetMeetingId) {
        emailService.meetingCreated({
          id: targetMeetingId,
          agenda_title: data.agenda_title,
          meeting_date: data.meeting_date,
          meeting_time: data.meeting_time,
          venue: data.venue,
        }); // fire-and-forget
      }

      // 🔄 Auto-migrate faculty consultancy data for the consultancy agenda
      const tmpl = templates.find(t => t.id === templateId);
      if (targetMeetingId && migrateConsult && isConsultancyTemplate(tmpl) && consultConfigured) {
        try {
          const res = await migrateConsultancyToMeeting({
            meetingId: targetMeetingId,
            templateId: templateId || null,
            departments,
            sourceKey: consultSource,
            userId: user.id,
          });
          toast.success(`Consultancy data attached: ${res.faculty} faculty across ${res.departments} departments`);
        } catch (mErr) {
          console.error('Consultancy migration failed:', mErr);
          toast.error('Meeting saved, but consultancy data migration failed.');
        }
      }

      navigate('/meetings/agendas');
    } catch (err) {
      toast.error(err.message || 'Failed to save agenda');
    } finally {
      setSaving(false);
    }
  };

  const addItem = () => append({
    category: 'Academic Review', title: '', description: '', priority_level: 2, required_documents: []
  });

  const toggleDoc = (index, doc) => {
    const current = watch(`agenda_items.${index}.required_documents`) || [];
    let next;
    if (doc === NOT_APPLICABLE) {
      // "Not Applicable" is exclusive — selecting it clears everything else
      next = current.includes(NOT_APPLICABLE) ? [] : [NOT_APPLICABLE];
    } else {
      // Selecting a real document removes the "Not Applicable" flag
      const base = current.filter(d => d !== NOT_APPLICABLE);
      next = base.includes(doc) ? base.filter(d => d !== doc) : [...base, doc];
    }
    setValue(`agenda_items.${index}.required_documents`, next);
  };

  if (isEditMode && loadingMeeting) {
    return (
      <div className="page-wrapper flex items-center justify-center min-h-[50vh]">
        <Spinner size={32} />
      </div>
    );
  }

  const minDate = todayStr();
  // In edit mode we keep the meeting at its current status (so editing an
  // already-circulated meeting doesn't reset it back to pending/draft).
  const editStatus = meetingData?.status || 'draft';
  // Preserve any legacy free-text venue (from meetings created before the dropdown) as a selectable option
  const currentVenue = watch('venue');
  const venueOptions = currentVenue && !VENUE_OPTIONS.includes(currentVenue)
    ? [currentVenue, ...VENUE_OPTIONS]
    : VENUE_OPTIONS;

  const selectedTemplate = templates.find(t => t.id === templateId);
  const isConsultancy = isConsultancyTemplate(selectedTemplate);

  return (
    <div className="page-wrapper max-w-4xl mx-auto">
      <PageHeader
        title={isEditMode ? "Edit Meeting Agenda" : "Create Meeting Agenda"}
        subtitle="Define the agenda items, assign responsibilities, and set document deadlines"
        actions={
          <Link to={isEditMode ? `/meetings/agendas/${id}` : "/meetings/agendas"} className="btn-ghost text-sm">← Back</Link>
        }
      />

      <form onSubmit={handleSubmit(d => onSubmit(d, isEditMode ? editStatus : 'pending_approval'))}>
        {/* Predefined Templates selector — available in create AND edit mode */}
        {templates.length > 0 && (
          <div className="card p-5 mb-6 border-l-4 border-emerald-500 bg-emerald-50/10">
            <h3 className="text-sm font-bold text-surface-800 mb-2 flex items-center gap-1.5">
              <FileSpreadsheet size={16} className="text-emerald-600" />
              {isEditMode ? 'Change Agenda Template' : 'Use Predefined Agenda Template'}
            </h3>
            <p className="text-xs text-surface-500 mb-4">
              {isEditMode
                ? 'Pick a different pre-made template to re-apply its format — this replaces the agenda title, items, and required-document schema below with the template’s. Leave it unchanged to keep the current agenda.'
                : 'Select a pre-made agenda template to automatically fill in details, lists of items, and required document upload schemas.'}
            </p>
            <div className="max-w-md">
              <select 
                value={templateId} 
                onChange={handleTemplateChange}
                className="text-sm bg-white"
              >
                <option value="">-- Choose Predefined Agenda Template --</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Submitted departmental data — download without leaving the editor */}
        {isEditMode && canViewAll && submissionsWithData.length > 0 && (
          <div className="card p-5 mb-6 border-l-4 border-emerald-500 bg-emerald-50/10">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-emerald-100 rounded-xl text-emerald-700 flex-shrink-0">
                  <FileSpreadsheet size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-surface-800">Submitted Departmental Data</h3>
                  <p className="text-xs text-surface-500 mt-1 max-w-xl">
                    {submissionsWithData.length} department{submissionsWithData.length === 1 ? '' : 's'} have uploaded
                    spreadsheet data for this agenda. Download it as Excel — dates come out as dd/mm/yyyy.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDownloadAllSubmissions}
                className="btn-primary text-xs flex-shrink-0 shadow-md shadow-emerald-200"
              >
                <Download size={14} /> Download All Excel Data
              </button>
            </div>
            <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-emerald-100">
              {submissionsWithData.map(sub => (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => handleDownloadSubmission(sub)}
                  title={`Download ${sub.department?.name || 'department'} data (${sub.submitted_data.length} rows)`}
                  className="text-[10px] bg-white border border-surface-200 hover:border-emerald-300 hover:bg-emerald-50 text-surface-700 px-2.5 py-1.5 rounded-xl font-bold flex items-center gap-1 transition-all shadow-sm"
                >
                  <Download size={10} className="text-emerald-600" />
                  {sub.department?.code || 'Dept'}
                  <span className="text-surface-400 font-medium">({sub.submitted_data.length})</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Consultancy auto-migration card */}
        {isConsultancy && (
          <div className="card p-5 mb-6 border-l-4 border-indigo-500 bg-indigo-50/20">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-indigo-100 rounded-xl text-indigo-600 flex-shrink-0"><Database size={18} /></div>
                <div>
                  <h3 className="text-sm font-bold text-surface-800">Auto-migrate faculty consultancy data</h3>
                  <p className="text-xs text-surface-500 mt-1 max-w-xl">
                    Faculty-wise consultation stats are pulled from the admissions portal and formatted into this agenda's grid — attached per department automatically, so HODs don't upload anything.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={consultSource}
                  onChange={e => { setConsultSource(e.target.value); loadConsultPreview(e.target.value); }}
                  className="text-xs w-auto bg-white"
                >
                  {Object.entries(CONSULT_SOURCES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <button type="button" onClick={() => { setConsultPreviewOpen(true); if (!consultPreview) loadConsultPreview(); }} className="btn-secondary text-xs">
                  <FileSpreadsheet size={13} /> Preview
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 mt-3 text-xs font-semibold text-surface-700 cursor-pointer w-fit">
              <input type="checkbox" checked={migrateConsult} onChange={e => setMigrateConsult(e.target.checked)} className="w-4 h-4 rounded border-surface-300 text-indigo-600 focus:ring-indigo-500" />
              Attach consultancy data to this meeting when saved
            </label>
            {!consultConfigured && (
              <p className="text-[11px] text-danger-600 mt-2">⚠ Consultancy portal not configured — set VITE_CONSULT_SUPABASE_URL / _ANON_KEY in .env.</p>
            )}
          </div>
        )}

        {/* Meeting Details */}
        <div className="card p-6 mb-6">
          <h3 className="text-base font-semibold text-surface-800 mb-4">Meeting Details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <FormField label="Agenda Title" required error={errors.agenda_title?.message}>
                <input {...register('agenda_title')} placeholder="e.g. Monthly HOD Meeting – June 2025" />
              </FormField>
            </div>
            <FormField label="Meeting Date" required error={errors.meeting_date?.message}>
              <input type="date" min={minDate} {...register('meeting_date')} />
            </FormField>
            <FormField label="Meeting Time" error={errors.meeting_time?.message}>
              <input type="time" {...register('meeting_time')} />
            </FormField>
            <FormField label="Venue" required error={errors.venue?.message}>
              <select {...register('venue')} className="text-sm bg-white">
                {venueOptions.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </FormField>
            <FormField label="Semester Batch" required error={errors.semester_batch?.message}>
              <select {...register('semester_batch')} className="text-sm bg-white">
                {Object.values(SEMESTER_BATCHES).map(b => (
                  <option key={b.value} value={b.value}>{b.label} ({b.semesters.join(', ')})</option>
                ))}
              </select>
            </FormField>
            <div className="sm:col-span-2 mt-2">
              <label className="form-label font-medium mb-1.5 block">Invited Departments</label>
              {departments.length === 0 ? (
                <p className="text-xs text-surface-400">Loading departments...</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 p-4 border border-surface-200 rounded-xl bg-surface-50/50">
                  {departments.map((dept) => {
                    const selected = watch('invited_departments')?.includes(dept.id);
                    return (
                      <label
                        key={dept.id}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                          selected
                            ? 'bg-primary-50 border-primary-300 text-primary-800'
                            : 'bg-white border-surface-200 text-surface-600 hover:border-surface-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          value={dept.id}
                          checked={selected}
                          onChange={(e) => {
                            const current = watch('invited_departments') || [];
                            if (e.target.checked) {
                              setValue('invited_departments', [...current, dept.id]);
                            } else {
                              setValue('invited_departments', current.filter((id) => id !== dept.id));
                            }
                          }}
                          className="rounded border-surface-300 text-primary-600 focus:ring-primary-500 w-4 h-4"
                        />
                        <span className="text-xs font-semibold">{dept.code} - {dept.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {errors.invited_departments?.message && (
                <p className="text-xs text-danger-500 mt-1">{errors.invited_departments.message}</p>
              )}
            </div>
          </div>
        </div>

        {/* Agenda Items */}
        <div className="space-y-4 mb-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-surface-800">
              Agenda Items <span className="text-sm font-normal text-surface-400">({fields.length})</span>
            </h3>
            <button type="button" onClick={addItem} className="btn-secondary text-sm">
              <Plus size={14} /> Add Item
            </button>
          </div>

          {errors.agenda_items?.message && (
            <div className="alert-danger"><AlertCircle size={16} />{errors.agenda_items.message}</div>
          )}

          {fields.map((field, index) => {
            const item = watch(`agenda_items.${index}`);
            return (
              <div key={field.id} className="card p-5 border-l-4 border-primary-400">
                {/* Item header */}
                <div className="flex items-center gap-3 mb-3">
                  <span className="w-6 h-6 rounded-lg bg-primary-100 text-primary-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                    {index + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <input
                      {...register(`agenda_items.${index}.title`)}
                      placeholder="Agenda item title…"
                      className="font-medium text-sm border-0 p-0 bg-transparent focus:ring-0 w-full"
                    />
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button type="button" onClick={() => index > 0 && move(index, index - 1)} className="btn-ghost p-1" title="Move up">
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" onClick={() => move(index, index + 1)} className="btn-ghost p-1" title="Move down">
                      <ChevronDown size={14} />
                    </button>
                    {fields.length > 1 && (
                      <button type="button" onClick={() => remove(index)} className="btn-ghost p-1 text-danger-500 hover:text-danger-700 hover:bg-danger-50">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <FormField label="Category">
                    <select {...register(`agenda_items.${index}.category`)} className="text-sm bg-white">
                      {MEETING_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Responsible Dept">
                    <select {...register(`agenda_items.${index}.responsible_department_id`)} className="text-sm bg-white">
                      <option value="">All Departments</option>
                      {departments.map(d => <option key={d.id} value={d.id}>{d.code} – {d.name}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Priority">
                    <select {...register(`agenda_items.${index}.priority_level`, { valueAsNumber: true })} className="text-sm bg-white">
                      {[1,2,3,4].map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
                    </select>
                  </FormField>
                  <div className="sm:col-span-2">
                    <FormField label="Description">
                      <textarea {...register(`agenda_items.${index}.description`)} rows={2} placeholder="Optional details…" className="text-sm bg-white" />
                    </FormField>
                  </div>
                  <FormField label="Document Deadline" error={errors.agenda_items?.[index]?.deadline?.message}>
                    <input type="date" min={minDate} {...register(`agenda_items.${index}.deadline`)} className="text-sm bg-white" />
                  </FormField>
                  <div className="sm:col-span-3">
                    <label className="form-label">Required Documents</label>
                    <div className="flex flex-wrap gap-2 p-3 border border-surface-200 rounded-xl bg-white">
                      {[...DOCUMENT_TYPES.slice(0, 12), NOT_APPLICABLE].map(doc => {
                        const selected = (item?.required_documents || []).includes(doc);
                        const isNA = doc === NOT_APPLICABLE;
                        return (
                          <button
                            key={doc}
                            type="button"
                            onClick={() => toggleDoc(index, doc)}
                            className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                              selected
                                ? (isNA ? 'bg-surface-600 text-white border-surface-600' : 'bg-primary-600 text-white border-primary-600')
                                : (isNA ? 'bg-surface-50 text-surface-500 border-dashed border-surface-300 hover:border-surface-400'
                                        : 'bg-white text-surface-600 border-surface-200 hover:border-primary-300')
                            }`}
                          >
                            {doc}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          <button type="button" onClick={addItem}
                  className="w-full border-2 border-dashed border-surface-200 rounded-2xl p-4 text-sm text-surface-400
                             hover:border-primary-300 hover:text-primary-600 transition-colors flex items-center justify-center gap-2 bg-white">
            <Plus size={16} /> Add Another Agenda Item
          </button>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-4 sticky bottom-0 bg-surface-50/90 backdrop-blur py-4 -mx-6 px-6 border-t border-surface-200 z-20">
          <Link to={isEditMode ? `/meetings/agendas/${id}` : "/meetings/agendas"} className="btn-ghost">Cancel</Link>
          <div className="flex items-center gap-3">
            {isEditMode ? (
              <button type="submit" disabled={saving} className="btn-primary">
                {saving ? <Spinner size={16} className="border-t-white border-white/30" /> : <Save size={15} />}
                Save Changes
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleSubmit(d => onSubmit(d, 'draft'))}
                  disabled={saving}
                  className="btn-secondary"
                >
                  {saving ? <Spinner size={16} /> : <Save size={15} />}
                  Save Draft
                </button>
                <button type="submit" disabled={saving} className="btn-primary">
                  {saving ? <Spinner size={16} className="border-t-white border-white/30" /> : <Send size={15} />}
                  Submit for Approval
                </button>
              </>
            )}
          </div>
        </div>
      </form>

      {/* Consultancy data preview popup */}
      <Modal
        open={consultPreviewOpen}
        onClose={() => setConsultPreviewOpen(false)}
        title="Faculty Consultancy Data — Auto-Migration Preview"
        size="lg"
        footer={
          <div className="flex items-center justify-between w-full gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-surface-700 cursor-pointer">
              <input type="checkbox" checked={migrateConsult} onChange={e => setMigrateConsult(e.target.checked)} className="w-4 h-4 rounded border-surface-300 text-indigo-600" />
              Attach to meeting on save
            </label>
            <button onClick={() => setConsultPreviewOpen(false)} className="btn-primary text-sm">Done</button>
          </div>
        }
      >
        {consultLoading ? (
          <div className="flex justify-center py-10"><Spinner size={28} /></div>
        ) : consultError ? (
          <div className="alert-danger text-xs"><AlertCircle size={16} />{consultError}</div>
        ) : consultPreview && Object.keys(consultPreview.byDept).length > 0 ? (
          <div className="space-y-4">
            <p className="text-xs text-surface-500">
              <b>{Object.keys(consultPreview.byDept).length}</b> departments mapped · <b>{consultPreview.mapped}</b> faculty
              {consultPreview.skipped > 0 && <> · {consultPreview.skipped} skipped (non-teaching / unmapped)</>}.
              This data will be attached per department when the meeting is created.
            </p>
            {Object.entries(consultPreview.byDept).map(([code, rows]) => (
              <div key={code} className="border border-surface-200 rounded-xl overflow-hidden">
                <div className="bg-surface-50 px-3 py-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-surface-700">{code}</span>
                  <span className="text-[10px] text-surface-400">{rows.length} faculty</span>
                </div>
                <div className="overflow-x-auto max-h-56 overflow-y-auto">
                  <table className="w-full text-[11px] border-collapse">
                    <thead className="bg-white sticky top-0">
                      <tr>{CONSULT_COLUMNS.map(c => <th key={c} className="px-2 py-1.5 text-left font-semibold text-surface-500 border-b border-surface-200 whitespace-nowrap">{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-b border-surface-50 hover:bg-surface-50/50">
                          {CONSULT_COLUMNS.map(c => (
                            <td key={c} className="px-2 py-1 text-surface-700 whitespace-nowrap">{c === 'Conversion Rate' ? `${r[c]}%` : r[c]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-surface-400 text-center py-8">
            {consultConfigured ? 'No mappable consultancy data found.' : 'Consultancy portal not configured.'}
          </p>
        )}
      </Modal>
    </div>
  );
}
