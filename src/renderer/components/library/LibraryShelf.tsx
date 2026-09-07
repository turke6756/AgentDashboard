import React from 'react';
import * as Icons from 'lucide-react';
import type { ShelfRow } from '../../../shared/library';

const glyphs = { pdf: Icons.FileText, docx: Icons.BookOpen, md: Icons.FileCode, txt: Icons.AlignLeft, research: Icons.FlaskConical, note: Icons.StickyNote };

function IndexBadge({ document }: { document: ShelfRow }) {
  if (document.shelf_status === 'ready') {
    return (
      <span aria-label="Ingested and ready to search" className="inline-flex items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-0.5 font-medium text-emerald-400">
        <Icons.CircleCheck className="h-3 w-3" aria-hidden="true" />
        Ready to search
      </span>
    );
  }
  if (document.shelf_status === 'error') {
    const detail = document.error_reason ? `: ${document.error_reason}` : '';
    return (
      <span aria-label={`Ingest failed${detail}`} title={document.error_reason ?? undefined} className="inline-flex items-center gap-1 rounded bg-accent-red/15 px-1.5 py-0.5 font-medium text-accent-red">
        <Icons.CircleAlert className="h-3 w-3" aria-hidden="true" />
        Ingest failed
      </span>
    );
  }
  if (document.shelf_status === 'pending') {
    return (
      <span
        aria-label="Not indexed yet; press Rescan to index"
        title="Press Rescan to index this report"
        className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-gray-400"
      >
        <Icons.CircleDashed className="h-3 w-3" aria-hidden="true" />
        Not indexed yet
      </span>
    );
  }
  if (document.shelf_status === 'indexing') {
    return (
      <span aria-label="Ingest in progress" className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-gray-400">
        <Icons.LoaderCircle className="h-3 w-3" aria-hidden="true" />
        Working
      </span>
    );
  }
  return <span aria-label="Re-index needed" className="rounded bg-white/5 px-1.5 py-0.5 text-gray-400">Needs re-index</span>;
}

export default function LibraryShelf({ documents }: { documents: ShelfRow[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3" data-testid="library-shelf">
      {documents.map((document) => {
        const Glyph = glyphs[document.type];
        const topics = (() => { try { return JSON.parse(document.topics_json) as string[]; } catch { return []; } })();
        return (
          <article key={document.id} className="ui-card min-h-40 border-l-4 border-l-accent-blue p-3" data-document-id={document.id} data-shelf-status={document.shelf_status}>
            <div className="flex items-start gap-2"><Glyph className="h-4 w-4 shrink-0" /><h3 className="line-clamp-2 text-sm font-semibold">{document.title}</h3></div>
            <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-gray-400"><span>{new Date(document.created).toLocaleDateString()}</span><span>{document.trust}</span>{document.provider && <span data-testid="provider-glyph">{document.provider}</span>}</div>
            <p className="mt-2 truncate text-xs text-gray-400">{document.summary || 'No summary yet'}</p>
            <div className="mt-2 flex flex-wrap gap-1">{topics.map((topic) => <span key={topic} className="rounded bg-white/5 px-1 text-[10px]">{topic}</span>)}</div>
            <div className="mt-3 flex items-center gap-1 text-[11px]">
              <IndexBadge document={document} />
              {document.trust === 'untrusted' && <span aria-label="Untrusted research report" className="rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-400">untrusted · inbox</span>}
            </div>
          </article>
        );
      })}
      {documents.length === 0 && <p className="text-sm text-gray-400">No documents match these filters.</p>}
    </div>
  );
}
