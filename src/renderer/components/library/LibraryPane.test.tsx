// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShelfRow } from '../../../shared/library';
import type { Workspace } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { openLibraryResult, type LibraryQueryExcerptView } from './library-result-navigation';
import LibraryPane from './LibraryPane';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = { id: 'ws', path: 'C:\\repo', pathType: 'windows' } as Workspace;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const shelfRow = (id: string, shelf_status: ShelfRow['shelf_status'], trust: ShelfRow['trust'] = 'cleared'): ShelfRow => ({
  id, type: 'research', title: id, created: '2026-09-06T00:00:00.000Z', topics_json: '[]', trust,
  source_rel_path: `.lares/library/inbox/${id}.md`, reader_rel_path: `.lares/library/inbox/${id}.md`, source_hash: `hash-${id}`,
  size: 10, page_count: null, provider: 'codex', agent_id: null, summary: null,
  status: shelf_status === 'error' ? 'error' : shelf_status === 'indexing' ? 'embedding' : 'ready', error_reason: null,
  index_generation: 1, chunker_version: 'v1', tokenizer_version: 'v1', shelf_status,
});

function installLibraryApi(rows: ShelfRow[], query = vi.fn().mockResolvedValue({ excerpts: [] })) {
  const listShelf = vi.fn().mockResolvedValue(rows);
  let shelfChanged: ((event: { type: 'library:shelf-changed'; workspace_id: string }) => void) | undefined;
  let progress: ((event: { workspace_id: string; document_id: string; source_rel_path?: string; status: ShelfRow['status']; error_reason?: string }) => void) | undefined;
  Object.assign(window, { api: { library: { listShelf, query, ingest: vi.fn(), rescan: vi.fn(), saveNote: vi.fn(), onProgress: vi.fn((callback) => { progress = callback; return () => undefined; }), onShelfChanged: vi.fn((callback) => { shelfChanged = callback; return () => undefined; }) }, files: { getPathForFile: vi.fn() } } });
  return {
    listShelf,
    query,
    emitProgress: (event: Parameters<NonNullable<typeof progress>>[0]) => progress?.(event),
    emitShelfChanged: (workspaceId = 'ws') => shelfChanged?.({ type: 'library:shelf-changed', workspace_id: workspaceId }),
  };
}

async function renderPane(): Promise<HTMLDivElement> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<LibraryPane />); }); return container;
}

async function settle(milliseconds = 0): Promise<void> { await act(async () => { await new Promise((resolve) => setTimeout(resolve, milliseconds)); }); }

beforeEach(() => {
  useDashboardStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id, openTabs: [], activeTabId: null });
  vi.spyOn(Date, 'now').mockReturnValue(42);
});

afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; vi.restoreAllMocks(); });

describe('LibraryPane rescan', () => {
  it('calls rescan with only the workspace id and shows returned counts', async () => {
    const rescan = vi.fn().mockResolvedValue({ scanned: 4, ingested: 2, skipped: 1, failed: 1 });
    Object.assign(window, { api: {
      library: {
        listShelf: vi.fn().mockResolvedValue([]),
        query: vi.fn(),
        ingest: vi.fn(),
        rescan,
        saveNote: vi.fn(),
        onProgress: vi.fn().mockReturnValue(() => undefined),
        onShelfChanged: vi.fn().mockReturnValue(() => undefined),
      },
      files: { getPathForFile: vi.fn() },
    } });
    const pane = await renderPane();
    const rescanButton = Array.from(pane.querySelectorAll('button')).find((button) => button.textContent === 'Rescan')!;
    await act(async () => { rescanButton.click(); });
    expect(rescan).toHaveBeenCalledWith('ws');
    expect(pane.querySelector('[role="status"]')?.textContent).toBe('Scanned 4; ingested 2; skipped 1; failed 1.');
  });
});

describe('openLibraryResult production seam', () => {
  it('calls openTab with the primary line and full document highlight set', () => {
    const openTab = vi.spyOn(useDashboardStore.getState(), 'openTab');
    const excerpt = {
      chunk_id: 'chunk', doc_id: 'doc', document_hash: 'hash', title: 'Manual', type: 'txt', trust: 'cleared',
      source_rel_path: '.lares/library/sources/manual.txt', reader_rel_path: '.lares/library/sources/manual.txt', quote: 'needle', citation: 'manual.txt:2-2',
      locator: { version: 1, kind: 'text', encoding: 'utf-8', line_start: 2, line_end: 2, start: { line: 2, utf16_column: 1 }, end: { line: 2, utf16_column: 7 }, canonical_char_start: 3, canonical_char_end: 9, quote: { exact: 'needle', prefix: '', suffix: '' } },
    } satisfies LibraryQueryExcerptView;
    const result = openLibraryResult(excerpt, { doc_id: 'doc', document_hash: 'hash', spans: [
      { id: 'hit', kind: 'exact', chunk_id: 'chunk', source: { start: { line: 2, utf16_column: 1 }, end: { line: 2, utf16_column: 7 }, canonical_char_start: 3, canonical_char_end: 9 } },
    ] }, 'hash');
    expect(result).toEqual({ ok: true });
    expect(openTab).toHaveBeenCalledWith('C:\\repo\\.lares\\library\\sources\\manual.txt', 'C:\\repo', 'windows', undefined, 'ws', expect.objectContaining({ lineStart: 2, highlights: [expect.objectContaining({ id: 'hit' })] }));
  });

  it('refuses stale offsets with the required message', () => {
    const excerpt = { document_hash: 'old' } as LibraryQueryExcerptView;
    expect(openLibraryResult(excerpt, undefined, 'new')).toEqual({ ok: false, error: 'Source changed; re-index and run the query again.' });
  });
});

describe('LibraryPane shelf', () => {
  it('reloads only for shelf changes in the selected workspace', async () => {
    const api = installLibraryApi([shelfRow('report', 'pending', 'untrusted')]);
    await renderPane();
    expect(api.listShelf).toHaveBeenCalledTimes(1);
    await act(async () => { api.emitShelfChanged(); await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(api.listShelf).toHaveBeenCalledTimes(2);
    await act(async () => { api.emitShelfChanged('other-workspace'); await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(api.listShelf).toHaveBeenCalledTimes(2);
  });

  it('renders ready and failed ingest states unmistakably while preserving shelf filters', async () => {
    const { listShelf } = installLibraryApi([
      shelfRow('pending', 'pending', 'untrusted'), shelfRow('stale', 'stale', 'untrusted'),
      shelfRow('indexing', 'indexing'), shelfRow('ready', 'ready'), shelfRow('error', 'error'),
    ]);
    const pane = await renderPane();
    expect(listShelf).toHaveBeenCalledWith('ws');
    expect(pane.querySelector('[aria-label="Ingested and ready to search"]')?.textContent).toContain('Ready to search');
    expect(pane.querySelector('[aria-label="Ingest failed"]')?.textContent).toContain('Ingest failed');
    expect(pane.querySelector('[aria-label="Not indexed yet; press Rescan to index"]')?.textContent).toContain('Not indexed yet');
    expect(pane.querySelectorAll('[aria-label="Ingest in progress"]')).toHaveLength(1);
    expect(pane.querySelector('[aria-label="Re-index needed"]')).not.toBeNull();
    expect(pane.querySelectorAll('[aria-label="Untrusted research report"]')).toHaveLength(2);
    expect(Array.from(pane.querySelector<HTMLSelectElement>('[aria-label="Processing state"]')!.options).map((option) => [option.value, option.text])).toEqual([
      ['', 'All states'], ['pending', 'Not indexed yet'], ['stale', 'Needs re-index'],
      ['indexing', 'Working'], ['ready', 'Ready to search'], ['error', 'Ingest failed'],
    ]);
  });

  it('ignores a stale reload that resolves after a newer shelf response', async () => {
    let resolveFirst!: (rows: ShelfRow[]) => void;
    const first = new Promise<ShelfRow[]>((resolve) => { resolveFirst = resolve; });
    const api = installLibraryApi([]);
    api.listShelf.mockReturnValueOnce(first).mockResolvedValueOnce([shelfRow('newer', 'ready')]);
    const pane = await renderPane();
    await act(async () => { api.emitShelfChanged(); await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(pane.textContent).toContain('newer');
    await act(async () => { resolveFirst([shelfRow('older', 'pending')]); await Promise.resolve(); });
    expect(pane.textContent).toContain('newer');
    expect(pane.textContent).not.toContain('older');
  });

  it('retints a synthetic shelf row when progress matches its normalized source path', async () => {
    const pending = shelfRow('synthetic', 'stale');
    pending.id = 'shelf:.lares/library/inbox/report.md';
    pending.source_rel_path = '.lares/library/inbox/Report.md';
    const api = installLibraryApi([pending]);
    const pane = await renderPane();
    expect(pane.querySelector('[data-shelf-status="stale"]')).not.toBeNull();
    await act(async () => { api.emitProgress({ workspace_id: 'ws', document_id: 'real-id', source_rel_path: '.lares\\library\\inbox\\report.md', status: 'embedding' }); });
    expect(pane.querySelector('[data-shelf-status="indexing"]')).not.toBeNull();
  });

  it('case-folds progress paths before workspace metadata is available', async () => {
    const pending = shelfRow('synthetic', 'pending');
    pending.id = 'shelf:.lares/library/inbox/report.md';
    pending.source_rel_path = '.lares/library/inbox/Report.md';
    const api = installLibraryApi([pending]);
    useDashboardStore.setState({ workspaces: [] });
    const pane = await renderPane();
    await act(async () => { api.emitProgress({ workspace_id: 'ws', document_id: 'real-id', source_rel_path: '.lares\\library\\inbox\\report.md', status: 'embedding' }); });
    expect(pane.querySelector('[data-shelf-status="indexing"]')).not.toBeNull();
  });

  it('passes only ready shelf ids to query and short-circuits an empty filtered eligible set', async () => {
    const { query } = installLibraryApi([shelfRow('ready-doc', 'ready'), shelfRow('stale-doc', 'stale')]);
    const pane = await renderPane();
    const search = pane.querySelector<HTMLInputElement>('[aria-label="Search library"]')!;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { valueSetter.call(search, 'first'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(300);
    expect(query, 'REACHABILITY:LibraryPane:list-shelf').toHaveBeenCalledWith('ws', expect.objectContaining({ doc_ids: ['ready-doc'] }));
    const state = pane.querySelector<HTMLSelectElement>('[aria-label="Processing state"]')!;
    await act(async () => { state.value = 'stale'; state.dispatchEvent(new Event('change', { bubbles: true })); });
    query.mockClear();
    await act(async () => { valueSetter.call(search, 'second'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(300);
    expect(query).not.toHaveBeenCalled();
  });
});
