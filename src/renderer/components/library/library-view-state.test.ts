import { beforeEach, describe, expect, it } from 'vitest';
import { useLibraryViewState } from './library-view-state';

describe('library view session state', () => {
  beforeEach(() => useLibraryViewState.getState().reset());

  it('restores all session fields after consumers unmount and isolates workspaces', () => {
    const store = useLibraryViewState.getState();
    store.ensureWorkspace('a');
    store.updateWorkspace('a', { draftQuery: 'draft', executedQuery: 'query', sort: 'title', selectedChunkIds: ['c1'], scrollOffset: 72, filters: { ...store.ensureWorkspace('a').filters, topic: 'agents' } });
    store.ensureWorkspace('b', 'research');
    expect(useLibraryViewState.getState().byWorkspace.a).toMatchObject({ draftQuery: 'draft', executedQuery: 'query', sort: 'title', selectedChunkIds: ['c1'], scrollOffset: 72, filters: { topic: 'agents' } });
    expect(useLibraryViewState.getState().byWorkspace.b.filters.types).toEqual(['research']);
    expect(useLibraryViewState.getState().byWorkspace.b.draftQuery).toBe('');
  });

  it('replaces selected IDs and prunes removed workspace keys', () => {
    const store = useLibraryViewState.getState();
    store.ensureWorkspace('keep'); store.ensureWorkspace('remove');
    store.updateWorkspace('keep', { selectedChunkIds: ['old'] });
    store.updateWorkspace('keep', { selectedChunkIds: ['new-1', 'new-2'] });
    store.pruneWorkspaces(['keep']);
    expect(useLibraryViewState.getState().byWorkspace.keep.selectedChunkIds).toEqual(['new-1', 'new-2']);
    expect(useLibraryViewState.getState().byWorkspace.remove).toBeUndefined();
  });
});
