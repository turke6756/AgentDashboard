import { create } from 'zustand';
import { EMPTY_LIBRARY_FILTERS, type LibraryFilterState } from './LibraryFilters';

export type LibrarySort = 'newest' | 'title' | 'type';

export interface LibraryWorkspaceViewState {
  draftQuery: string;
  executedQuery: string;
  filters: LibraryFilterState;
  sort: LibrarySort;
  selectedChunkIds: string[];
  scrollOffset: number;
}

const defaultWorkspaceState = (): LibraryWorkspaceViewState => ({
  draftQuery: '',
  executedQuery: '',
  filters: { ...EMPTY_LIBRARY_FILTERS, types: [] },
  sort: 'newest',
  selectedChunkIds: [],
  scrollOffset: 0,
});

interface LibraryViewStore {
  byWorkspace: Record<string, LibraryWorkspaceViewState>;
  ensureWorkspace: (workspaceId: string, initialType?: 'research') => LibraryWorkspaceViewState;
  updateWorkspace: (workspaceId: string, patch: Partial<LibraryWorkspaceViewState>) => void;
  pruneWorkspaces: (workspaceIds: readonly string[]) => void;
  reset: () => void;
}

export const useLibraryViewState = create<LibraryViewStore>((set, get) => ({
  byWorkspace: {},
  ensureWorkspace: (workspaceId, initialType) => {
    const existing = get().byWorkspace[workspaceId];
    if (existing) return existing;
    const created = defaultWorkspaceState();
    if (initialType) created.filters.types = [initialType];
    set((state) => ({ byWorkspace: { ...state.byWorkspace, [workspaceId]: created } }));
    return created;
  },
  updateWorkspace: (workspaceId, patch) => set((state) => ({
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: { ...(state.byWorkspace[workspaceId] ?? defaultWorkspaceState()), ...patch },
    },
  })),
  pruneWorkspaces: (workspaceIds) => set((state) => {
    const keep = new Set(workspaceIds);
    return { byWorkspace: Object.fromEntries(Object.entries(state.byWorkspace).filter(([id]) => keep.has(id))) };
  }),
  reset: () => set({ byWorkspace: {} }),
}));
