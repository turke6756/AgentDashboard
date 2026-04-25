import React, { useMemo, useState } from 'react';

interface Props {
  content: string;
  filePath: string;
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function colLabel(index: number): string {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function detectDelimiter(filePath: string, sample: string): string {
  if (/\.tsv$/i.test(filePath)) return '\t';
  const firstLine = sample.split(/\r?\n/, 1)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

const MAX_ROWS = 5000;

export default function CsvRenderer({ content, filePath }: Props) {
  const [showHeaderRow, setShowHeaderRow] = useState(true);

  const { rows, truncated, delimiter } = useMemo(() => {
    const delim = detectDelimiter(filePath, content);
    const parsed = parseDelimited(content, delim);
    const trimmed = parsed.length > 0 && parsed[parsed.length - 1].every((c) => c === '')
      ? parsed.slice(0, -1)
      : parsed;
    const truncated = trimmed.length > MAX_ROWS;
    return {
      rows: truncated ? trimmed.slice(0, MAX_ROWS) : trimmed,
      truncated,
      delimiter: delim,
    };
  }, [content, filePath]);

  const colCount = useMemo(
    () => rows.reduce((max, r) => Math.max(max, r.length), 0),
    [rows],
  );

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 font-sans">
        Empty file
      </div>
    );
  }

  const headerRow = showHeaderRow ? rows[0] : null;
  const dataRows = showHeaderRow ? rows.slice(1) : rows;
  const delimiterLabel = delimiter === '\t' ? 'Tab' : delimiter === ';' ? 'Semicolon' : 'Comma';

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-surface-3 bg-surface-1 text-[11px] font-sans text-gray-400 shrink-0">
        <div className="flex items-center gap-4">
          <span>
            <span className="text-gray-300">{rows.length.toLocaleString()}</span> rows
            {' · '}
            <span className="text-gray-300">{colCount.toLocaleString()}</span> cols
            {' · '}
            <span className="text-gray-300">{delimiterLabel}</span>-separated
          </span>
          {truncated && (
            <span className="text-accent-yellow">Showing first {MAX_ROWS.toLocaleString()} rows</span>
          )}
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showHeaderRow}
            onChange={(e) => setShowHeaderRow(e.target.checked)}
            className="accent-accent-blue"
          />
          First row is header
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-auto csv-grid-scroll">
        <table className="csv-grid border-separate border-spacing-0 font-sans text-[12px]">
          <thead>
            <tr>
              <th className="csv-corner sticky top-0 left-0 z-30" />
              {Array.from({ length: colCount }).map((_, c) => (
                <th
                  key={c}
                  className="csv-col-header sticky top-0 z-20"
                >
                  {colLabel(c)}
                </th>
              ))}
            </tr>
            {headerRow && (
              <tr>
                <th className="csv-row-header sticky left-0 z-20 csv-header-row-num">1</th>
                {Array.from({ length: colCount }).map((_, c) => (
                  <th key={c} className="csv-cell csv-header-cell">
                    {headerRow[c] ?? ''}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {dataRows.map((row, r) => {
              const displayRowNum = showHeaderRow ? r + 2 : r + 1;
              return (
                <tr key={r}>
                  <th className="csv-row-header sticky left-0 z-10">{displayRowNum}</th>
                  {Array.from({ length: colCount }).map((_, c) => {
                    const value = row[c] ?? '';
                    const isNumeric = value !== '' && !isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value.trim());
                    return (
                      <td key={c} className={`csv-cell ${isNumeric ? 'csv-cell-num' : ''}`}>
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
