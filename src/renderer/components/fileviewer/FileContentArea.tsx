import React from 'react';
import type { PathType } from '../../../shared/types';
import { useFileContentCache } from './useFileContentCache';
import { detectFileType } from './fileTypeUtils';
import FileContentRenderer from './FileContentRenderer';
import ImageRenderer from './ImageRenderer';
import PdfRenderer from './PdfRenderer';

interface Props {
  tabId: string;
  filePath: string;
  pathType: PathType;
}

export default function FileContentArea({ tabId, filePath, pathType }: Props) {
  const fileType = filePath ? detectFileType(filePath) : null;

  // Images and PDFs are served via media:// protocol — skip text file reading entirely
  const isMediaType = fileType === 'image' || fileType === 'pdf';
  const { content, loading } = useFileContentCache(tabId, filePath, pathType, isMediaType);

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-600 font-mono text-sm uppercase tracking-wider">
          Select a file from the tree
        </div>
      </div>
    );
  }

  // Render media types directly — they don't need file content
  if (fileType === 'image') {
    return <ImageRenderer filePath={filePath} pathType={pathType} />;
  }
  if (fileType === 'pdf') {
    return <PdfRenderer filePath={filePath} pathType={pathType} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500 font-mono text-sm animate-pulse">Loading file...</div>
      </div>
    );
  }

  if (!content) return null;

  return (
    <FileContentRenderer
      content={content.content}
      filePath={filePath}
      pathType={pathType}
      error={content.error}
    />
  );
}
