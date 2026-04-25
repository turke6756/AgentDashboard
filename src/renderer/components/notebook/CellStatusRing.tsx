import type { NotebookCellStatus } from '../../stores/cellStatus';

export function CellStatusRing({ status }: { status: NotebookCellStatus }) {
  const className =
    status === 'running'
      ? 'border-accent-blue bg-accent-blue notebook-status-ring-running'
      : status === 'queued'
        ? 'border-accent-yellow bg-transparent'
        : status === 'done'
          ? 'border-accent-green bg-accent-green'
          : status === 'error'
            ? 'border-accent-red bg-accent-red'
            : 'border-surface-3 bg-surface-2';

  return <span className={`inline-flex h-2.5 w-2.5 rounded-full border ${className}`} aria-hidden="true" />;
}
