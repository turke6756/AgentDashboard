import React from 'react';

interface Props {
  content: string;
}

export default function PlainTextRenderer({ content }: Props) {
  const lines = content.split('\n');
  const gutterWidth = String(lines.length).length;

  return (
    <div className="overflow-auto h-full font-mono text-sm">
      <pre className="p-4">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span
              className="select-none text-gray-600 text-right pr-4 shrink-0"
              style={{ minWidth: `${gutterWidth + 2}ch` }}
            >
              {i + 1}
            </span>
            <span className="text-gray-300 whitespace-pre">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
