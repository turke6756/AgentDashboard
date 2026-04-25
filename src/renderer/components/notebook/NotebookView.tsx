import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CellShell } from './CellShell';
import { useYNotebook } from '../../hooks/useYNotebook';

export function NotebookView({ path }: { path: string }) {
  const { ynotebook, status, error } = useYNotebook(path);
  const cells = ynotebook?.cells ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const notebookLanguage = useMemo(() => getNotebookLanguage(ynotebook), [ynotebook]);
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

      {error ? (
        <div className="m-4 border border-accent-red/40 bg-accent-red/10 p-4 font-sans text-sm text-accent-red">
          {error}
        </div>
      ) : (
        <div className="p-4 font-sans">
          <div className="mb-3 text-sm text-fg-secondary">
            {status === 'synced'
              ? `${cells.length} cells synced. Virtualized read-only renderer is active.`
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
                    {cell.cell_type}
                  </div>
                  <div className="min-w-0">
                    <CellShell
                      cell={cell}
                      isVisible={visibleIndexes.has(index)}
                      language={notebookLanguage}
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
