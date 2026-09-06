import React from 'react';
import type { LibraryDocumentHighlightsView, LibraryDocumentView, LibraryQueryExcerptView } from './library-result-navigation';
import { openLibraryResult } from './library-result-navigation';

export default function LibraryResultsList({ excerpts, highlights, documents, onError, selected, onSelectedChange }: {
  excerpts: LibraryQueryExcerptView[];
  highlights?: LibraryDocumentHighlightsView;
  documents: LibraryDocumentView[];
  onError: (message: string) => void;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
}) {
  return (
    <aside className="space-y-2" aria-label="Library results">
      {excerpts.map((excerpt) => (
        <div key={excerpt.chunk_id} className="ui-card p-2 text-xs">
          <label className="flex gap-2"><input type="checkbox" checked={selected.has(excerpt.chunk_id)} onChange={(event) => { const next = new Set(selected); event.target.checked ? next.add(excerpt.chunk_id) : next.delete(excerpt.chunk_id); onSelectedChange(next); }} /><strong>{excerpt.title}</strong></label>
          <button className="mt-1 w-full text-left" onClick={() => {
            const current = documents.find((document) => document.id === excerpt.doc_id);
            const outcome = openLibraryResult(excerpt, highlights?.doc_id === excerpt.doc_id ? highlights : undefined, current?.source_hash);
            if (!outcome.ok) onError(outcome.error);
          }}>
            <span className="line-clamp-3 text-gray-300">{excerpt.quote}</span><span className="mt-1 block text-accent-blue">{excerpt.citation}</span>
          </button>
          {excerpt.trust === 'untrusted' && <span className="text-amber-400">Untrusted</span>}
        </div>
      ))}
    </aside>
  );
}
