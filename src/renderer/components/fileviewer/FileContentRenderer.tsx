import React from 'react';
import { detectFileType, detectLanguage } from './fileTypeUtils';
import PlainTextRenderer from './PlainTextRenderer';
import CodeRenderer from './CodeRenderer';
import MarkdownRenderer from './MarkdownRenderer';
import ImageRenderer from './ImageRenderer';
import PdfRenderer from './PdfRenderer';
import type { PathType } from '../../../shared/types';

interface Props {
  content: string;
  filePath: string;
  pathType: PathType;
  error?: string;
}

export default function FileContentRenderer({ content, filePath, pathType, error }: Props) {
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <div className="text-3xl mb-4 opacity-50">&#x26A0;</div>
          <div className="text-gray-400 font-mono text-sm mb-2">{error}</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="mt-4 px-4 py-2 text-xs font-mono uppercase tracking-wider text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open in VS Code
          </button>
        </div>
      </div>
    );
  }

  const fileType = detectFileType(filePath);

  if (fileType === 'binary') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <div className="text-3xl mb-4 opacity-50">&#x1F4E6;</div>
          <div className="text-gray-400 font-mono text-sm mb-2">Binary file — cannot display inline</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="mt-4 px-4 py-2 text-xs font-mono uppercase tracking-wider text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open in VS Code
          </button>
        </div>
      </div>
    );
  }

  if (fileType === 'markdown') {
    return <MarkdownRenderer content={content} />;
  }

  if (fileType === 'code') {
    const language = detectLanguage(filePath);
    return <CodeRenderer content={content} language={language} />;
  }

  if (fileType === 'image') {
    return <ImageRenderer filePath={filePath} pathType={pathType} />;
  }

  if (fileType === 'pdf') {
    return <PdfRenderer filePath={filePath} pathType={pathType} />;
  }

  return <PlainTextRenderer content={content} />;
}
