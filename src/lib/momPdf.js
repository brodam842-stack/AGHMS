/**
 * Render an official RNGPIT-format Minutes of Meeting (see momFormat.js) to a
 * jsPDF document that mirrors the institute's real MOM (MoM_Ac_01.pdf):
 *   Ref/Date header → Present Members table → Online-Mode table → absentees →
 *   opening paragraph → bordered agenda table (Discussion/Resolutions) →
 *   vote-of-thanks → Prepared By / Approved By signature block.
 */
import { jsPDF } from 'jspdf';
import { ordinal, formatLongDate } from './momFormat';

const BLACK = [0, 0, 0];

export function generateOfficialMomPdf(mom) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 16;
  const contentW = pageW - M * 2;
  const bottom = pageH - M;
  const ctx = { M, contentW, bottom, y: M };

  const ensure = (need) => { if (ctx.y + need > bottom) { doc.addPage(); ctx.y = M; } };

  // ── Ref. No. / Date header ────────────────────────────────────────────────
  doc.setTextColor(...BLACK);
  doc.setFont('times', 'bold'); doc.setFontSize(11);
  doc.text('Ref. No.: ', M, ctx.y);
  const refW = doc.getTextWidth('Ref. No.: ');
  doc.setFont('times', 'normal');
  doc.text(String(mom.refNo || ''), M + refW, ctx.y);

  const dateVal = formatLongDate(mom.date);
  doc.setFont('times', 'bold');
  const dW = doc.getTextWidth('Date: ');
  const dvW = doc.getTextWidth(dateVal);
  doc.text('Date: ', pageW - M - dvW - dW, ctx.y);
  doc.setFont('times', 'normal');
  doc.text(dateVal, pageW - M - dvW, ctx.y);
  ctx.y += 8;

  // ── Present Members intro ─────────────────────────────────────────────────
  const typeLabel = mom.meetingType || 'HOD';
  const intro = `The following members were present in the ${ordinal(mom.meetingNo || 1)} ${typeLabel} meeting held on ${dateVal}.`;
  doc.setFont('times', 'bold'); doc.setFontSize(11);
  doc.text('Present Members:', M, ctx.y);
  const pmW = doc.getTextWidth('Present Members: ');
  doc.setFont('times', 'normal');
  const introLines = doc.splitTextToSize(intro, contentW - pmW);
  introLines.forEach((ln, i) => { doc.text(ln, i === 0 ? M + pmW : M, ctx.y); ctx.y += 5; });
  ctx.y += 2;

  // ── Present Members (in person) ───────────────────────────────────────────
  if ((mom.presentInPerson || []).length) {
    drawGridTable(doc, {
      headers: ['Sr. No.', 'Name', 'Designation'],
      colWidths: [16, 62, contentW - 16 - 62],
      align: ['center', 'left', 'left'],
      rows: mom.presentInPerson.map(m => [String(m.sr), m.name, m.designation]),
    }, ctx);
    ctx.y += 4;
  }

  // ── Present through platform / online ─────────────────────────────────────
  if ((mom.presentOnline || []).length) {
    ensure(14);
    doc.setFont('times', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...BLACK);
    doc.splitTextToSize('Following members were present through the AGHMS live platform (Online Mode):', contentW)
      .forEach(ln => { doc.text(ln, M, ctx.y); ctx.y += 5; });
    ctx.y += 1;
    drawGridTable(doc, {
      headers: ['Sr. No.', 'Name', 'Designation'],
      colWidths: [16, 62, contentW - 16 - 62],
      align: ['center', 'left', 'left'],
      rows: mom.presentOnline.map(m => [String(m.sr), m.name, m.designation]),
    }, ctx);
    ctx.y += 4;
  }

  // ── Absentees ─────────────────────────────────────────────────────────────
  if ((mom.absentees || []).length) {
    ensure(10);
    doc.setFont('times', 'bold'); doc.setFontSize(10.5);
    doc.text('Absent:', M, ctx.y); ctx.y += 5;
    doc.setFont('times', 'normal'); doc.setFontSize(10);
    mom.absentees.forEach(a => {
      const txt = `${a.name}${a.note ? `, ${a.note}` : ''} — was absent.`;
      doc.splitTextToSize(txt, contentW - 6).forEach((ln, i) => {
        ensure(5);
        if (i === 0) doc.text('•', M + 1, ctx.y);
        doc.text(ln, M + 6, ctx.y); ctx.y += 4.6;
      });
    });
    ctx.y += 3;
  }

  // ── Opening paragraph ─────────────────────────────────────────────────────
  if (mom.openingParagraph) {
    ensure(12);
    doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...BLACK);
    doc.splitTextToSize(mom.openingParagraph, contentW).forEach(ln => {
      ensure(5); doc.text(ln, M, ctx.y); ctx.y += 5;
    });
    ctx.y += 4;
  }

  // ── Agenda table ──────────────────────────────────────────────────────────
  if ((mom.agenda || []).length) {
    drawAgendaTable(doc, mom.agenda, ctx);
    ctx.y += 4;
  }

  // ── Concluding note ───────────────────────────────────────────────────────
  if (mom.concludingNote) {
    ensure(10);
    doc.setFont('times', 'normal'); doc.setFontSize(10.5);
    doc.splitTextToSize(mom.concludingNote, contentW).forEach(ln => {
      ensure(5); doc.text(ln, M, ctx.y); ctx.y += 5;
    });
    ctx.y += 6;
  }

  // ── Signature block (Prepared By / Approved By) ───────────────────────────
  ensure(34);
  const halfW = contentW / 2;
  const boxY = ctx.y;
  const boxH = 30;
  doc.setDrawColor(...BLACK);
  doc.rect(M, boxY, halfW, boxH);
  doc.rect(M + halfW, boxY, halfW, boxH);
  doc.setFont('times', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...BLACK);
  doc.text('Prepared By:', M + 3, boxY + 6);
  doc.text('Approved By:', M + halfW + 3, boxY + 6);
  doc.text(mom.preparedBy?.name || '', M + 3, boxY + 22);
  doc.text(mom.approvedBy?.name || '', M + halfW + 3, boxY + 22);
  doc.setFont('times', 'normal'); doc.setFontSize(9.5);
  doc.text(mom.preparedBy?.designation || 'Member Secretary', M + 3, boxY + 27);
  doc.text(mom.approvedBy?.designation || 'Chairperson', M + halfW + 3, boxY + 27);
  ctx.y = boxY + boxH + 4;

  return doc;
}

export function downloadOfficialMomPdf(mom, fileName) {
  const doc = generateOfficialMomPdf(mom);
  const safe = (fileName || mom.meetingTitle || 'MOM').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
  doc.save(`${safe}_MOM.pdf`);
}

// ── Table drawers ───────────────────────────────────────────────────────────

function drawGridTable(doc, { headers, colWidths, rows, align = [] }, ctx) {
  const { M, bottom } = ctx;
  const x = M;
  const padX = 1.8, padY = 1.6, fs = 9.5, lh = 4.2;
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  let y = ctx.y;

  const wrapRow = (cells) => {
    doc.setFontSize(fs);
    return cells.map((c, i) => doc.splitTextToSize(String(c ?? ''), colWidths[i] - padX * 2));
  };
  const rowH = (wrapped) => Math.max(...wrapped.map(w => w.length), 1) * lh + padY * 2;

  const paint = (wrapped, h, header = false, zebra = false) => {
    if (header) { doc.setFillColor(236, 238, 241); doc.rect(x, y, totalW, h, 'F'); }
    else if (zebra) { doc.setFillColor(248, 249, 251); doc.rect(x, y, totalW, h, 'F'); }
    doc.setFont('times', header ? 'bold' : 'normal'); doc.setFontSize(fs); doc.setTextColor(...BLACK);
    let cx = x;
    wrapped.forEach((lines, i) => {
      const a = align[i] || 'left';
      let ty = y + padY + lh - 1;
      lines.forEach(ln => {
        if (a === 'center') doc.text(ln, cx + colWidths[i] / 2, ty, { align: 'center' });
        else doc.text(ln, cx + padX, ty);
        ty += lh;
      });
      cx += colWidths[i];
    });
    doc.setDrawColor(...BLACK);
    let bx = x;
    for (let c = 0; c <= colWidths.length; c++) { doc.line(bx, y, bx, y + h); if (c < colWidths.length) bx += colWidths[c]; }
    doc.line(x, y + h, x + totalW, y + h);
    if (header) doc.line(x, y, x + totalW, y);
    y += h;
  };

  const hw = wrapRow(headers); const hh = rowH(hw);
  if (y + hh > bottom) { doc.addPage(); y = M; }
  paint(hw, hh, true);
  rows.forEach((r, ri) => {
    const w = wrapRow(r); const h = rowH(w);
    if (y + h > bottom) { doc.addPage(); y = M; paint(hw, hh, true); }
    paint(w, h, false, ri % 2 === 1);
  });
  ctx.y = y;
}

function drawAgendaTable(doc, agenda, ctx) {
  const { M, contentW, bottom } = ctx;
  const noW = 18;
  const leftX = M;
  const midX = M + noW;
  const rightX = M + contentW;
  const padX = 2.2;
  const textW = contentW - noW - padX * 2;
  let y = ctx.y;
  let segTop = y;

  const header = () => {
    doc.setFillColor(236, 238, 241);
    doc.rect(leftX, y, contentW, 7, 'F');
    doc.setFont('times', 'bold'); doc.setFontSize(10); doc.setTextColor(...BLACK);
    doc.text('Agenda No.', leftX + noW / 2, y + 4.7, { align: 'center' });
    doc.text('Discussions', midX + (contentW - noW) / 2, y + 4.7, { align: 'center' });
    doc.setDrawColor(...BLACK);
    doc.rect(leftX, y, noW, 7);
    doc.rect(midX, y, contentW - noW, 7);
    y += 7;
    segTop = y;
  };

  const closeSegment = (atY) => {
    doc.setDrawColor(...BLACK);
    doc.line(leftX, segTop, leftX, atY);
    doc.line(midX, segTop, midX, atY);
    doc.line(rightX, segTop, rightX, atY);
  };

  if (y + 20 > bottom) { doc.addPage(); y = M; }
  header();

  agenda.forEach((item) => {
    // Build physical (wrapped) lines with style metadata
    const phys = [];
    const push = (style, text) => {
      const isBullet = style === 'bullet';
      doc.setFont('times', isBullet ? 'normal' : 'bold');
      doc.setFontSize(isBullet ? 9.5 : 10);
      const indent = isBullet ? 5 : 0;
      doc.splitTextToSize(String(text || ''), textW - indent).forEach((ln, i) => {
        phys.push({ style, text: ln, indent, firstOfToken: i === 0 });
      });
    };
    push('bold', item.title);
    if ((item.discussion || []).length) { push('label', 'Discussion:'); item.discussion.forEach(d => push('bullet', d)); }
    if ((item.resolutions || []).length) { push('label', 'Resolutions:'); item.resolutions.forEach(r => push('bullet', r)); }
    if (!phys.length) push('bullet', '—');

    let firstLineOfItem = true;
    phys.forEach((ln) => {
      const gap = (ln.style === 'label' && ln.firstOfToken) ? 1.4 : 0;
      const lh = 4.8 + gap;
      if (y + lh > bottom) {
        closeSegment(y);
        doc.addPage(); y = ctx.M ?? M;
        y = M; header();
      }
      const ty = y + 3.4 + gap;
      if (firstLineOfItem) {
        doc.setFont('times', 'bold'); doc.setFontSize(10); doc.setTextColor(...BLACK);
        doc.text(String(item.no), leftX + noW / 2, ty, { align: 'center' });
        firstLineOfItem = false;
      }
      doc.setTextColor(...BLACK);
      if (ln.style === 'bullet') {
        doc.setFont('times', 'normal'); doc.setFontSize(9.5);
        doc.text('•', midX + padX, ty);
        doc.text(ln.text, midX + padX + ln.indent, ty);
      } else {
        doc.setFont('times', 'bold'); doc.setFontSize(10);
        doc.text(ln.text, midX + padX, ty);
      }
      y += lh;
    });

    // bottom separator for this agenda row
    y += 1.6;
    doc.setDrawColor(...BLACK);
    doc.line(leftX, y, rightX, y);
  });

  closeSegment(y);
  ctx.y = y;
}
