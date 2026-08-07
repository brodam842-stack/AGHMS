/**
 * Render a Markdown string into a jsPDF document — headings, paragraphs,
 * lists, blockquotes, rules, and real drawn tables (with wrapping, zebra
 * striping, borders, and automatic page breaks).
 *
 * Returns the new Y cursor so callers can keep laying out content below.
 *
 *   let y = renderMarkdownToPdf(doc, markdownString, { x, y, maxWidth, bottom });
 */
import { parseMarkdownBlocks, stripInline } from './markdown.js';

const COLORS = {
  heading: [30, 41, 59],   // slate-800
  body:    [51, 65, 85],   // slate-700
  muted:   [100, 116, 139],// slate-500
  line:    [226, 232, 240],// slate-200
  headBg:  [241, 245, 249],// slate-100
  headBd:  [203, 213, 225],// slate-300
  zebra:   [248, 250, 252],// slate-50
};

function pageWidth(doc)  { return doc.internal.pageSize.getWidth ? doc.internal.pageSize.getWidth()  : doc.internal.pageSize.width; }
function pageHeight(doc) { return doc.internal.pageSize.getHeight ? doc.internal.pageSize.getHeight() : doc.internal.pageSize.height; }

function drawTable(doc, block, ctx) {
  const { x, maxWidth, bottom, margin, onNewPage } = ctx;
  let y = ctx.y;

  const headers = (block.headers || []).map(stripInline);
  const colCount = Math.max(headers.length, 1);
  const rows = (block.rows || []).map((r) => {
    const out = [];
    for (let c = 0; c < colCount; c++) out.push(stripInline(r[c] ?? ''));
    return out;
  });

  // Column widths proportional to content length, with a sane minimum.
  const contentLens = headers.map((h, c) => {
    let len = (h || '').length;
    rows.forEach((r) => { len = Math.max(len, (r[c] || '').length); });
    return Math.max(len, 3);
  });
  const totalLen = contentLens.reduce((a, b) => a + b, 0) || 1;
  const minW = Math.min(18, maxWidth / colCount);
  let colWidths = contentLens.map((l) => Math.max((l / totalLen) * maxWidth, minW));
  const wsum = colWidths.reduce((a, b) => a + b, 0);
  colWidths = colWidths.map((w) => (w * maxWidth) / wsum);

  const padX = 2, padY = 1.8, fontSize = 8.5, lineH = 3.6;

  const wrap = (cells) => {
    doc.setFontSize(fontSize);
    return cells.map((cell, c) => doc.splitTextToSize(String(cell), colWidths[c] - padX * 2));
  };
  const rowHeight = (wrapped) => Math.max(...wrapped.map((w) => w.length), 1) * lineH + padY * 2;

  const paintRow = (wrapped, rowH, { header = false, zebra = false } = {}) => {
    if (header) { doc.setFillColor(...COLORS.headBg); doc.rect(x, y, maxWidth, rowH, 'F'); }
    else if (zebra) { doc.setFillColor(...COLORS.zebra); doc.rect(x, y, maxWidth, rowH, 'F'); }

    doc.setFont('Helvetica', header ? 'bold' : 'normal');
    doc.setFontSize(fontSize);
    doc.setTextColor(...(header ? COLORS.heading : COLORS.body));

    let cx = x;
    wrapped.forEach((cellLines, c) => {
      let ty = y + padY + lineH - 0.8;
      cellLines.forEach((ln) => { doc.text(ln, cx + padX, ty); ty += lineH; });
      cx += colWidths[c];
    });

    // Borders: vertical column rules + bottom edge
    doc.setDrawColor(...(header ? COLORS.headBd : COLORS.line));
    let bx = x;
    for (let c = 0; c <= colCount; c++) {
      doc.line(bx, y, bx, y + rowH);
      if (c < colCount) bx += colWidths[c];
    }
    doc.line(x, y + rowH, x + maxWidth, y + rowH);
    if (header) doc.line(x, y, x + maxWidth, y); // top edge of table
    y += rowH;
  };

  const newPage = () => {
    doc.addPage();
    y = onNewPage ? (onNewPage(doc) ?? margin) : margin;
  };

  // Header (keep with at least one row where possible)
  const headerWrapped = wrap(headers);
  const headerH = rowHeight(headerWrapped);
  if (y + headerH + 6 > bottom) newPage();
  paintRow(headerWrapped, headerH, { header: true });

  rows.forEach((cells, ri) => {
    const wrapped = wrap(cells);
    const rowH = rowHeight(wrapped);
    if (y + rowH > bottom) {
      newPage();
      paintRow(headerWrapped, headerH, { header: true }); // repeat header on new page
    }
    paintRow(wrapped, rowH, { zebra: ri % 2 === 1 });
  });

  return y;
}

export function renderMarkdownToPdf(doc, markdown, opts = {}) {
  const margin = opts.margin ?? 15;
  const x = opts.x ?? margin;
  const maxWidth = opts.maxWidth ?? (pageWidth(doc) - margin * 2);
  const bottom = opts.bottom ?? (pageHeight(doc) - 18);
  const onNewPage = opts.onNewPage;
  let y = opts.y ?? margin;

  const newPageIfNeeded = (needed) => {
    if (y + needed > bottom) {
      doc.addPage();
      y = onNewPage ? (onNewPage(doc) ?? margin) : margin;
    }
  };

  parseMarkdownBlocks(markdown).forEach((block) => {
    switch (block.type) {
      case 'heading': {
        const size = block.level <= 1 ? 12.5 : block.level === 2 ? 11 : 10;
        y += 1.5;
        doc.setFont('Helvetica', 'bold');
        doc.setFontSize(size);
        doc.setTextColor(...COLORS.heading);
        doc.splitTextToSize(stripInline(block.text), maxWidth).forEach((ln) => {
          newPageIfNeeded(size * 0.5);
          doc.text(ln, x, y);
          y += size * 0.55;
        });
        y += 1.5;
        break;
      }
      case 'paragraph': {
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(...COLORS.body);
        doc.splitTextToSize(stripInline(block.text), maxWidth).forEach((ln) => {
          newPageIfNeeded(5);
          doc.text(ln, x, y);
          y += 4.8;
        });
        y += 2;
        break;
      }
      case 'list': {
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(...COLORS.body);
        block.items.forEach((item, idx) => {
          const bullet = block.ordered ? `${idx + 1}.` : '•';
          const lines = doc.splitTextToSize(stripInline(item), maxWidth - 6);
          lines.forEach((ln, li) => {
            newPageIfNeeded(5);
            if (li === 0) doc.text(bullet, x + 1, y);
            doc.text(ln, x + 6, y);
            y += 4.8;
          });
        });
        y += 2;
        break;
      }
      case 'quote': {
        doc.setFont('Helvetica', 'italic');
        doc.setFontSize(9.5);
        doc.setTextColor(...COLORS.muted);
        const lines = doc.splitTextToSize(stripInline(block.text), maxWidth - 5);
        const startY = y;
        lines.forEach((ln) => {
          newPageIfNeeded(5);
          doc.text(ln, x + 5, y);
          y += 4.8;
        });
        doc.setDrawColor(129, 140, 248); // indigo-400
        doc.line(x + 1.5, startY - 3.5, x + 1.5, y - 4);
        y += 2;
        break;
      }
      case 'hr': {
        newPageIfNeeded(4);
        doc.setDrawColor(...COLORS.line);
        doc.line(x, y, x + maxWidth, y);
        y += 4;
        break;
      }
      case 'table': {
        y = drawTable(doc, block, { x, y, maxWidth, bottom, margin, onNewPage });
        y += 3;
        break;
      }
      default:
        break;
    }
  });

  return y;
}
