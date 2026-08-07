import React from 'react';
import { parseMarkdownBlocks, parseInline } from '../../lib/markdown';

// Inline formatting (bold / italic / code / strike)
function Inline({ text }) {
  const segs = parseInline(text);
  return (
    <>
      {segs.map((s, i) => {
        if (s.t === 'bold')   return <strong key={i} className="font-semibold text-slate-900">{s.v}</strong>;
        if (s.t === 'italic') return <em key={i}>{s.v}</em>;
        if (s.t === 'strike') return <span key={i} className="line-through opacity-70">{s.v}</span>;
        if (s.t === 'code')   return <code key={i} className="px-1 py-0.5 rounded bg-slate-100 text-[0.85em] font-mono text-indigo-700">{s.v}</code>;
        return <React.Fragment key={i}>{s.v}</React.Fragment>;
      })}
    </>
  );
}

const HEADING_SIZE = { 1: 'text-sm', 2: 'text-sm', 3: 'text-xs', 4: 'text-xs', 5: 'text-xs', 6: 'text-xs' };

/**
 * Renders a markdown string as styled React nodes — headings, lists,
 * blockquotes, rules, and GFM tables. Designed for the meeting AI chat
 * and MOM previews.
 */
export default function Markdown({ content, className = '' }) {
  const blocks = parseMarkdownBlocks(content);
  if (blocks.length === 0) {
    return <span className={className}>{content}</span>;
  }

  return (
    <div className={`space-y-2 text-[13px] ${className}`}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading':
            return (
              <p key={i} className={`font-bold text-slate-900 ${HEADING_SIZE[b.level] || 'text-sm'} ${b.level <= 2 ? 'mt-1' : ''}`}>
                <Inline text={b.text} />
              </p>
            );
          case 'paragraph':
            return <p key={i} className="leading-relaxed"><Inline text={b.text} /></p>;
          case 'list':
            return b.ordered ? (
              <ol key={i} className="list-decimal pl-5 space-y-1 marker:text-slate-400">
                {b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
              </ol>
            ) : (
              <ul key={i} className="list-disc pl-5 space-y-1 marker:text-slate-400">
                {b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
              </ul>
            );
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-indigo-300 pl-3 italic text-slate-500">
                <Inline text={b.text} />
              </blockquote>
            );
          case 'hr':
            return <hr key={i} className="border-slate-200" />;
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-xl border border-slate-200 my-2">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-100/80">
                      {b.headers.map((cell, j) => (
                        <th key={j} className="px-3 py-2 text-[11px] font-bold text-slate-700 border-b border-slate-200 whitespace-nowrap">
                          <Inline text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="even:bg-slate-50/50">
                        {b.headers.map((_, c) => (
                          <td key={c} className="px-3 py-1.5 text-[11px] text-slate-600 border-b border-slate-100 align-top">
                            <Inline text={row[c] ?? ''} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
