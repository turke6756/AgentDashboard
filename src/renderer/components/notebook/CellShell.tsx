import type { ISharedCell, ISharedCodeCell, ISharedMarkdownCell, ISharedRawCell } from '@jupyter/ydoc';
import { CodeCell } from './CodeCell';
import { MarkdownCell } from './MarkdownCell';
import { OutputRenderer } from './OutputRenderer';
import { StaticCodeBlock } from './StaticCodeBlock';

interface CellShellProps {
  cell: ISharedCell;
  isVisible: boolean;
  language: string;
}

export function CellShell({ cell, isVisible, language }: CellShellProps) {
  return (
    <article className="border-b border-surface-3 bg-surface-0">
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
      <div className="grid grid-cols-[56px_minmax(0,1fr)]">
        <div className="border-r border-surface-3 px-2 py-3 text-right font-mono text-[11px] text-fg-muted">
          {formatExecutionCount(cell.execution_count)}
        </div>
        <div className="min-w-0">
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
        </div>
      </div>
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

function formatExecutionCount(executionCount: number | null) {
  return executionCount == null ? '[ ]' : `[${executionCount}]`;
}
