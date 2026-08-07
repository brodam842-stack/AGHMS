/**
 * Lightweight Markdown block parser — shared by the on-screen renderer
 * (components/ui/Markdown.jsx) and the PDF exporter (lib/pdfMarkdown.js).
 *
 * Supports: headings (#..######), paragraphs, ordered/unordered lists,
 * blockquotes, horizontal rules, GFM pipe tables, and inline **bold** /
 * *italic* / `code` / ~~strike~~.
 */

const isTableSep = (s) =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s);

const splitRow = (s) => {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
};

const isSpecial = (t, lines, i) =>
  /^(#{1,6})\s+/.test(t) ||
  /^[-*+]\s+/.test(t) ||
  /^\d+[.)]\s+/.test(t) ||
  /^>\s?/.test(t) ||
  /^(-{3,}|_{3,}|\*{3,})$/.test(t) ||
  (t.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]));

export function parseMarkdownBlocks(md) {
  if (!md || typeof md !== 'string') return [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) { i++; continue; }

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) { blocks.push({ type: 'hr' }); i++; continue; }

    // Table (row followed by a --- separator line)
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(trimmed);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        if (isTableSep(lines[i])) { i++; continue; }
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Heading
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue; }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: items.join(' ') });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Paragraph — gather consecutive plain lines
    const para = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || isSpecial(t, lines, i)) break;
      para.push(t);
      i++;
    }
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ') });
  }

  return blocks;
}

/** Strip inline markdown to plain text (used by the PDF exporter). */
export function stripInline(text) {
  return String(text ?? '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .trim();
}

/** Parse inline markdown into typed segments for React rendering. */
export function parseInline(text) {
  const src = String(text ?? '');
  const segments = [];
  const regex = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|~~([^~]+)~~)/g;
  let last = 0;
  let m;
  while ((m = regex.exec(src)) !== null) {
    if (m.index > last) segments.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[2] !== undefined || m[3] !== undefined) segments.push({ t: 'bold', v: m[2] ?? m[3] });
    else if (m[4] !== undefined || m[5] !== undefined) segments.push({ t: 'italic', v: m[4] ?? m[5] });
    else if (m[6] !== undefined) segments.push({ t: 'code', v: m[6] });
    else if (m[7] !== undefined) segments.push({ t: 'strike', v: m[7] });
    last = regex.lastIndex;
  }
  if (last < src.length) segments.push({ t: 'text', v: src.slice(last) });
  return segments;
}
