import React, { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import * as Icons from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure worker to load from CDN to avoid build issues
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Props {
  filePath: string;
  pathType: 'windows' | 'wsl';
}

export default function PdfRenderer({ filePath, pathType }: Props) {
  const src = `media://file/${encodeURIComponent(filePath)}`;
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setLoading(false);
    setError(null);
  }

  function onDocumentLoadError(err: Error) {
    console.error('Error loading PDF:', err);
    setLoading(false);
    setError(err.message || 'Failed to load PDF');
  }

  const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.5));
  const handlePrevPage = () => setPageNumber(prev => Math.max(prev - 1, 1));
  const handleNextPage = () => setPageNumber(prev => Math.min(prev + 1, numPages || 1));

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-[#525659]">
        <div className="text-center p-8">
          <Icons.FileWarning className="w-10 h-10 text-gray-500 mx-auto mb-4" />
          <div className="text-gray-300 font-mono text-sm mb-2">Failed to load PDF</div>
          <div className="text-gray-500 font-mono text-xs mb-4 max-w-md break-all">{error}</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="px-4 py-2 text-xs font-mono uppercase tracking-wider text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open externally
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#525659] overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#323639] text-gray-200 border-b border-black/20 shadow-sm shrink-0 z-10">
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-black/20 rounded p-0.5">
            <button
              onClick={handlePrevPage}
              disabled={pageNumber <= 1}
              className="p-1 hover:bg-white/10 rounded disabled:opacity-30 transition-colors"
            >
              <Icons.ChevronUp className="w-4 h-4" />
            </button>
            <span className="px-3 text-xs font-mono min-w-[60px] text-center select-none">
              {pageNumber} / {numPages || '--'}
            </span>
            <button
              onClick={handleNextPage}
              disabled={!numPages || pageNumber >= numPages}
              className="p-1 hover:bg-white/10 rounded disabled:opacity-30 transition-colors"
            >
              <Icons.ChevronDown className="w-4 h-4" />
            </button>
          </div>

          <div className="h-4 w-px bg-white/10" />

          <div className="flex items-center bg-black/20 rounded p-0.5">
            <button
              onClick={handleZoomOut}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <Icons.Minus className="w-4 h-4" />
            </button>
            <span className="px-3 text-xs font-mono min-w-[50px] text-center select-none">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <Icons.Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Document Viewer */}
      <div className="flex-1 overflow-auto flex justify-center p-8 bg-[#525659] relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#525659] z-20">
            <div className="flex items-center gap-3 text-white/70">
              <Icons.Loader2 className="w-5 h-5 animate-spin" />
              <span className="font-mono text-sm">Loading PDF...</span>
            </div>
          </div>
        )}

        <Document
          file={src}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          className="shadow-2xl"
          loading={null}
        >
          <Page
            pageNumber={pageNumber}
            scale={scale}
            renderTextLayer={true}
            renderAnnotationLayer={true}
            className="shadow-lg"
          />
        </Document>
      </div>
    </div>
  );
}
