import { ArrowDown, ArrowUp, Code2, FileText, Play, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

interface CellToolbarProps {
  canRun: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  busy: boolean;
  onRun: () => void;
  onAddCodeBelow: () => void;
  onAddMarkdownBelow: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

export function CellToolbar({
  canRun,
  canMoveUp,
  canMoveDown,
  busy,
  onRun,
  onAddCodeBelow,
  onAddMarkdownBelow,
  onDelete,
  onMoveUp,
  onMoveDown,
}: CellToolbarProps) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      {canRun ? (
        <IconButton label="Run cell" onClick={onRun} disabled={busy} tone="success">
          <Play size={14} strokeWidth={2} />
        </IconButton>
      ) : null}
      <IconButton label="Add code cell below" onClick={onAddCodeBelow} disabled={busy}>
        <Code2 size={14} strokeWidth={2} />
      </IconButton>
      <IconButton label="Add markdown cell below" onClick={onAddMarkdownBelow} disabled={busy}>
        <FileText size={14} strokeWidth={2} />
      </IconButton>
      <IconButton label="Move cell up" onClick={onMoveUp} disabled={!canMoveUp || busy}>
        <ArrowUp size={14} strokeWidth={2} />
      </IconButton>
      <IconButton label="Move cell down" onClick={onMoveDown} disabled={!canMoveDown || busy}>
        <ArrowDown size={14} strokeWidth={2} />
      </IconButton>
      <IconButton label="Delete cell" onClick={onDelete} disabled={busy} tone="danger">
        <Trash2 size={14} strokeWidth={2} />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  tone,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tone?: 'success' | 'danger';
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const toneClass = tone === 'success' ? 'ui-btn-success' : tone === 'danger' ? 'ui-btn-danger' : '';

  return (
    <button
      type="button"
      className={`ui-btn notebook-icon-btn ${toneClass}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
