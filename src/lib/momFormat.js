/**
 * Official RNGPIT Minutes-of-Meeting format helpers.
 *
 * The AI (see synthesizeOfficialMOM in ai.js) produces only the *narrative*
 * — opening paragraph, per-agenda Discussion/Resolutions, and the closing note.
 * Everything factual — attendance, header, signatures — is assembled here from
 * real platform data so the MOM mirrors RNGPIT's official document (MoM_Ac_01).
 *
 * The assembled object is stored in meeting_mom.mom_content and rendered both
 * on-screen (MOMPage) and to PDF (momPdf.js).
 */

export const MOM_FORMAT = 'rngpit-official-v1';

// ── Small formatting helpers ────────────────────────────────────────────────

export function ordinal(n) {
  const num = Number(n) || 1;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = num % 100;
  return num + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatLongDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return String(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function weekdayName(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

export function formatTime12h(t) {
  if (!t) return '11:00 AM';
  // t may be "10:00:00" or "10:00"
  const [hRaw, mRaw] = String(t).split(':');
  let h = parseInt(hRaw, 10);
  const m = mRaw ?? '00';
  if (isNaN(h)) return String(t);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

/**
 * Human "Designation" string for the attendance table, mirroring the PDF
 * (e.g. "Head & Chairperson, BoS - B. Tech. CSE dept.").
 */
export function memberDesignation({ role, department_code, department_name, designation } = {}) {
  if (designation && designation.trim()) return designation.trim();
  const deptLabel = department_name || department_code || '';
  switch (role) {
    case 'principal':  return 'Chairperson - Academic Council';
    case 'director':   return 'Director';
    case 'hod':        return deptLabel ? `Head & Chairperson, BoS - ${deptLabel}` : 'Head of Department';
    case 'tpo':        return 'Training & Placement Officer';
    case 'exam_cell':  return 'Controller of Examinations';
    case 'accounts':   return 'Accounts Officer';
    case 'faculty':    return department_code ? `Assistant Professor (${department_code})` : 'Assistant Professor';
    case 'admin':      return 'Member Secretary';
    default:           return role ? role.replace(/_/g, ' ') : 'Member';
  }
}

// ── Attendance roster ───────────────────────────────────────────────────────

/**
 * Build an attendance entry from a platform user record.
 * `present`/`mode`/`source` default to an expected (not-yet-joined) member.
 */
export function attendeeFromUser(u, overrides = {}) {
  return {
    user_id: u.id,
    full_name: u.full_name || 'Unknown',
    role: u.role,
    department_code: u.department?.code || null,
    department_name: u.department?.name || null,
    designation: memberDesignation({
      role: u.role,
      department_code: u.department?.code,
      department_name: u.department?.name,
      designation: u.designation,
    }),
    mode: 'online',
    present: false,
    joined_at: null,
    source: 'auto',
    ...overrides,
  };
}

/**
 * Merge live-presence joiners into an existing roster (by user_id), marking them
 * present/online. Keeps admin edits (present flag / mode / manual rows) intact
 * for anyone not currently present.
 */
export function mergePresence(roster = [], presentUserIds = [], nowIso) {
  const byId = new Map(roster.map(r => [r.user_id, r]));
  presentUserIds.forEach(id => {
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, { ...existing, present: true, joined_at: existing.joined_at || nowIso });
    }
  });
  return Array.from(byId.values());
}

export function splitAttendance(roster = []) {
  const present = roster.filter(r => r.present);
  return {
    presentInPerson: present.filter(r => r.mode === 'in_person'),
    presentOnline:   present.filter(r => r.mode !== 'in_person'),
    absentees:       roster.filter(r => !r.present),
  };
}

// ── MOM assembly ────────────────────────────────────────────────────────────

/**
 * Generate a default reference number in the RNGPIT/acad/<AY>-<n>/ style.
 * Admin can edit it in the MOM editor.
 */
export function defaultRefNo(meeting) {
  const year = meeting?.meeting_date ? new Date(meeting.meeting_date).getFullYear() : new Date().getFullYear();
  const short = (meeting?.id || '').slice(0, 4).toUpperCase();
  return `RNGPIT/acad/${year}-1/${short}`;
}

/**
 * Assemble the full official MOM object from AI narrative + real data.
 *
 * @param {object} p
 * @param {object} p.meeting        - meeting record
 * @param {object} p.narrative      - { openingParagraph, agenda:[{no,title,discussion[],resolutions[]}], concludingNote, departmentBriefs }
 * @param {array}  p.attendance     - attendance roster
 * @param {object} p.chairperson    - { full_name } (defaults to Approved By)
 * @param {object} p.preparedBy     - { full_name, designation }
 * @param {object} [p.config]       - { refNo, meetingNo, meetingType }
 */
export function buildOfficialMOM({ meeting, narrative, attendance = [], chairperson, preparedBy, config = {} }) {
  const { presentInPerson, presentOnline, absentees } = splitAttendance(attendance);
  const meetingNo = config.meetingNo || 1;
  const meetingType = config.meetingType || meeting?.category || 'HOD';

  return {
    format: MOM_FORMAT,
    refNo: config.refNo || defaultRefNo(meeting),
    date: meeting?.meeting_date || null,
    meetingNo,
    meetingType,
    meetingTitle: meeting?.agenda_title || '',
    day: weekdayName(meeting?.meeting_date),
    time: formatTime12h(meeting?.meeting_time),
    venue: meeting?.venue || 'Board Room',
    chairperson: chairperson?.full_name || 'The Chairperson',

    presentInPerson: presentInPerson.map((a, i) => ({ sr: i + 1, name: a.full_name, designation: a.designation })),
    presentOnline:   presentOnline.map((a, i) => ({ sr: i + 1, name: a.full_name, designation: a.designation })),
    absentees:       absentees.map(a => ({ name: a.full_name, note: a.designation })),

    openingParagraph: narrative?.openingParagraph || defaultOpening({ meeting, meetingNo, meetingType, chairperson }),
    agenda: Array.isArray(narrative?.agenda) ? narrative.agenda : [],
    concludingNote: narrative?.concludingNote ||
      'The meeting concluded with a vote of thanks to all the members by the Member Secretary.',
    departmentBriefs: narrative?.departmentBriefs || {},

    preparedBy: {
      name: preparedBy?.full_name || 'Member Secretary',
      designation: preparedBy?.designation || 'Member Secretary',
    },
    approvedBy: {
      name: chairperson?.full_name || 'The Chairperson',
      designation: 'Chairperson',
    },

    generatedAt: new Date().toISOString(),
  };
}

export function defaultOpening({ meeting, meetingNo, meetingType, chairperson }) {
  return `${ordinal(meetingNo)} ${meetingType} meeting of R. N. G. Patel Institute of Technology - RNGPIT was held on ` +
    `${formatLongDate(meeting?.meeting_date)} (${weekdayName(meeting?.meeting_date)}) at ${formatTime12h(meeting?.meeting_time)} ` +
    `at ${meeting?.venue || 'Board Room'} under the chairmanship of ${chairperson?.full_name || 'the Chairperson'}. ` +
    `The following agenda were discussed during the meeting.`;
}

export function isOfficialMOM(momRow) {
  const c = momRow?.mom_content;
  return !!c && !Array.isArray(c) && c.format === MOM_FORMAT;
}
