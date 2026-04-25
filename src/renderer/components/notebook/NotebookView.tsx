import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CellShell } from './CellShell';
import { useYNotebook } from '../../hooks/useYNotebook';
import { useNotebookActions } from '../../hooks/useNotebookActions';
import { NotebookToolbar } from './NotebookToolbar';
import { NotebookActivityBar } from './NotebookActivityBar';
import { CellStatusRing } from './CellStatusRing';
import { useCellStatusStore } from '../../stores/cellStatus';
import { toJupyterServerPath } from '../../lib/jupyterCollab';

export function NotebookView({ path }: { path: string }) {
  const { ynotebook, status, error } = useYNotebook(path);
  const {
    kernelStatusLabel,
    kernelState,
    pendingAction,
    actionError,
    runCell,
    runAll,
    interruptKernel,
    restartKernel,
    addCodeCell,
    addMarkdownCell,
    deleteCell,
    moveCellUp,
    moveCellDown,
    clearActionError,
  } = useNotebookActions(path, ynotebook);
  const cells = ynotebook?.cells ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const notebookLanguage = useMemo(() => getNotebookLanguage(ynotebook), [ynotebook]);
  const notebookPath = useMemo(() => toJupyterServerPath(path), [path]);
  const cellStatuses = useCellStatusStore((state) => state.cellStatuses[notebookPath] ?? {});
  const lastRunErrored = useCellStatusStore((state) => state.lastRunErrored[notebookPath] ?? false);
  const logSignature = cells
    .map((cell) => `${cell.id}:${cell.cell_type}:${previewSource(cell.source)}`)
    .join('|');
  const virtualizer = useVirtualizer({
    count: cells.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 5,
  });
  const visibleIndexes = new Set(virtualizer.getVirtualItems().map((item) => item.index));
  const hasRunningCell = Object.values(cellStatuses).some((value) => value === 'queued' || value === 'running');

  useEffect(() => {
    if (status !== 'synced' || !ynotebook) return;

    console.groupCollapsed(`[notebook] synced ${path} (${cells.length} cells)`);
    cells.forEach((cell, index) => {
      console.log(
        `[notebook] cell ${index + 1}/${cells.length}`,
        cell.cell_type,
        previewSource(cell.source)
      );
    });
    console.groupEnd();
  }, [cells, logSignature, path, status, ynotebook]);

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-surface-0 text-fg-primary">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-surface-3 bg-surface-base px-4 py-2 font-sans">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg-primary">{path}</div>
          <div className="text-[11px] text-fg-muted">
            {status === 'synced'
              ? `${cells.length} cells, ${countCodeCells(cells)} code, language ${notebookLanguage}`
              : 'Notebook renderer rebuild - loading shared notebook'}
          </div>
        </div>
        <StatusPill status={status} />
      </div>

      <NotebookToolbar
        kernelStatus={kernelStatusLabel}
        isReady={status === 'synced'}
        isBusy={hasRunningCell || pendingAction === 'run-all' || pendingAction === 'run-cell' || kernelState?.execution_state === 'busy'}
        onRunAll={() => void runAll()}
        onAddCode={() => addCodeCell(cells.length - 1)}
        onAddMarkdown={() => addMarkdownCell(cells.length - 1)}
        onInterrupt={() => void interruptKernel()}
        onRestart={() => void restartKernel()}
      />
      <NotebookActivityBar running={hasRunningCell} errored={lastRunErrored} />

      {error ? (
        <div className="m-4 border border-accent-red/40 bg-accent-red/10 p-4 font-sans text-sm text-accent-red">
          {error}
        </div>
      ) : (
        <div className="p-4 font-sans">
          {actionError ? (
            <div className="mb-3 flex items-start justify-between gap-3 border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
              <span>{actionError}</span>
              <button type="button" className="ui-btn min-h-0 px-2 py-0.5 text-[11px]" onClick={clearActionError}>
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="mb-3 text-sm text-fg-secondary">
            {status === 'synced'
              ? `${cells.length} cells synced. Shared notebook actions are active.`
              : 'Connecting to notebook collaboration room...'}
          </div>
          <div className="border border-surface-3">
            {cells.length === 0 ? (
              <div className="p-4 text-sm text-fg-muted">
                {status === 'synced' ? 'Notebook has no cells.' : 'Waiting for cells...'}
              </div>
            ) : (
              cells.map((cell, index) => (
                <div
                  key={cell.id}
                  data-index={index}
                  ref={(node) => {
                    if (node) {
                      virtualizer.measureElement(node);
                    }
                  }}
                  className="grid grid-cols-[56px_minmax(0,1fr)] bg-surface-1"
                >
                  <div className="border-r border-surface-3 px-2 py-3 text-right text-[11px] uppercase text-fg-muted">
                    <div className="mb-1 flex items-center justify-end gap-1.5">
                      <CellStatusRing status={cellStatuses[cell.id] ?? 'idle'} />
                      <span>{cell.cell_type}</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <CellShell
                      cell={cell}
                      index={index}
                      totalCells={cells.length}
                      isVisible={visibleIndexes.has(index)}
                      language={notebookLanguage}
                      busy={pendingAction !== null}
                      onRunCell={(cellId) => {
                        if (cell.cell_type !== 'code') return;
                        void runCell(cellId);
                      }}
                      onDeleteCell={deleteCell}
                      onMoveCellUp={moveCellUp}
                      onMoveCellDown={moveCellDown}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: 'connecting' | 'synced' | 'error' }) {
  const label = status === 'connecting' ? 'connecting...' : status;
  const className =
    status === 'synced'
      ? 'border-accent-green/50 bg-accent-green/10 text-accent-green'
      : status === 'error'
        ? 'border-accent-red/50 bg-accent-red/10 text-accent-red'
        : 'border-accent-yellow/50 bg-accent-yellow/10 text-accent-yellow';

  return (
    <div className={`shrink-0 border px-2 py-1 text-[11px] uppercase tracking-[0.08em] ${className}`}>
      {label}
    </div>
  );
}

function previewSource(source: string): string {
  return source.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function countCodeCells(cells: Array<{ cell_type: string }>) {
  return cells.filter((cell) => cell.cell_type === 'code').length;
}

function getNotebookLanguage(
  ynotebook: {
    metadata?: {
      kernelspec?: { language?: string };
      language_info?: { name?: string };
    };
  } | null
): string {
  return (
    ynotebook?.metadata?.kernelspec?.language?.toLowerCase() ||
    ynotebook?.metadata?.language_info?.name?.toLowerCase() ||
    'python'
  );
}
