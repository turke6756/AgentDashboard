interface CellToolbarProps {
  canRun: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  busy: boolean;
  onRun: () => void;
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
  onDelete,
  onMoveUp,
  onMoveDown,
}: CellToolbarProps) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      {canRun ? (
        <button type="button" className="ui-btn ui-btn-success min-h-0 px-2 py-1 text-[11px]" onClick={onRun} disabled={busy}>
          Run
        </button>
      ) : null}
      <button type="button" className="ui-btn min-h-0 px-2 py-1 text-[11px]" onClick={onMoveUp} disabled={!canMoveUp || busy}>
        Up
      </button>
      <button type="button" className="ui-btn min-h-0 px-2 py-1 text-[11px]" onClick={onMoveDown} disabled={!canMoveDown || busy}>
        Down
      </button>
      <button type="button" className="ui-btn ui-btn-danger min-h-0 px-2 py-1 text-[11px]" onClick={onDelete} disabled={busy}>
        Delete
      </button>
    </div>
  );
}
