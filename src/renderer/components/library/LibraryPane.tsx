import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryProgressEvent, LibraryRescanResult, LibraryShelfChangedEvent, ShelfRow } from '../../../shared/library';
import { useDashboardStore } from '../../stores/dashboard-store';
import LibraryAddFiles from './LibraryAddFiles';
import LibraryFilters, { EMPTY_LIBRARY_FILTERS, type LibraryFilterState } from './LibraryFilters';
import LibraryQueryBox from './LibraryQueryBox';
import LibraryResultsList from './LibraryResultsList';
import LibraryShelf from './LibraryShelf';
import type { LibraryDocumentHighlightsView, LibraryDocumentView, LibraryQueryExcerptView } from './library-result-navigation';

type LibraryApi = {
  listShelf: (workspaceId: string) => Promise<ShelfRow[]>;
  query: (workspaceId: string, args: Record<string, unknown>) => Promise<{ excerpts: LibraryQueryExcerptView[]; document_highlights?: LibraryDocumentHighlightsView }>;
  ingest: (request: Record<string, unknown>) => Promise<unknown>;
  rescan: (workspaceId: string) => Promise<LibraryRescanResult>;
  saveNote: (workspaceId: string, request: { query: string; chunk_ids: string[] }) => Promise<unknown>;
  onProgress: (callback: (event: LibraryProgressEvent) => void) => () => void;
  onShelfChanged: (callback: (event: LibraryShelfChangedEvent) => void) => () => void;
};

function libraryApi(): LibraryApi { return (window.api as typeof window.api & { library: LibraryApi }).library; }

const SHELF_CHANGED_DEBOUNCE_MS = 150;

function normalizeSourceRelPath(sourceRelPath: string, caseInsensitive: boolean): string {
  const normalized = sourceRelPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export default function LibraryPane({ initialType }: { initialType?: 'research' }) {
  const workspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspacePathType = useDashboardStore((state) => state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)?.pathType);
  const [documents, setDocuments] = useState<ShelfRow[]>([]);
  const [filters, setFilters] = useState<LibraryFilterState>({ ...EMPTY_LIBRARY_FILTERS, types: initialType ? [initialType] : [] });
  const [sort, setSort] = useState<'newest' | 'title' | 'type'>('newest');
  const [includeUntrusted, setIncludeUntrusted] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ excerpts: LibraryQueryExcerptView[]; document_highlights?: LibraryDocumentHighlightsView }>({ excerpts: [] });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const reloadGeneration = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    if (!workspaceId) { setDocuments([]); return; }
    const nextDocuments = await libraryApi().listShelf(workspaceId);
    if (generation === reloadGeneration.current) setDocuments(nextDocuments);
  }, [workspaceId]);
  useEffect(() => {
    void reload();
    return () => { reloadGeneration.current += 1; };
  }, [reload]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = libraryApi().onShelfChanged((event) => {
      if (event.workspace_id !== workspaceId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void reload(); }, SHELF_CHANGED_DEBOUNCE_MS);
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe(); };
  }, [reload, workspaceId]);
  useEffect(() => libraryApi().onProgress((event) => {
    if (event.workspace_id !== workspaceId) return;
    const caseInsensitivePaths = workspacePathType !== 'wsl';
    const eventPath = event.source_rel_path ? normalizeSourceRelPath(event.source_rel_path, caseInsensitivePaths) : null;
    setDocuments((current) => current.map((document) => {
      const pathMatches = eventPath !== null && normalizeSourceRelPath(document.source_rel_path, caseInsensitivePaths) === eventPath;
      return document.id === event.document_id || pathMatches
        ? { ...document, status: event.status, shelf_status: event.status === 'ready' || event.status === 'error' ? event.status : 'indexing', error_reason: event.error_reason ?? null }
        : document;
    }));
    if (event.status !== 'ready') {
      setResults((current) => ({
        excerpts: current.excerpts.filter((excerpt) => excerpt.doc_id !== event.document_id),
        document_highlights: current.document_highlights?.doc_id === event.document_id ? undefined : current.document_highlights,
      }));
      useDashboardStore.setState((state) => ({ openTabs: state.openTabs.map((tab) => ({
        ...tab,
        ...(tab.focusRange?.documentHash ? { focusRange: { ...tab.focusRange, highlights: [] } } : {}),
        ...(tab.pdfFocus?.documentHash ? { pdfFocus: { ...tab.pdfFocus, highlights: [] } } : {}),
      })) }));
    }
    if (event.status === 'ready' || event.status === 'error') void reload();
  }), [reload, workspaceId, workspacePathType]);

  const filtered = useMemo(() => documents.filter((document) => {
    const topics = (() => { try { return JSON.parse(document.topics_json) as string[]; } catch { return []; } })();
    return (!filters.types.length || filters.types.includes(document.type))
      && (!filters.trusts.length || filters.trusts.includes(document.trust))
      && (!filters.dateFrom || document.created >= filters.dateFrom)
      && (!filters.dateTo || document.created <= `${filters.dateTo}T23:59:59`)
      && (!filters.topic || topics.some((topic) => topic.toLowerCase().includes(filters.topic.toLowerCase())))
      && (!filters.provider || document.provider?.toLowerCase().includes(filters.provider.toLowerCase()))
      && (!filters.status || document.shelf_status === filters.status)
      && document.title.toLowerCase().includes(filters.title.toLowerCase());
  }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'type' ? a.type.localeCompare(b.type) : b.created.localeCompare(a.created)), [documents, filters, sort]);

  const runQuery = useCallback(async (nextQuery: string) => {
    setQuery(nextQuery); setSelected(new Set());
    if (!workspaceId || !nextQuery) { setResults({ excerpts: [] }); return; }
    const docIds = filtered.filter((document) => document.shelf_status === 'ready').map((document) => document.id);
    const hasShelfFilter = filters.types.length > 0 || filters.trusts.length > 0 || Boolean(filters.dateFrom || filters.dateTo || filters.topic || filters.provider || filters.status || filters.title);
    if (hasShelfFilter && docIds.length === 0) { setResults({ excerpts: [] }); return; }
    const next = await libraryApi().query(workspaceId, { query: nextQuery, mode: 'hybrid', doc_ids: docIds, types: filters.types, topics: filters.topic ? [filters.topic] : undefined, include_untrusted: includeUntrusted, highlight_doc_id: results.document_highlights?.doc_id });
    setResults(next);
  }, [workspaceId, filtered, filters, includeUntrusted, results.document_highlights?.doc_id]);

  const addFiles = async (files: File[], trigger: 'add' | 'drop') => {
    if (!workspaceId) return;
    const supported = files.filter((file) => /\.(pdf|docx|md|markdown|txt)$/i.test(file.name));
    for (const file of supported) {
      const sourcePath = window.api.files.getPathForFile(file);
      const queued: ShelfRow = { id: `queued:${file.name}`, type: (file.name.split('.').pop() === 'markdown' ? 'md' : file.name.split('.').pop()) as LibraryDocumentView['type'], title: file.name, created: new Date(file.lastModified).toISOString(), topics_json: '[]', trust: 'untrusted', source_rel_path: '', reader_rel_path: '', source_hash: '', size: file.size, page_count: null, provider: null, agent_id: null, summary: null, status: 'queued', error_reason: null, index_generation: 0, chunker_version: '', tokenizer_version: '', shelf_status: 'indexing' };
      setDocuments((current) => [queued, ...current]);
      await libraryApi().ingest({ workspace_id: workspaceId, source_path: sourcePath, trigger });
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 bg-surface-0 p-4" data-testid="library-pane">
      <header className="flex items-center justify-between"><h1 className="text-lg font-semibold">Workspace Library</h1><select aria-label="Sort library" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="ui-input"><option value="newest">Newest</option><option value="title">Title</option><option value="type">Type</option></select></header>
      <LibraryAddFiles onAdd={addFiles} onRescan={async () => {
        if (!workspaceId) return;
        const counts = await libraryApi().rescan(workspaceId);
        setMessage(`Scanned ${counts.scanned}; ingested ${counts.ingested}; skipped ${counts.skipped}; failed ${counts.failed}.`);
        await reload();
      }} />
      <LibraryFilters value={filters} onChange={setFilters} />
      <LibraryQueryBox onQuery={runQuery} includeUntrusted={includeUntrusted} onIncludeUntrusted={setIncludeUntrusted} />
      {message && <p role="status" className="text-xs text-amber-400">{message}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-4 overflow-auto"><LibraryShelf documents={filtered} /><div><LibraryResultsList excerpts={results.excerpts} highlights={results.document_highlights} documents={documents} onError={setMessage} selected={selected} onSelectedChange={setSelected} />{selected.size > 0 && <button className="ui-btn mt-2" onClick={() => workspaceId && void libraryApi().saveNote(workspaceId, { query, chunk_ids: [...selected] }).then(() => setMessage('Note saved.'))}>Save as Note</button>}</div></div>
    </section>
  );
}
