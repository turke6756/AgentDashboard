import React, { useState } from 'react';
import * as Icons from 'lucide-react';

interface Props {
  filePath: string;
  pathType: 'windows' | 'wsl';
}

export default function ImageRenderer({ filePath, pathType }: Props) {
  const src = `media://file/${encodeURIComponent(filePath)}`;
  const [scale, setScale] = useState(1);
  const [error, setError] = useState(false);

  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 5));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.25));
  const handleReset = () => setScale(1);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <Icons.ImageOff className="w-10 h-10 text-gray-400 mx-auto mb-4" />
          <div className="text-gray-400 font-sans text-sm mb-2">Failed to load image</div>
          <div className="text-gray-400 font-sans text-[13px] mb-4 max-w-md break-all">{filePath}</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="px-4 py-2 text-[13px] font-sans   text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open externally
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f] overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-surface-1/40 border-b border-white/5 shrink-0">
        <button
          onClick={handleZoomOut}
          className="p-1 text-gray-400 hover:text-white hover:bg-white/5 rounded transition-colors"
          title="Zoom Out"
        >
          <Icons.Minus className="w-4 h-4" />
        </button>
        <span className="text-[13px] font-sans text-gray-300 w-12 text-center">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          className="p-1 text-gray-400 hover:text-white hover:bg-white/5 rounded transition-colors"
          title="Zoom In"
        >
          <Icons.Plus className="w-4 h-4" />
        </button>
        <div className="h-4 w-px bg-white/10 mx-1" />
        <button
          onClick={handleReset}
          className="p-1 text-gray-400 hover:text-white hover:bg-white/5 rounded transition-colors"
          title="Reset Zoom"
        >
          <Icons.RotateCcw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center p-8 overflow-auto scrollbar-thin">
        <div className="relative group transition-transform duration-200 ease-out" style={{ transform: `scale(${scale})` }}>
          <img
            src={src}
            alt={filePath}
            onError={() => setError(true)}
            className="max-w-full max-h-full shadow-2xl border border-white/10 rounded-sm origin-center"
          />
        </div>
      </div>
    </div>
  );
}
