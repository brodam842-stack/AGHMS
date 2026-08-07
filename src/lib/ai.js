/**
 * AI Service — OpenRouter via Supabase Edge Function Proxy
 *
 * Browser → Supabase Edge Function (openrouter-proxy) → OpenRouter API
 * This keeps the OpenRouter API key server-side and avoids browser CORS issues.
 *
 * Config:
 *   VITE_OPENROUTER_MODEL   — model slug (defaults to the free Nemotron Nano)
 *   OPENROUTER_API_KEY      — set as a Supabase Edge Function secret (NOT a VITE_ var)
 */

import { formatDMYTime, formatCellValue } from './dateFormat';

const PROXY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/openrouter-proxy`;
const DEFAULT_MODEL = import.meta.env.VITE_OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-30b-a3b:free';

/**
 * Core: Call OpenRouter through the Supabase proxy.
 * @param {object[]} messages - OpenAI-style messages array
 * @param {number} temperature
 * @returns {Promise<string>} - The AI response text
 */
async function callAI(messages, temperature = 0.5) {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: '/chat/completions',
      payload: {
        model: DEFAULT_MODEL,
        messages,
        temperature,
        // Nemotron Nano is a reasoning model — it spends output tokens "thinking"
        // before the final answer, so give enough headroom that JSON responses
        // (live dashboard / MOM synthesis) aren't truncated mid-object.
        max_tokens: 4096,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from OpenRouter');
  return text;
}

/**
 * Robustly extract a JSON object/array from a model response.
 * Handles ```json fences and any leading/trailing prose the model may add.
 */
function stripToJson(content) {
  let s = content.replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return s;
  const openChar = s[start];
  const closeChar = openChar === '{' ? '}' : ']';
  const end = s.lastIndexOf(closeChar);
  if (end > start) return s.slice(start, end + 1);
  return s.slice(start);
}

/**
 * Compiles all department agenda submissions into a single markdown string.
 */
export function compileMeetingData(submissions, departments) {
  if (!submissions || submissions.length === 0) {
    return 'No data has been uploaded by the departments for this meeting yet.';
  }

  let text = '# Compiled Department Submissions Data\n\n';

  submissions.forEach(sub => {
    const dept = departments?.find(d => d.id === sub.department_id);
    const deptName = dept ? `${dept.code} - ${dept.name}` : 'Unknown Department';

    text += `## Department: ${deptName}\n`;
    text += `Submitted File Name: ${sub.file_name || 'Manual Spreadsheet Entry'}\n`;
    text += `Submission Date: ${sub.created_at ? formatDMYTime(sub.created_at) : 'N/A'}\n\n`;

    const rows = Array.isArray(sub.submitted_data) ? sub.submitted_data : [];
    // Column order comes from the template when one is linked; otherwise take
    // the union of every row's keys, so rows with extra or missing fields don't
    // shift the markdown table out of alignment.
    const schemaCols = sub.agenda_template?.format_schema?.columns || [];
    const headers = schemaCols.length
      ? schemaCols.map(c => c.name)
      : [...new Set(rows.flatMap(r => Object.keys(r || {})))];
    const typeOf = Object.fromEntries(schemaCols.map(c => [c.name, c.type]));

    if (rows.length > 0 && headers.length > 0) {
      const escape = (v) => String(v ?? '').replace(/\|/g, '\\|');
      text += '| ' + headers.map(escape).join(' | ') + ' |\n';
      text += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
      rows.forEach(row => {
        text += '| ' + headers.map(h => escape(formatCellValue(row?.[h], typeOf[h]))).join(' | ') + ' |\n';
      });
      text += '\n';
    } else {
      text += 'No structured table data provided.\n\n';
    }
  });

  return text;
}

/**
 * Uses OpenRouter to generate meeting summary, structured statistics, and Recharts visuals.
 */
export async function generateLiveDashboard(compiledText) {
  const prompt = `You are a high-level educational governance analyst. You are provided with the compiled agenda submissions data uploaded by department HODs for a meeting:
  
  ${compiledText}
  
  Please analyze this data and return a JSON object with:
  1. "executiveSummary": A concise 2-3 sentence overview of what the data represents.
  2. "kpis": An array of KPI objects: [{ "label": "KPI Name", "value": "Number/Percentage", "change": "positive or negative or neutral statement" }] (Extract at least 3-4 KPIs from the data like attendance, fees payment, weak students count, or lab evaluation completed).
  3. "visuals": An array of visual chart objects. Each visual chart object must have:
     - "type": either "bar" or "line" or "pie"
     - "title": "Chart Title"
     - "data": An array of objects for Recharts: e.g. [{ "name": "CSE", "value": 85 }] or [{ "name": "Odd Sem", "paid": 120000, "balance": 40000 }]
     - "keys": Array of data keys to display (e.g. ["value"] or ["paid", "balance"])
  
  Provide strictly a raw, valid JSON object. Do not include markdown code block formatting like \`\`\`json. Return only the JSON content.`;

  try {
    const content = await callAI([{ role: 'user', content: prompt }], 0.1);
    const cleaned = stripToJson(content);
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to generate Live AI Dashboard:', err);
    return {
      executiveSummary: 'AI was unable to synthesize the uploaded data at this moment. Displaying temporary metrics.',
      kpis: [
        { label: 'Total Uploaded Sheets', value: '4 Departments', change: 'Neutral status' },
        { label: 'Data Ingestion Status', value: 'Ready', change: 'Awaiting conclusion' },
      ],
      visuals: [],
    };
  }
}

/**
 * Handles chatbot questions inside the live meeting workspace.
 */
export async function askMeetingChatbot(compiledText, chatHistory, userQuestion) {
  const messages = [
    {
      role: 'system',
      content: `You are the AGHMS AI Assistant inside a live administrative meeting workspace for a college.
      Here is the complete compiled spreadsheet data uploaded by the departments for this meeting:
      
      ${compiledText}
      
      Use this data to answer any questions accurately and professionally. Cite specific numbers and departments. If the data does not contain the information requested, state that clearly.

      FORMATTING RULES — always respond in clean GitHub-flavored Markdown:
      - Use "## " headings to separate sections when helpful.
      - Use **bold** for key figures, names, and departments.
      - Use "- " bullet lists for enumerations and short points.
      - Whenever you present comparative, ranked, or multi-column data, render it as a Markdown table with a header row and a "| --- | --- |" separator row (e.g. | Department | Value |). Keep tables tight and readable.
      - Do not wrap the whole answer in a code block.`,
    },
  ];

  chatHistory?.forEach(h => messages.push({ role: h.role, content: h.content }));
  messages.push({ role: 'user', content: userQuestion });

  try {
    return await callAI(messages, 0.7);
  } catch (err) {
    console.error('AI Chatbot error:', err?.message || err);
    const reason = err?.message?.includes('401') ? 'Invalid API key — check Supabase secrets.'
      : err?.message?.includes('404') ? 'Model not found on OpenRouter.'
      : err?.message?.includes('429') ? 'Rate limit reached — try again shortly.'
      : (err?.message || 'Proxy connection error');
    return `❌ AI Error: ${reason}`;
  }
}

/**
 * Synthesizes post-meeting MOM documents and department briefs.
 * @param {string|object} notesInput - Plain string (legacy) OR isolated JSON { admin: '...', CSE: '...' }
 * @param {string} compiledText - The compiled spreadsheet data markdown
 */
export async function synthesizePostMeetingNotes(notesInput, compiledText) {
  let notesSection = '';
  if (typeof notesInput === 'object' && notesInput !== null) {
    const adminNote = notesInput.admin || '';
    const deptKeys  = Object.keys(notesInput).filter(k => k !== 'admin');
    notesSection += `Admin Notes:\n${adminNote || '(No admin notes taken)'}\n\n`;
    if (deptKeys.length > 0) {
      notesSection += `Department HOD Notes (by department):\n`;
      deptKeys.forEach(dept => {
        notesSection += `\n--- ${dept} Department HOD Notes ---\n${notesInput[dept] || '(No notes)'}\n`;
      });
    }
  } else {
    notesSection = notesInput || 'No notes were taken during the meeting.';
  }

  const prompt = `You are the AGHMS Governance AI. The HOD meeting has concluded.
  Here are the notes taken during the live meeting (organized by participant role):
  
  ${notesSection}
  
  And here is the compiled data uploaded by departments for this meeting:
  
  ${compiledText}
  
  Please synthesize this information into:
  1. **Admin Note**: An executive narrative summary of what transpired, decisions made, operational directions, and next steps. Reference specific data points from the uploaded sheets and highlight key action items.
  2. **Department Briefs**: Tailored, department-specific instructions and action points. For each department represented in the data or notes, provide a clear, concise bulleted list of actions they must complete.
  
  Provide the response as a JSON object:
  {
    "adminNote": "Markdown text for admin MOM summary",
    "departmentBriefs": {
      "DEPT_CODE_1": "Markdown text with actionable items for Dept 1",
      "DEPT_CODE_2": "Markdown text with actionable items for Dept 2"
    }
  }
  
  Make the markdown notes professional using bold headers and clean lists.
  Provide strictly raw, valid JSON. Do not write markdown code block tags.`;

  try {
    const content = await callAI([{ role: 'user', content: prompt }], 0.2);
    const cleaned = stripToJson(content);
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to synthesize post-meeting MOM notes:', err);
    return {
      adminNote: 'The meeting concluded successfully. Summary notes will be prepared by the administrative office shortly.',
      departmentBriefs: {},
    };
  }
}

/**
 * Synthesize an OFFICIAL RNGPIT-format MOM narrative from the real meeting inputs.
 *
 * The AI produces ONLY narrative content (attendance / header / signatures are
 * assembled from platform data in momFormat.js). It is grounded in:
 *   - the actual agenda items (the topics that were on the table)
 *   - the compiled department submissions (the data faculties provided)
 *   - the live notes taken by the admin and each HOD during the meeting
 *
 * @param {object} p
 * @param {object} p.meeting       - { agenda_title, meeting_date, venue, category }
 * @param {array}  p.agendaItems   - [{ order_number, title, description, category }]
 * @param {string} p.compiledText  - compiled department submissions (compileMeetingData)
 * @param {object|string} p.notesInput - isolated notes JSON { admin, CSE, ... } or string
 * @param {string[]} p.deptCodes   - department codes present (for departmentBriefs)
 * @returns {Promise<{openingParagraph, agenda, concludingNote, departmentBriefs}>}
 */
export async function synthesizeOfficialMOM({ meeting, agendaItems = [], compiledText = '', notesInput = {}, deptCodes = [] }) {
  // Flatten notes
  let notesSection = '';
  if (typeof notesInput === 'object' && notesInput !== null) {
    notesSection += `Admin/Chair notes:\n${notesInput.admin || '(none)'}\n`;
    Object.keys(notesInput).filter(k => k !== 'admin').forEach(dept => {
      notesSection += `\n${dept} HOD notes:\n${notesInput[dept] || '(none)'}\n`;
    });
  } else {
    notesSection = notesInput || '(No notes taken)';
  }

  const agendaList = (agendaItems || [])
    .slice()
    .sort((a, b) => (a.order_number || 0) - (b.order_number || 0))
    .map((it, i) => `${i + 1}. ${it.title}${it.description ? ` — ${it.description}` : ''}`)
    .join('\n') || '(No formal agenda items were recorded — infer the agenda from the notes and data.)';

  const prompt = `You are the Member Secretary of R. N. G. Patel Institute of Technology (RNGPIT) drafting the OFFICIAL Minutes of Meeting.
Write in a formal, third-person, institutional tone. Base EVERYTHING strictly on the inputs — do not invent people, numbers or decisions that are not supported by the agenda, notes, or data. Cite concrete figures/departments from the data where relevant.

MEETING: "${meeting?.agenda_title || 'Meeting'}" held at ${meeting?.venue || 'Board Room'} on ${meeting?.meeting_date || ''}.

AGENDA ITEMS (the topics on the table):
${agendaList}

LIVE NOTES TAKEN DURING THE MEETING (organized by participant):
${notesSection}

COMPILED DATA SUBMITTED BY DEPARTMENTS:
${compiledText}

Produce a JSON object EXACTLY in this shape:
{
  "openingParagraph": "One formal paragraph: which meeting, institute, date, venue, chairmanship, and 'The following agenda were discussed during the meeting.' (Do NOT list attendees here.)",
  "agenda": [
    {
      "no": 1,
      "title": "Concise formal agenda title",
      "discussion": ["Formal bullet point summarizing what was discussed", "Another point grounded in the notes/data"],
      "resolutions": ["Formal resolution/decision taken, e.g. 'The council approved ...'"]
    }
  ],
  "concludingNote": "One closing sentence, e.g. 'The meeting concluded with a vote of thanks to all members by the Member Secretary.'",
  "departmentBriefs": {
    ${deptCodes.map(c => `"${c}": "Markdown bullet list of action points for ${c}"`).join(',\n    ') || '"GENERAL": "Markdown action points"'}
  }
}

Rules:
- One "agenda" entry per agenda item above (keep the same order). If an item had no real discussion, still include it with a brief factual discussion and, if applicable, a resolution.
- "discussion" and "resolutions" are arrays of short formal sentences (strings). "resolutions" may be an empty array if no decision was taken.
- Keep it professional and specific. Return STRICT raw JSON only, no markdown code fences.`;

  try {
    const content = await callAI([{ role: 'user', content: prompt }], 0.2);
    const parsed = JSON.parse(stripToJson(content));
    // Normalize agenda entries
    parsed.agenda = (parsed.agenda || []).map((a, i) => ({
      no: a.no || i + 1,
      title: a.title || `Agenda Item ${i + 1}`,
      discussion: Array.isArray(a.discussion) ? a.discussion.filter(Boolean) : (a.discussion ? [String(a.discussion)] : []),
      resolutions: Array.isArray(a.resolutions) ? a.resolutions.filter(Boolean) : (a.resolutions ? [String(a.resolutions)] : []),
    }));
    return parsed;
  } catch (err) {
    console.error('Failed to synthesize official MOM:', err);
    // Graceful fallback: build a minimal narrative straight from the agenda items
    return {
      openingParagraph: '',
      agenda: (agendaItems || []).map((it, i) => ({
        no: i + 1,
        title: it.title || `Agenda Item ${i + 1}`,
        discussion: [it.description || 'The item was discussed by the members.'],
        resolutions: [],
      })),
      concludingNote: 'The meeting concluded with a vote of thanks to all the members by the Member Secretary.',
      departmentBriefs: {},
    };
  }
}
