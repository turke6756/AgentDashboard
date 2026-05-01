import type { ISharedCell, ISharedCodeCell, ISharedMarkdownCell, ISharedRawCell } from '@jupyter/ydoc';
import { CodeCell } from './CodeCell';
import { MarkdownCell } from './MarkdownCell';
import { OutputRenderer } from './OutputRenderer';
import { StaticCodeBlock } from './StaticCodeBlock';
import { CellToolbar } from './CellToolbar';
import type { NotebookCellStatus } from '../../stores/cellStatus';

interface CellShellProps {
  cell: ISharedCell;
  index: number;
  totalCells: number;
  status: NotebookCellStatus;
  isVisible: boolean;
  language: string;
  busy: boolean;
  onRunCell: (cellId: string) => void;
  onAddCodeBelow: (index: number) => void;
  onAddMarkdownBelow: (index: number) => void;
  onDeleteCell: (index: number) => void;
  onMoveCellUp: (index: number) => void;
  onMoveCellDown: (index: number) => void;
}

export function CellShell({
  cell,
  index,
  totalCells,
  status,
  isVisible,
  language,
  busy,
  onRunCell,
  onAddCodeBelow,
  onAddMarkdownBelow,
  onDeleteCell,
  onMoveCellUp,
  onMoveCellDown,
}: CellShellProps) {
  return (
    <article className="notebook-cell-body group relative min-w-0">
      {status === 'running' || status === 'queued' ? (
        <div className={`notebook-cell-activity ${status === 'queued' ? 'notebook-cell-activity-queued' : ''}`} />
      ) : null}
      <CellToolbar
        canRun={cell.cell_type === 'code'}
        canMoveUp={index > 0}
        canMoveDown={index < totalCells - 1}
        busy={busy}
        onRun={() => onRunCell(cell.id)}
        onAddCodeBelow={() => onAddCodeBelow(index)}
        onAddMarkdownBelow={() => onAddMarkdownBelow(index)}
        onDelete={() => onDeleteCell(index)}
        onMoveUp={() => onMoveCellUp(index)}
        onMoveDown={() => onMoveCellDown(index)}
      />
      {cell.cell_type === 'code' ? (
        <CodeCellShell cell={cell} isVisible={isVisible} language={language} />
      ) : cell.cell_type === 'markdown' ? (
        <MarkdownCell cell={cell} />
      ) : cell.cell_type === 'raw' ? (
        <RawCellShell cell={cell} />
      ) : (
        <UnknownCellShell cell={cell} />
      )}
    </article>
  );
}

function CodeCellShell({
  cell,
  isVisible,
  language,
}: {
  cell: ISharedCodeCell;
  isVisible: boolean;
  language: string;
}) {
  return (
    <>
      {isVisible && cell.awareness ? (
        <CodeCell
          cellId={cell.id}
          ytext={cell.ysource}
          awareness={cell.awareness}
          language={language}
        />
      ) : (
        <StaticCodeBlock source={cell.source} language={language} />
      )}
      <OutputRenderer outputs={cell.outputs} />
    </>
  );
}

function RawCellShell({ cell }: { cell: ISharedRawCell }) {
  return (
    <pre className="m-0 overflow-auto px-5 py-4 font-mono text-xs leading-5 text-fg-secondary">
      {cell.source || <span className="text-fg-muted">(empty)</span>}
    </pre>
  );
}

function UnknownCellShell({ cell }: { cell: ISharedCell }) {
  return (
    <div className="px-5 py-4">
      <div className="mb-2 font-sans text-[11px] uppercase text-accent-yellow">
        Unsupported cell type: {cell.cell_type}
      </div>
      <pre className="m-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-fg-secondary">
        {cell.source || <span className="text-fg-muted">(empty)</span>}
      </pre>
    </div>
  );
}
