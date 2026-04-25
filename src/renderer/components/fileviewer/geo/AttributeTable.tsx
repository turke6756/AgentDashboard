import React, { useMemo, useState } from 'react';

interface Props {
  rows: Record<string, any>[];
  onRowHover?: (index: number | null) => void;
  onRowClick?: (index: number) => void;
  highlightIndex?: number | null;
  maxRows?: number;
}

export default function AttributeTable({ rows, onRowHover, onRowClick, highlightIndex, maxRows = 1000 }: Props) {
  const [visibleCount, setVisibleCount] = useState(maxRows);
  const columns = useMemo(() => {
    const cols = new Set<string>();
    for (const r of rows.slice(0, 200)) Object.keys(r).forEach((k) => cols.add(k));
    return Array.from(cols);
  }, [rows]);

  const shown = rows.slice(0, visibleCount);
  const truncated = rows.length > visibleCount;

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 font-sans">
        No features
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto csv-grid-scroll">
        <table className="csv-grid border-separate border-spacing-0 font-sans text-[12px]">
          <thead>
            <tr>
              <th className="csv-corner sticky top-0 left-0 z-30" />
              {columns.map((c) => (
                <th key={c} className="csv-col-header sticky top-0 z-20">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => {
              const isHL = highlightIndex === r;
              return (
                <tr
                  key={r}
                  onMouseEnter={() => onRowHover?.(r)}
                  onMouseLeave={() => onRowHover?.(null)}
                  onClick={() => onRowClick?.(r)}
                  style={isHL ? { outline: '1px solid #f5a623' } : undefined}
                >
                  <th className="csv-row-header sticky left-0 z-10">{r + 1}</th>
                  {columns.map((c) => {
                    const v = row[c];
                    const display =
                      v === null || v === undefined ? '' :
                      typeof v === 'object' ? JSON.stringify(v) :
                      String(v);
                    const isNumeric = typeof v === 'number' || (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()));
                    return (
                      <td key={c} className={`csv-cell ${isNumeric ? 'csv-cell-num' : ''}`}>{display}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {truncated && (
        <div className="px-3 py-1.5 border-t border-surface-3 bg-surface-1 text-[11px] text-gray-400 flex items-center justify-between shrink-0">
          <span>Showing {visibleCount.toLocaleString()} of {rows.length.toLocaleString()} rows</span>
          <button
            onClick={() => setVisibleCount((c) => c + maxRows)}
            className="text-accent-blue hover:underline"
          >
            Load {Math.min(maxRows, rows.length - visibleCount).toLocaleString()} more
          </button>
        </div>
      )}
    </div>
  );
}
