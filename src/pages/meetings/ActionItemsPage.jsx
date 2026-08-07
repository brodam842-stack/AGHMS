import { useState } from 'react';
import { CheckSquare, AlertTriangle, TrendingUp, Plus, CheckCircle2, UserCheck, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { useActionItems, useUpdateActionStatus, useAddAtrUpdate, useCreateActionItem, useUsers } from '../../hooks/useData';
import { useAuth } from '../../contexts/AuthContext';
import { notificationsService } from '../../lib/services';
import { emailService } from '../../lib/emailService';
import { supabase } from '../../lib/supabase';
import { PageHeader, Modal, FormField, ProgressBar, SearchBar, Spinner } from '../../components/ui/index';
import { formatDate } from '../../lib/supabaseHelpers';
import { ROLE_LABELS } from '../../lib/constants';

const STATUS_LABELS = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed', delayed: 'Delayed' };
const STATUS_STYLES = { pending: 'badge-surface', in_progress: 'badge-primary', completed: 'badge-success', delayed: 'badge-danger' };
const todayStr = () => new Date().toISOString().split('T')[0];

async function fetchAdmins() {
  const { data } = await supabase
    .from('users')
    .select('id')
    .in('role', ['admin', 'director', 'principal'])
    .eq('is_active', true);
  return data || [];
}

export default function ActionItemsPage() {
  const { user, profile, isHOD, canApprove } = useAuth();
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');

  // Update / progress modal
  const [selectedItem, setSelectedItem] = useState(null);
  const [updateModal, setUpdateModal] = useState(false);
  const [updateText, setUpdateText] = useState('');
  const [newPct, setNewPct] = useState(0);
  const [newStatus, setNewStatus] = useState('');
  const [saving, setSaving] = useState(false);

  // Assign modal (admin → HOD)
  const [assignModal, setAssignModal] = useState(false);
  const [assignDesc, setAssignDesc] = useState('');
  const [assignHodId, setAssignHodId] = useState('');
  const [assignDeadline, setAssignDeadline] = useState('');
  const [assigning, setAssigning] = useState(false);

  const { data: realData = [], isLoading } = useActionItems({});
  const { data: allUsers = [] } = useUsers({});
  const updateStatus = useUpdateActionStatus();
  const addUpdate    = useAddAtrUpdate();
  const createAction = useCreateActionItem();

  // Assignable department heads — HODs and faculty who belong to a department.
  const assignees = allUsers
    .filter(u => ['hod', 'faculty'].includes(u.role) && u.department_id)
    .sort((a, b) =>
      (a.department?.code || '').localeCompare(b.department?.code || '') ||
      (a.full_name || '').localeCompare(b.full_name || ''));

  // HODs only see tasks assigned to them (or their department); admins see all.
  const items = canApprove
    ? realData
    : realData.filter(i =>
        i.assigned_to_user_id === user?.id ||
        (profile?.department_id && i.assigned_to_department_id === profile.department_id));

  const filtered = items.filter(i => {
    const matchSearch = i.description.toLowerCase().includes(search.toLowerCase()) ||
                        i.assigned_dept?.code?.toLowerCase().includes(search.toLowerCase()) ||
                        i.assigned_user?.full_name?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || i.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const counts = {
    all:         items.length,
    pending:     items.filter(i => i.status === 'pending').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    completed:   items.filter(i => i.status === 'completed').length,
    delayed:     items.filter(i => i.status === 'delayed').length,
  };

  const openUpdate = (item) => {
    setSelectedItem(item);
    setNewPct(item.completion_percentage || 0);
    setNewStatus(item.status);
    setUpdateText('');
    setUpdateModal(true);
  };

  const notifyAdminsOfCompletion = async (item) => {
    const admins = await fetchAdmins();
    if (!admins.length) return;
    const deptCode = item.assigned_dept?.code || profile?.department?.code || '';
    const who = item.assigned_user?.full_name || profile?.full_name || deptCode || 'A department';
    await notificationsService.bulkCreate(admins.map(a => ({
      user_id: a.id,
      notification_type: 'action_item',
      title: 'Task Completed ✅',
      message: `${who}${deptCode ? ` (${deptCode})` : ''} marked the task "${item.description}" as completed.`,
      priority: 'medium',
      read_status: false,
      action_url: '/meetings/action-items',
      created_at: new Date().toISOString(),
    })));
  };

  const handleUpdate = async () => {
    setSaving(true);
    try {
      const wasCompleted = selectedItem.status === 'completed';
      await updateStatus.mutateAsync({ id: selectedItem.id, status: newStatus, pct: newPct });
      if (updateText) {
        await addUpdate.mutateAsync({
          action_item_id: selectedItem.id,
          progress_description: updateText,
          updated_by: user?.id,
          update_date: todayStr(),
        });
      }
      // Notify admins the moment a task transitions into "completed"
      if (newStatus === 'completed' && !wasCompleted) {
        await notifyAdminsOfCompletion(selectedItem);
      }
      toast.success('Action item updated');
      setUpdateModal(false);
    } catch (err) { toast.error(err.message || 'Update failed'); }
    finally { setSaving(false); }
  };

  // One-click completion for the HOD who owns the task
  const handleQuickComplete = async (item) => {
    try {
      await updateStatus.mutateAsync({ id: item.id, status: 'completed', pct: 100 });
      await notifyAdminsOfCompletion(item);
      toast.success('Marked as completed — administrators have been notified.');
    } catch (err) { toast.error(err.message || 'Could not update task'); }
  };

  const handleAssign = async () => {
    if (!assignDesc.trim()) return toast.error('Enter a task description');
    if (!assignHodId)       return toast.error('Select a person to assign the task to');
    setAssigning(true);
    try {
      const hod = assignees.find(h => h.id === assignHodId);
      await createAction.mutateAsync({
        description: assignDesc.trim(),
        assigned_to_user_id: hod.id,
        assigned_to_department_id: hod.department_id || hod.department?.id || null,
        deadline: assignDeadline || null,
        status: 'pending',
        completion_percentage: 0,
      });

      // In-app notification to the HOD
      await notificationsService.create({
        user_id: hod.id,
        notification_type: 'action_item',
        title: 'New Task Assigned 📌',
        message: `You have been assigned a task: "${assignDesc.trim()}"${assignDeadline ? ` — due ${formatDate(assignDeadline)}` : ''}.`,
        priority: 'high',
        read_status: false,
        action_url: '/meetings/action-items',
        created_at: new Date().toISOString(),
      });

      // Email (best-effort, non-blocking)
      emailService.actionItemAssigned({
        description: assignDesc.trim(),
        deadline: assignDeadline || null,
        assigned_user_id: hod.id,
        meeting: { agenda_title: 'Direct Task Assignment' },
      });

      toast.success(`Task assigned to ${hod.full_name} — HOD notified.`);
      setAssignModal(false);
      setAssignDesc(''); setAssignHodId(''); setAssignDeadline('');
    } catch (err) { toast.error(err.message || 'Failed to assign task'); }
    finally { setAssigning(false); }
  };

  const today = new Date();
  const isOverdue = (item) => item.status !== 'completed' && item.deadline && new Date(item.deadline) < today;
  const ownedByMe = (item) =>
    item.assigned_to_user_id === user?.id ||
    (profile?.department_id && item.assigned_to_department_id === profile.department_id);

  return (
    <div className="page-wrapper">
      <PageHeader
        title="Action Items / ATR"
        subtitle={canApprove
          ? 'Assign tasks to department HODs and track completion'
          : 'Tasks assigned to you and your department'}
        actions={
          canApprove && (
            <button onClick={() => setAssignModal(true)} className="btn-primary text-sm">
              <Plus size={14} /> Assign Task
            </button>
          )
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Actions', value: counts.all, icon: CheckSquare, color: 'bg-primary-50 border-primary-100 text-primary-600' },
          { label: 'In Progress',   value: counts.in_progress, icon: TrendingUp, color: 'bg-blue-50 border-blue-100 text-blue-600' },
          { label: 'Completed',     value: counts.completed, icon: CheckCircle2, color: 'bg-success-50 border-success-100 text-success-600' },
          { label: 'Delayed',       value: counts.delayed, icon: AlertTriangle, color: 'bg-danger-50 border-danger-100 text-danger-600' },
        ].map(kpi => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="kpi-card">
              <div className={`p-2.5 rounded-xl border w-fit ${kpi.color}`}><Icon size={20} /></div>
              <p className="text-2xl font-bold text-surface-900">{kpi.value}</p>
              <p className="text-sm text-surface-600">{kpi.label}</p>
            </div>
          );
        })}
      </div>

      {/* Search + Filter */}
      <SearchBar value={search} onChange={setSearch} placeholder="Search by description, department, person…">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="w-auto text-sm">
          <option value="all">All Status ({counts.all})</option>
          <option value="pending">Pending ({counts.pending})</option>
          <option value="in_progress">In Progress ({counts.in_progress})</option>
          <option value="completed">Completed ({counts.completed})</option>
          <option value="delayed">Delayed ({counts.delayed})</option>
        </select>
      </SearchBar>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Action Item</th>
                <th>Source</th>
                <th>Assigned To</th>
                <th>Deadline</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-12 text-surface-400">Loading action items…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-12 text-surface-400">
                  {canApprove ? 'No action items yet. Use “Assign Task” to delegate work to an HOD.' : 'No tasks assigned to you yet.'}
                </td></tr>
              )}
              {filtered.map(item => (
                <tr key={item.id} className={isOverdue(item) ? 'bg-danger-50/30' : ''}>
                  <td className="max-w-xs">
                    <p className="text-sm font-medium text-surface-800 line-clamp-2">{item.description}</p>
                    {isOverdue(item) && <span className="badge-danger text-[10px] mt-1">Overdue</span>}
                    {item.atr_updates?.length > 0 && (
                      <p className="text-xs text-surface-400 mt-1">
                        Last update: {item.atr_updates.at(-1)?.progress_description?.slice(0, 40)}…
                      </p>
                    )}
                  </td>
                  <td>
                    {item.meeting?.agenda_title ? (
                      <>
                        <p className="text-xs font-medium text-surface-700 line-clamp-1">{item.meeting.agenda_title}</p>
                        <p className="text-xs text-surface-400">{formatDate(item.meeting?.meeting_date)}</p>
                      </>
                    ) : (
                      <span className="badge-surface text-[10px]">Direct Assignment</span>
                    )}
                  </td>
                  <td>
                    <p className="text-sm font-medium">{item.assigned_dept?.code || '—'}</p>
                    <p className="text-xs text-surface-400">{item.assigned_user?.full_name || '—'}</p>
                  </td>
                  <td>
                    <span className={`text-sm font-medium ${isOverdue(item) ? 'text-danger-600' : 'text-surface-700'}`}>
                      {item.deadline ? formatDate(item.deadline) : '—'}
                    </span>
                  </td>
                  <td className="min-w-[120px]">
                    <ProgressBar value={item.completion_percentage || 0} />
                  </td>
                  <td>
                    <span className={`badge ${STATUS_STYLES[item.status]}`}>{STATUS_LABELS[item.status]}</span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      {isHOD && ownedByMe(item) && item.status !== 'completed' && (
                        <button
                          onClick={() => handleQuickComplete(item)}
                          className="btn-success text-xs px-2.5 py-1"
                          title="Mark this task as completed"
                        >
                          <CheckCircle2 size={13} /> Complete
                        </button>
                      )}
                      <button onClick={() => openUpdate(item)} className="btn-ghost text-xs">Update</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Assign Task Modal (admin) ─────────────────────────────────────── */}
      <Modal
        open={assignModal}
        onClose={() => !assigning && setAssignModal(false)}
        title="Assign Task to HOD"
        footer={
          <>
            <button onClick={() => setAssignModal(false)} disabled={assigning} className="btn-secondary">Cancel</button>
            <button onClick={handleAssign} disabled={assigning} className="btn-primary">
              {assigning ? <Spinner size={14} className="border-t-white border-white/30" /> : <Send size={14} />}
              Assign & Notify
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="alert-info text-xs">
            <UserCheck size={16} />
            The selected HOD is notified instantly on the web app (and by email). They mark it complete once done, which notifies you back.
          </div>
          <FormField label="Task Description" required>
            <textarea
              rows={3}
              value={assignDesc}
              onChange={e => setAssignDesc(e.target.value)}
              placeholder="e.g. Submit CO attainment data for all 6th-sem subjects"
              className="text-sm"
            />
          </FormField>
          <FormField label="Assign to Department Head" required hint={assignees.length === 0 ? 'No department staff found — add users with a department in Admin → Users.' : 'Department heads / faculty who lead a department'}>
            <select value={assignHodId} onChange={e => setAssignHodId(e.target.value)} className="text-sm">
              <option value="">-- Select a person --</option>
              {assignees.map(h => (
                <option key={h.id} value={h.id}>
                  {h.full_name}{h.department?.code ? ` — ${h.department.code}` : ''} ({ROLE_LABELS[h.role] || h.role})
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Deadline">
            <input type="date" min={todayStr()} value={assignDeadline} onChange={e => setAssignDeadline(e.target.value)} className="text-sm" />
          </FormField>
        </div>
      </Modal>

      {/* ── Update / Progress Modal ───────────────────────────────────────── */}
      <Modal
        open={updateModal}
        onClose={() => setUpdateModal(false)}
        title={isHOD && !canApprove ? 'Update My Task' : 'Update Action Item'}
        footer={
          <>
            <button onClick={() => setUpdateModal(false)} className="btn-secondary">Cancel</button>
            <button onClick={handleUpdate} disabled={saving} className="btn-primary">
              {saving ? <Spinner size={14} className="border-t-white border-white/30" /> : null}
              Save Update
            </button>
          </>
        }
      >
        {selectedItem && (
          <div className="space-y-4">
            <div className="p-3 bg-surface-50 rounded-xl">
              <p className="text-sm font-medium text-surface-800">{selectedItem.description}</p>
              <p className="text-xs text-surface-400 mt-1">
                {selectedItem.assigned_dept?.name || selectedItem.assigned_user?.full_name || 'Unassigned'}
                {selectedItem.deadline ? ` · Due ${formatDate(selectedItem.deadline)}` : ''}
              </p>
            </div>
            <FormField label="Status">
              <select value={newStatus} onChange={e => setNewStatus(e.target.value)} className="text-sm">
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="delayed">Delayed</option>
              </select>
            </FormField>
            <FormField label={`Completion: ${newPct}%`}>
              <input type="range" min={0} max={100} step={5}
                     value={newPct} onChange={e => setNewPct(Number(e.target.value))} className="w-full" />
              <div className="flex justify-between text-[10px] text-surface-400 mt-1">
                <span>0%</span><span>50%</span><span>100%</span>
              </div>
            </FormField>
            <FormField label="Progress Update" hint="Describe what was done or what obstacles exist">
              <textarea
                rows={3}
                value={updateText}
                onChange={e => setUpdateText(e.target.value)}
                placeholder="e.g. CO data submitted for 4 of 6 subjects…"
                className="text-sm"
              />
            </FormField>
            {selectedItem.atr_updates?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-surface-500 mb-2">Previous Updates</p>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {selectedItem.atr_updates.map(u => (
                    <div key={u.id} className="p-2 bg-surface-50 rounded-lg">
                      <p className="text-xs text-surface-700">{u.progress_description}</p>
                      <p className="text-[10px] text-surface-400 mt-0.5">{formatDate(u.created_at)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
