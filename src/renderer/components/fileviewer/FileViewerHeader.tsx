import React from 'react';
import type { PathType } from '../../../shared/types';
import { detectFileType, detectLanguage, formatFileSize, getFileIconName } from './fileTypeUtils';
import * as Icons from 'lucide-react';

interface Props {
  filePath: string;
  pathType: PathType;
  fileSize: number;
  workingDirectory?: string;
  onNavigate: (dirPath: string) => void;
}

export default function FileViewerHeader({ filePath, pathType, fileSize, workingDirectory, onNavigate }: Props) {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const fileType = detectFileType(filePath);
  const language = fileType === 'code' ? detectLanguage(filePath) : fileType;

  const handleOpenInVSCode = () => {
    if (workingDirectory) {
      window.api.system.openFileInWorkspace(filePath, workingDirectory, pathType);
    } else {
      window.api.system.openFile(filePath, pathType);
    }
  };

  // Build breadcrumb paths
  const breadcrumbs = segments.map((seg, i) => {
    const path = '/' + segments.slice(0, i + 1).join('/');
    return { label: seg, path };
  });

  const fileIconName = getFileIconName(filePath, false);
  const FileIcon = (Icons as any)[fileIconName] || Icons.File;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b dark:border-white/10 light:border-black/10 bg-surface-1/40 backdrop-blur-md shrink-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 min-w-0 overflow-hidden flex-1">
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1;
          const isFirst = i === 0;
          return (
            <React.Fragment key={i}>
              {i > 0 && <Icons.ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />}
              <div className="flex items-center gap-1.5 min-w-0">
                {isLast ? (
                  <>
                    <FileIcon className="w-3.5 h-3.5 text-accent-blue shrink-0" />
                    <span className="text-gray-50 text-[13px] font-sans font-medium truncate">{crumb.label}</span>
                  </>
                ) : (
                  <>
                    {isFirst ? <Icons.Folder className="w-3 h-3 text-gray-300 shrink-0" /> : null}
                    <button
                      onClick={() => onNavigate(crumb.path)}
                      className="text-gray-300 hover:text-accent-blue text-[13px] font-sans truncate transition-colors shrink-0 max-w-[120px]"
                    >
                      {crumb.label}
                    </button>
                  </>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Labels */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-accent-blue/5 border border-accent-blue/20 rounded-sm">
          <span className="text-[13px] font-sans   text-accent-blue font-bold">
            {language}
          </span>
        </div>
        
        {fileSize > 0 && (
          <span className="text-[13px] font-sans text-gray-300 flex items-center gap-1">
            <Icons.Database className="w-3 h-3" />
            {formatFileSize(fileSize)}
          </span>
        )}

        <button
          onClick={handleOpenInVSCode}
          className="flex items-center gap-1.5 px-3 py-1 text-[13px] font-sans font-bold   text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors rounded-sm"
        >
          <Icons.ExternalLink className="w-3 h-3" />
          VS Code
        </button>
      </div>
    </div>
  );
}
