import { FileText, Play, Plus, RotateCcw, Square } from 'lucide-react';

interface NotebookToolbarProps {
  kernelStatus: string;
  isReady: boolean;
  isBusy: boolean;
  onRunAll: () => void;
  onAddCode: () => void;
  onAddMarkdown: () => void;
  onInterrupt: () => void;
  onRestart: () => void;
}

export function NotebookToolbar({
  kernelStatus,
  isReady,
  isBusy,
  onRunAll,
  onAddCode,
  onAddMarkdown,
  onInterrupt,
  onRestart,
}: NotebookToolbarProps) {
  return (
    <div className="notebook-toolbar sticky top-[49px] z-10 flex flex-wrap items-center gap-2 border-b border-surface-3 bg-surface-1/95 px-4 py-2 backdrop-blur-sm">
      <button type="button" className="ui-btn ui-btn-primary text-[12px]" onClick={onRunAll} disabled={!isReady || isBusy}>
        <Play size={14} strokeWidth={2} />
        Run all
      </button>
      <button type="button" className="ui-btn text-[12px]" onClick={onAddCode} disabled={!isReady}>
        <Plus size={14} strokeWidth={2} />
        Add code
      </button>
      <button type="button" className="ui-btn text-[12px]" onClick={onAddMarkdown} disabled={!isReady}>
        <FileText size={14} strokeWidth={2} />
        Add markdown
      </button>
      <button type="button" className="ui-btn ui-btn-warning text-[12px]" onClick={onInterrupt} disabled={!isReady}>
        <Square size={13} strokeWidth={2} />
        Interrupt
      </button>
      <button type="button" className="ui-btn ui-btn-danger text-[12px]" onClick={onRestart} disabled={!isReady}>
        <RotateCcw size={14} strokeWidth={2} />
        Restart
      </button>
      <div className="ml-auto flex min-w-[160px] items-center justify-end gap-2 rounded-[4px] border border-surface-3 bg-surface-0 px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-fg-muted">
        <span className={`h-2 w-2 rounded-full ${isBusy ? 'bg-accent-yellow animate-pulse' : 'bg-accent-green'}`} />
        <span className="truncate">{kernelStatus}</span>
      </div>
    </div>
  );
}
