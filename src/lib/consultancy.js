/**
 * Admission Consultancy migration.
 *
 * Reads faculty-wise consultation stats from a SECOND Supabase project (the
 * admissions portal) and formats them into the AGHMS "faculty wise consultation"
 * agenda template — creating one agenda_submission per department so HODs don't
 * have to upload the data manually.
 */
import { createClient } from '@supabase/supabase-js';
import { agendaSubmissionsService } from './services';

const url = import.meta.env.VITE_CONSULT_SUPABASE_URL;
const key = import.meta.env.VITE_CONSULT_SUPABASE_ANON_KEY;

export const consultConfigured = !!(url && key);
const consultClient = consultConfigured
  ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// The AGHMS agenda template this migration targets.
export const CONSULTANCY_TEMPLATE_ID = '955fa47c-39f5-4abf-9a5b-3b18447f97ef';

export function isConsultancyTemplate(t) {
  if (!t) return false;
  return t.id === CONSULTANCY_TEMPLATE_ID || /faculty\s*wise\s*consultation/i.test(t.title || '');
}

// Selectable source datasets in the admissions portal.
export const CONSULT_SOURCES = {
  primary: { table: 'faculty',      label: 'Admission Consultancy' },
  ngpp:    { table: 'ngpp_faculty', label: 'NGPP Consultancy' },
};

// Columns exactly as defined in the AGHMS template's format_schema.
export const CONSULT_COLUMNS = [
  'Faculty Name', 'Total Assigned Students', 'Total Consultancy',
  'Leads Converted', 'Conversion Rate', 'Reward Points',
];

// Map a portal department string → AGHMS department code.
function normalizeDept(raw, departments = []) {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return null;
  const STATIC = {
    'cse': 'CSE', 'computer': 'CSE', 'computer science': 'CSE',
    'it': 'IT', 'information technology': 'IT',
    'mechanical': 'MECH', 'mech': 'MECH',
    'electrical': 'ELE', 'ele': 'ELE',
    'civil': 'CIV', 'civ': 'CIV',
    'chemical': 'CHEM', 'chem': 'CHEM',
    'mba': 'MBA',
    'mscit': 'IMSCIT', 'imscit': 'IMSCIT', 'msc it': 'IMSCIT', 'm.sc. it': 'IMSCIT',
    's&h': 'SCI.HUM', 'sci.hum': 'SCI.HUM', 'science & humanities': 'SCI.HUM', 'science and humanities': 'SCI.HUM',
  };
  if (STATIC[s]) return STATIC[s];
  const byCode = departments.find(d => d.code?.toLowerCase() === s);
  if (byCode) return byCode.code;
  const byName = departments.find(d => d.name && (d.name.toLowerCase().includes(s) || s.includes(d.name.toLowerCase())));
  if (byName) return byName.code;
  return null;
}

/** Fetch raw faculty consultancy rows from the admissions portal. */
export async function fetchConsultancyFaculty(sourceKey = 'primary') {
  if (!consultClient) throw new Error('Consultancy portal is not configured (VITE_CONSULT_SUPABASE_URL / KEY).');
  const table = CONSULT_SOURCES[sourceKey]?.table || 'faculty';
  const { data, error } = await consultClient
    .from(table)
    .select('full_name, department, total_assigned, total_consultations, leads_converted, reward_points');
  if (error) throw error;
  return data || [];
}

/** Group raw faculty rows into template-formatted rows keyed by AGHMS dept code. */
export function groupConsultancyByDept(facultyRows, departments = []) {
  const byDept = {};
  let skipped = 0;
  facultyRows.forEach(f => {
    const code = normalizeDept(f.department, departments);
    if (!code) { skipped += 1; return; }
    const assigned = Number(f.total_assigned) || 0;
    const leads = Number(f.leads_converted) || 0;
    const row = {
      'Faculty Name': f.full_name || '',
      'Total Assigned Students': assigned,
      'Total Consultancy': Number(f.total_consultations) || 0,
      'Leads Converted': leads,
      'Conversion Rate': assigned > 0 ? Math.round((leads / assigned) * 100) : 0,
      'Reward Points': Number(f.reward_points) || 0,
    };
    (byDept[code] = byDept[code] || []).push(row);
  });
  Object.values(byDept).forEach(rows =>
    rows.sort((a, b) => (a['Faculty Name'] || '').localeCompare(b['Faculty Name'] || '')));
  return { byDept, skipped, mapped: facultyRows.length - skipped };
}

/**
 * Fetch → format → attach consultancy data to a meeting as agenda_submissions
 * (one per department). Returns a summary of what was migrated.
 */
export async function migrateConsultancyToMeeting({ meetingId, templateId, departments, sourceKey = 'primary', userId }) {
  const faculty = await fetchConsultancyFaculty(sourceKey);
  const { byDept, skipped } = groupConsultancyByDept(faculty, departments);

  let deptCount = 0;
  let facultyCount = 0;
  for (const code of Object.keys(byDept)) {
    const dept = departments.find(d => d.code === code);
    if (!dept) continue;
    const rows = byDept[code];
    await agendaSubmissionsService.submit({
      meeting_id: meetingId,
      department_id: dept.id,
      agenda_template_id: templateId || CONSULTANCY_TEMPLATE_ID,
      submitted_data: rows,
      file_name: 'Faculty Consultancy (auto-migrated)',
      user_id: userId || null,
    });
    deptCount += 1;
    facultyCount += rows.length;
  }
  return { departments: deptCount, faculty: facultyCount, skipped };
}
