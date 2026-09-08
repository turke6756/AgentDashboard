import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryProgressEvent, LibraryRescanResult, LibraryShelfChangedEvent, ShelfRow } from '../../../shared/library';
import { useDashboardStore } from '../../stores/dashboard-store';
import LibraryAddFiles from './LibraryAddFiles';
import LibraryFilters, { EMPTY_LIBRARY_FILTERS, type LibraryFilterState } from './LibraryFilters';
import LibraryQueryBox from './LibraryQueryBox';
import LibraryShelf from './LibraryShelf';
import { groupLibraryResults, type LibraryResultGroup } from './library-result-groups';
import { openLibraryDocument, openLibraryResult, resolveWorkspaceRelativePath, type LibraryDocumentHighlightsView, type LibraryDocumentView, type LibraryQueryExcerptView } from './library-result-navigation';
import { useLibraryViewState, type LibrarySort, type LibraryWorkspaceViewState } from './library-view-state';

type QueryResult = { excerpts: LibraryQueryExcerptView[]; document_highlights?: LibraryDocumentHighlightsView };
type LibraryApi = {
  listShelf: (workspaceId: string) => Promise<ShelfRow[]>;
  query: (workspaceId: string, args: Record<string, unknown>) => Promise<QueryResult>;
  ingest: (request: Record<string, unknown>) => Promise<unknown>;
  rescan: (workspaceId: string) => Promise<LibraryRescanResult>;
  saveNote: (workspaceId: string, request: { query: string; chunk_ids: string[] }) => Promise<unknown>;
  onProgress: (callback: (event: LibraryProgressEvent) => void) => () => void;
  onShelfChanged: (callback: (event: LibraryShelfChangedEvent) => void) => () => void;
};

function libraryApi(): LibraryApi { return (window.api as typeof window.api & { library: LibraryApi }).library; }
const SHELF_CHANGED_DEBOUNCE_MS = 150;
const EMPTY_SESSION: LibraryWorkspaceViewState = { draftQuery: '', executedQuery: '', filters: EMPTY_LIBRARY_FILTERS, sort: 'newest', selectedChunkIds: [], scrollOffset: 0 };

function normalizePath(value: string, caseInsensitive: boolean): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function hasFilters(filters: LibraryFilterState): boolean {
  return filters.types.length > 0 || Boolean(filters.dateFrom || filters.dateTo || filters.topic || filters.provider || filters.status || filters.title);
}

export default function LibraryPane({ initialType }: { initialType?: 'research' }) {
  const workspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspaces = useDashboardStore((state) => state.workspaces);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const session = useLibraryViewState((state) => workspaceId ? state.byWorkspace[workspaceId] : undefined) ?? EMPTY_SESSION;
  const [documents, setDocuments] = useState<ShelfRow[]>([]);
  const [results, setResults] = useState<QueryResult>({ excerpts: [] });
  const [queryState, setQueryState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [queryError, setQueryError] = useState('');
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const reloadGeneration = useRef(0);
  const queryGeneration = useRef(0);
  const shelfRef = useRef<HTMLDivElement>(null);

  const updateSession = useCallback((patch: Partial<LibraryWorkspaceViewState>) => {
    if (workspaceId) useLibraryViewState.getState().updateWorkspace(workspaceId, patch);
  }, [workspaceId]);

  useEffect(() => {
    useLibraryViewState.getState().pruneWorkspaces(workspaces.map((item) => item.id));
    if (workspaceId) useLibraryViewState.getState().ensureWorkspace(workspaceId, initialType);
  }, [initialType, workspaceId, workspaces]);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    if (!workspaceId) { setDocuments([]); return; }
    const nextDocuments = await libraryApi().listShelf(workspaceId);
    if (generation === reloadGeneration.current) setDocuments(nextDocuments);
  }, [workspaceId]);

  useEffect(() => {
    void reload();
    return () => { reloadGeneration.current += 1; queryGeneration.current += 1; };
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
    const caseInsensitive = workspace?.pathType !== 'wsl';
    const eventPath = event.source_rel_path ? normalizePath(event.source_rel_path, caseInsensitive) : null;
    const affected = documents.find((document) => document.id === event.document_id
      || (eventPath !== null && normalizePath(document.source_rel_path, caseInsensitive) === eventPath));
    setDocuments((current) => current.map((document) => {
      const pathMatches = eventPath !== null && normalizePath(document.source_rel_path, caseInsensitive) === eventPath;
      return document.id === event.document_id || pathMatches
        ? { ...document, status: event.status, shelf_status: event.status === 'ready' || event.status === 'error' ? event.status : 'indexing', error_reason: event.error_reason ?? null }
        : document;
    }));
    if (event.status !== 'ready' && affected && workspace) {
      setResults((current) => ({ excerpts: current.excerpts.filter((excerpt) => excerpt.doc_id !== affected.id) }));
      const candidatePaths = [affected.reader_rel_path, affected.source_rel_path].filter(Boolean)
        .map((path) => normalizePath(resolveWorkspaceRelativePath(workspace.path, path), caseInsensitive));
      useDashboardStore.setState((state) => ({ openTabs: state.openTabs.map((tab) => {
        const byHash = tab.focusRange?.documentHash === affected.source_hash || tab.pdfFocus?.documentHash === affected.source_hash;
        const byPath = candidatePaths.includes(normalizePath(tab.filePath, caseInsensitive));
        if (!byHash && !byPath) return tab;
        return { ...tab,
          ...(tab.focusRange ? { focusRange: { ...tab.focusRange, selectedHighlightId: undefined, highlights: [] } } : {}),
          ...(tab.pdfFocus ? { pdfFocus: { ...tab.pdfFocus, selectedHighlightId: undefined, highlights: [] } } : {}),
        };
      }) }));
    }
    if (event.status === 'ready' || event.status === 'error') void reload();
  }), [documents, reload, workspace, workspaceId]);

  const filtered = useMemo(() => documents.filter((document) => {
    const topics = (() => { try { return JSON.parse(document.topics_json) as string[]; } catch { return []; } })();
    const filters = session.filters;
    return (!filters.types.length || filters.types.includes(document.type))
      && (!filters.dateFrom || document.created >= filters.dateFrom)
      && (!filters.dateTo || document.created <= `${filters.dateTo}T23:59:59`)
      && (!filters.topic || topics.some((topic) => topic.toLowerCase().includes(filters.topic.toLowerCase())))
      && (!filters.provider || document.provider?.toLowerCase().includes(filters.provider.toLowerCase()))
      && (!filters.status || document.shelf_status === filters.status)
      && document.title.toLowerCase().includes(filters.title.toLowerCase());
  }).sort((a, b) => session.sort === 'title' ? a.title.localeCompare(b.title) : session.sort === 'type' ? a.type.localeCompare(b.type) : b.created.localeCompare(a.created)), [documents, session.filters, session.sort]);

  useEffect(() => {
    const query = session.executedQuery;
    const generation = ++queryGeneration.current;
    setResults({ excerpts: [] });
    setQueryError('');
    if (!workspaceId || !query) { setQueryState('idle'); return; }
    const docIds = filtered.filter((document) => document.shelf_status === 'ready').map((document) => document.id);
    if (hasFilters(session.filters) && docIds.length === 0) { setQueryState('empty'); return; }
    setQueryState('loading');
    const snapshot = session.filters;
    void libraryApi().query(workspaceId, { query, mode: 'hybrid', doc_ids: docIds, types: snapshot.types,
      topics: snapshot.topic ? [snapshot.topic] : undefined, include_untrusted: true, limit: 50,
    }).then((next) => {
      if (generation !== queryGeneration.current) return;
      setResults(next);
      setQueryState(next.excerpts.length > 0 ? 'ready' : 'empty');
    }).catch((error: unknown) => {
      if (generation !== queryGeneration.current) return;
      setQueryError(error instanceof Error ? error.message : String(error));
      setQueryState('error');
    });
    return () => { queryGeneration.current += 1; };
  }, [workspaceId, filtered, session.executedQuery, session.filters]);

  const groupedResults = useMemo(() => groupLibraryResults(filtered, results.excerpts), [filtered, results.excerpts]);
  const populationKey = session.executedQuery ? groupedResults.groups.map((group) => group.document.id).join('|') : filtered.map((document) => document.id).join('|');
  useEffect(() => {
    const node = shelfRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => { node.scrollTop = session.scrollOffset; });
    return () => cancelAnimationFrame(frame);
  }, [populationKey, session.scrollOffset]);

  const openResult = async (document: ShelfRow, group?: LibraryResultGroup) => {
    if (!group || !workspaceId) {
      const outcome = openLibraryDocument(document);
      if (!outcome.ok) setMessage(outcome.error);
      return;
    }
    const querySnapshot = session.executedQuery;
    const filterSnapshot = session.filters;
    setOpeningDocumentId(document.id);
    try {
      const focused = await libraryApi().query(workspaceId, { query: querySnapshot, mode: 'hybrid', doc_ids: [document.id], highlight_doc_id: document.id,
        types: filterSnapshot.types, topics: filterSnapshot.topic ? [filterSnapshot.topic] : undefined, include_untrusted: true, limit: 50,
      });
      const excerpt = focused.excerpts.find((item) => item.doc_id === document.id) ?? group.bestExcerpt;
      const outcome = openLibraryResult(excerpt, focused.document_highlights, document.source_hash);
      if (!outcome.ok) setMessage(outcome.error);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setOpeningDocumentId(null); }
  };

  const addFiles = async (files: File[], trigger: 'add' | 'drop') => {
    if (!workspaceId) return;
    for (const file of files.filter((item) => /\.(pdf|docx|md|markdown|txt)$/i.test(item.name))) {
      const sourcePath = window.api.files.getPathForFile(file);
      const queued: ShelfRow = { id: `queued:${file.name}`, type: (file.name.split('.').pop() === 'markdown' ? 'md' : file.name.split('.').pop()) as LibraryDocumentView['type'], title: file.name, created: new Date(file.lastModified).toISOString(), topics_json: '[]', trust: 'untrusted', source_rel_path: '', reader_rel_path: '', source_hash: '', size: file.size, page_count: null, provider: null, agent_id: null, summary: null, status: 'queued', error_reason: null, index_generation: 0, chunker_version: '', tokenizer_version: '', shelf_status: 'indexing' };
      setDocuments((current) => [queued, ...current]);
      await libraryApi().ingest({ workspace_id: workspaceId, source_path: sourcePath, trigger });
    }
  };

  const retry = () => updateSession({ filters: { ...session.filters } });
  const clearSearch = () => updateSession({ draftQuery: '', executedQuery: '', selectedChunkIds: [] });
  const selected = new Set(session.selectedChunkIds);
  const emptyCopy = documents.length === 0 ? 'Add or drop reports to build your Library'
    : hasFilters(session.filters) && filtered.length === 0 ? 'No documents match these filters'
      : `No documents match “${session.executedQuery}”`;

  return (
    <section role="region" aria-label="Workspace Library" className="flex h-full min-h-0 flex-col gap-3 bg-surface-0 p-4" data-testid="library-pane">
      <header className="flex items-center justify-between"><h1 className="text-lg font-semibold">Workspace Library</h1><select aria-label="Sort library" value={session.sort} onChange={(event) => updateSession({ sort: event.target.value as LibrarySort })} className="ui-input"><option value="newest">Newest</option><option value="title">Title</option><option value="type">Type</option></select></header>
      <LibraryAddFiles onAdd={addFiles} onRescan={async () => { if (!workspaceId) return; const counts = await libraryApi().rescan(workspaceId); setMessage(`Scanned ${counts.scanned}; ingested ${counts.ingested}; skipped ${counts.skipped}; failed ${counts.failed}.`); await reload(); }} />
      <LibraryFilters value={session.filters} onChange={(filters) => updateSession({ filters })} />
      <LibraryQueryBox value={session.draftQuery} onChange={(draftQuery) => updateSession({ draftQuery })} onQuery={(executedQuery) => updateSession({ executedQuery, selectedChunkIds: [] })} />
      {message && <p role="status" className="text-xs text-amber-400">{message}</p>}
      {groupedResults.orphanDocumentIds.length > 0 && <p role="status" className="text-xs text-amber-400">Some search results are stale. Refresh the Library and try again.</p>}
      <div ref={shelfRef} className="min-h-0 flex-1 overflow-auto" onScroll={(event) => updateSession({ scrollOffset: event.currentTarget.scrollTop })}>
        {queryState === 'loading' && <p className="text-sm text-gray-400">Searching Library…</p>}
        {queryState === 'error' && <div role="alert" className="text-sm text-accent-red">Search failed: {queryError}<button type="button" className="ui-btn ml-2" onClick={retry}>Retry</button></div>}
        {((queryState === 'idle' && filtered.length === 0) || queryState === 'empty') && <div className="text-sm text-gray-400"><p>{emptyCopy}</p>{session.executedQuery && <button type="button" className="ui-btn mt-2" onClick={clearSearch}>Clear search</button>}</div>}
        {queryState === 'idle' && filtered.length > 0 && <LibraryShelf documents={filtered} onOpen={(document) => void openResult(document)} />}
        {queryState === 'ready' && <LibraryShelf documents={[]} groups={groupedResults.groups} openingDocumentId={openingDocumentId} selected={selected} onSelectedChange={(next) => updateSession({ selectedChunkIds: [...next] })} onOpen={(document, group) => void openResult(document, group)} />}
      </div>
      {selected.size > 0 && <button className="ui-btn self-start" onClick={() => workspaceId && void libraryApi().saveNote(workspaceId, { query: session.executedQuery, chunk_ids: [...selected] }).then(() => setMessage('Note saved.'))}>Save as Note</button>}
    </section>
  );
}
