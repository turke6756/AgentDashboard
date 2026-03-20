import React, { useMemo } from 'react';
import * as Icons from 'lucide-react';
import { parseSymbols, CodeSymbol } from '../../utils/symbol-parser';

interface Props {
  content: string;
  language: string;
  onSymbolClick: (line: number) => void;
}

export default function SymbolOutline({ content, language, onSymbolClick }: Props) {
  const symbols = useMemo(() => parseSymbols(content, language), [content, language]);

  if (symbols.length === 0) return null;

  const getIcon = (kind: CodeSymbol['kind']) => {
    switch (kind) {
      case 'class': return <Icons.Box className="w-3.5 h-3.5 text-orange-400" />;
      case 'function': return <Icons.FunctionSquare className="w-3.5 h-3.5 text-purple-400" />;
      case 'method': return <Icons.Cube className="w-3.5 h-3.5 text-blue-400" />;
      case 'variable': return <Icons.Variable className="w-3.5 h-3.5 text-blue-300" />;
      case 'interface': return <Icons.Braces className="w-3.5 h-3.5 text-yellow-400" />;
      default: return <Icons.Circle className="w-3 h-3 text-gray-400" />;
    }
  };

  return (
    <div className="h-full flex flex-col border-l border-accent-blue/10 bg-surface-0/40 w-48 shrink-0">
      <div className="px-3 py-2 border-b border-accent-blue/10">
        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-500">Outline</div>
      </div>
      <div className="flex-1 overflow-y-auto py-1 scrollbar-thin">
        {symbols.map((symbol, i) => (
          <button
            key={i}
            onClick={() => onSymbolClick(symbol.line)}
            className="w-full text-left flex items-center gap-2 px-3 py-1 hover:bg-surface-2/60 transition-colors group"
          >
            <span className="shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
              {getIcon(symbol.kind)}
            </span>
            <span className="text-[11px] font-mono text-gray-400 group-hover:text-gray-200 truncate">
              {symbol.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
