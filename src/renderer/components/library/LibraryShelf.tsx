import React from 'react';
import * as Icons from 'lucide-react';
import type { ShelfRow } from '../../../shared/library';
import { buildMatchPreview, normalizeMatchRanges, type LibraryResultGroup } from './library-result-groups';

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

interface LibraryShelfProps {
  documents: ShelfRow[];
  groups?: LibraryResultGroup[];
  openingDocumentId?: string | null;
  selected?: Set<string>;
  onOpen: (document: ShelfRow, group?: LibraryResultGroup) => void;
  onSelectedChange?: (next: Set<string>) => void;
}

export default function LibraryShelf({ documents, groups, openingDocumentId, selected = new Set(), onOpen, onSelectedChange }: LibraryShelfProps) {
  const rows = groups?.map((group) => ({ document: group.document, group }))
    ?? documents.map((document) => ({ document, group: undefined }));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3" data-testid="library-shelf">
      {rows.map(({ document, group }) => {
        const Glyph = glyphs[document.type];
        const topics = (() => { try { return JSON.parse(document.topics_json) as string[]; } catch { return []; } })();
        const ranges = group ? normalizeMatchRanges(group.bestExcerpt.keyword_matches ?? [], group.bestExcerpt.quote.length) : [];
        const preview = group ? buildMatchPreview(group.bestExcerpt.quote, ranges) : [];
        const disabled = !document.reader_rel_path.trim() || openingDocumentId === document.id;
        return (
          <article key={document.id} className="ui-card min-h-40 border-l-4 border-l-accent-blue p-1" data-document-id={document.id} data-shelf-status={document.shelf_status}>
            <button
              type="button"
              className="h-full w-full rounded p-2 text-left outline-none transition hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent-blue disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled}
              aria-describedby={!document.reader_rel_path.trim() ? `library-unavailable-${document.id}` : undefined}
              onClick={() => onOpen(document, group)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onOpen(document, group);
              }}
            >
              <div className="flex items-start gap-2"><Glyph className="h-4 w-4 shrink-0" /><h3 className="line-clamp-2 text-sm font-semibold">{document.title}</h3></div>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-gray-400"><span>{new Date(document.created).toLocaleDateString()}</span>{document.provider && <span data-testid="provider-glyph">{document.provider}</span>}</div>
              {group ? <>
                <p className="mt-2 line-clamp-3 text-xs text-gray-300" data-testid="library-result-preview">
                  {preview.map((segment, index) => segment.marked
                    ? <mark key={index} className="rounded bg-yellow-300/30 text-inherit">{segment.text}</mark>
                    : <React.Fragment key={index}>{segment.text}</React.Fragment>)}
                </p>
                {ranges.length === 0 && group.bestExcerpt.similar_passage && <p className="mt-1 text-[11px] text-accent-blue">Similar passage</p>}
                <p className="mt-1 text-[11px] text-gray-400">{group.bestExcerpt.citation} · {group.matchCount} matching {group.matchCount === 1 ? 'passage' : 'passages'}</p>
              </> : <p className="mt-2 truncate text-xs text-gray-400">{document.summary || 'No summary yet'}</p>}
              <div className="mt-2 flex flex-wrap gap-1">{topics.map((topic) => <span key={topic} className="rounded bg-white/5 px-1 text-[10px]">{topic}</span>)}</div>
              <div className="mt-3 flex items-center gap-1 text-[11px]"><IndexBadge document={document} /></div>
              {!document.reader_rel_path.trim() && <span id={`library-unavailable-${document.id}`} className="mt-2 block text-[11px] text-gray-400">This item is still being added.</span>}
            </button>
            {group && onSelectedChange && <label className="mt-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] text-gray-400" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" aria-label={`Select passage from ${document.title}`} checked={group.excerpts.some((excerpt) => selected.has(excerpt.chunk_id))} onChange={(event) => {
                const next = new Set(selected);
                for (const excerpt of group.excerpts) event.target.checked ? next.add(excerpt.chunk_id) : next.delete(excerpt.chunk_id);
                onSelectedChange(next);
              }} />
              Select returned passages
            </label>}
          </article>
        );
      })}
    </div>
  );
}
