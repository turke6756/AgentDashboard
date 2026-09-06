// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { openLibraryResult, type LibraryQueryExcerptView } from './library-result-navigation';

const workspace = { id: 'ws', path: 'C:\\repo', pathType: 'windows' } as Workspace;

beforeEach(() => {
  useDashboardStore.setState({ workspaces: [workspace], selectedWorkspaceId: workspace.id, openTabs: [], activeTabId: null });
  vi.spyOn(Date, 'now').mockReturnValue(42);
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
