import { create } from 'zustand';

export type NotebookCellStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';

interface NotebookStatusState {
  cellStatuses: Record<string, Record<string, NotebookCellStatus>>;
  lastRunErrored: Record<string, boolean>;
  syncNotebookCells: (notebookPath: string, cellIds: string[]) => void;
  setCellStatus: (notebookPath: string, cellId: string, status: NotebookCellStatus) => void;
  setManyCellStatus: (notebookPath: string, cellIds: string[], status: NotebookCellStatus) => void;
  clearNotebookRunState: (notebookPath: string) => void;
  markNotebookError: (notebookPath: string, errored: boolean) => void;
}

export const useCellStatusStore = create<NotebookStatusState>((set) => ({
  cellStatuses: {},
  lastRunErrored: {},
  syncNotebookCells: (notebookPath, cellIds) =>
    set((state) => {
      const nextNotebookState: Record<string, NotebookCellStatus> = {};
      const current = state.cellStatuses[notebookPath] ?? {};
      for (const cellId of cellIds) {
        nextNotebookState[cellId] = current[cellId] ?? 'idle';
      }
      return {
        cellStatuses: {
          ...state.cellStatuses,
          [notebookPath]: nextNotebookState,
        },
      };
    }),
  setCellStatus: (notebookPath, cellId, status) =>
    set((state) => ({
      cellStatuses: {
        ...state.cellStatuses,
        [notebookPath]: {
          ...(state.cellStatuses[notebookPath] ?? {}),
          [cellId]: status,
        },
      },
    })),
  setManyCellStatus: (notebookPath, cellIds, status) =>
    set((state) => {
      const notebookState = { ...(state.cellStatuses[notebookPath] ?? {}) };
      for (const cellId of cellIds) {
        notebookState[cellId] = status;
      }
      return {
        cellStatuses: {
          ...state.cellStatuses,
          [notebookPath]: notebookState,
        },
      };
    }),
  clearNotebookRunState: (notebookPath) =>
    set((state) => {
      const current = state.cellStatuses[notebookPath] ?? {};
      const nextNotebookState: Record<string, NotebookCellStatus> = {};
      for (const [cellId] of Object.entries(current)) {
        nextNotebookState[cellId] = 'idle';
      }
      return {
        cellStatuses: {
          ...state.cellStatuses,
          [notebookPath]: nextNotebookState,
        },
        lastRunErrored: {
          ...state.lastRunErrored,
          [notebookPath]: false,
        },
      };
    }),
  markNotebookError: (notebookPath, errored) =>
    set((state) => ({
      lastRunErrored: {
        ...state.lastRunErrored,
        [notebookPath]: errored,
      },
    })),
}));
