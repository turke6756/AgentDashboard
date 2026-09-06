import React from 'react';
import * as Icons from 'lucide-react';
import type { LibraryDocumentView } from './library-result-navigation';

const glyphs = { pdf: Icons.FileText, docx: Icons.BookOpen, md: Icons.FileCode, txt: Icons.AlignLeft, research: Icons.FlaskConical, note: Icons.StickyNote };

export default function LibraryShelf({ documents }: { documents: LibraryDocumentView[] }) {
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
            <div className={`mt-3 text-[11px] ${document.status === 'error' ? 'text-accent-red' : 'text-gray-400'}`}>{document.status}{document.error_reason ? `: ${document.error_reason}` : ''}</div>
          </article>
        );
      })}
      {documents.length === 0 && <p className="text-sm text-gray-400">No documents match these filters.</p>}
    </div>
  );
}
