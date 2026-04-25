import { useEffect } from 'react';
import { useYNotebook } from '../../hooks/useYNotebook';

export function NotebookView({ path }: { path: string }) {
  const { ynotebook, status, error } = useYNotebook(path);
  const cells = ynotebook?.cells ?? [];
  const logSignature = cells
    .map((cell) => `${cell.id}:${cell.cell_type}:${previewSource(cell.source)}`)
    .join('|');

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
    <div className="h-full overflow-auto bg-surface-0 text-fg-primary">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-surface-3 bg-surface-base px-4 py-2 font-sans">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg-primary">{path}</div>
          <div className="text-[11px] text-fg-muted">Notebook renderer rebuild - Phase 1 ydoc sync</div>
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
              ? `${cells.length} cells synced. See DevTools console for cell type/source previews.`
              : 'Connecting to notebook collaboration room...'}
          </div>
          <div className="divide-y divide-surface-3 border border-surface-3">
            {cells.length === 0 ? (
              <div className="p-4 text-sm text-fg-muted">
                {status === 'synced' ? 'Notebook has no cells.' : 'Waiting for cells...'}
              </div>
            ) : (
              cells.map((cell, index) => (
                <div key={cell.id} className="grid grid-cols-[72px_minmax(0,1fr)] bg-surface-1">
                  <div className="border-r border-surface-3 px-3 py-2 text-right text-[11px] uppercase text-fg-muted">
                    {cell.cell_type}
                  </div>
                  <pre className="m-0 overflow-hidden whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5 text-fg-primary">
                    <span className="select-none text-fg-muted">{index + 1}. </span>
                    {previewSource(cell.source) || <span className="text-fg-muted">(empty)</span>}
                  </pre>
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
