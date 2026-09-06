import React from 'react';
import * as Icons from 'lucide-react';
import type { ShelfRow } from '../../../shared/library';

const glyphs = { pdf: Icons.FileText, docx: Icons.BookOpen, md: Icons.FileCode, txt: Icons.AlignLeft, research: Icons.FlaskConical, note: Icons.StickyNote };

export default function LibraryShelf({ documents }: { documents: ShelfRow[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3" data-testid="library-shelf">
      {documents.map((document) => {
        const Glyph = glyphs[document.type];
        const topics = (() => { try { return JSON.parse(document.topics_json) as string[]; } catch { return []; } })();
        return (
          <article key={document.id} className="ui-card min-h-40 border-l-4 border-l-accent-blue p-3" data-document-id={document.id}>
            <div className="flex items-start gap-2"><Glyph className="h-4 w-4 shrink-0" /><h3 className="line-clamp-2 text-sm font-semibold">{document.title}</h3></div>
            <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-gray-400"><span>{new Date(document.created).toLocaleDateString()}</span><span>{document.trust}</span>{document.provider && <span data-testid="provider-glyph">{document.provider}</span>}</div>
            <p className="mt-2 truncate text-xs text-gray-400">{document.summary || 'No summary yet'}</p>
            <div className="mt-2 flex flex-wrap gap-1">{topics.map((topic) => <span key={topic} className="rounded bg-white/5 px-1 text-[10px]">{topic}</span>)}</div>
            <div className="mt-3 flex items-center gap-1 text-[11px]">
              <span aria-label={`Index status: ${document.shelf_status}`} className={`rounded px-1.5 py-0.5 ${document.shelf_status === 'error' ? 'bg-accent-red/15 text-accent-red' : 'bg-white/5 text-gray-400'}`}>
                {document.shelf_status}{document.error_reason ? `: ${document.error_reason}` : ''}
              </span>
              {document.trust === 'untrusted' && <span aria-label="Untrusted research report" className="rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-400">untrusted · inbox</span>}
            </div>
          </article>
        );
      })}
      {documents.length === 0 && <p className="text-sm text-gray-400">No documents match these filters.</p>}
    </div>
  );
}
