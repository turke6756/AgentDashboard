import React, { useRef, useEffect } from 'react';
import type { PathType } from '../../../shared/types';

interface Props {
  x: number;
  y: number;
  filePath: string;
  workingDirectory: string;
  pathType: PathType;
  showRevealInTree?: boolean;
  onClose: () => void;
  onRevealInTree?: () => void;
}

function getRelativePath(filePath: string, workingDirectory: string): string {
  const normFile = filePath.replace(/\\/g, '/');
  const normDir = workingDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  if (normFile.startsWith(normDir + '/')) {
    return normFile.substring(normDir.length + 1);
  }
  return normFile;
}

export default function FileContextMenu({
  x, y, filePath, workingDirectory, pathType, showRevealInTree, onClose, onRevealInTree,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleCopyPath = () => {
    navigator.clipboard.writeText(filePath);
    onClose();
  };

  const handleCopyRelativePath = () => {
    const rel = getRelativePath(filePath, workingDirectory);
    navigator.clipboard.writeText(rel);
    onClose();
  };

  const handleOpenInVSCode = () => {
    window.api.system.openFileInWorkspace(filePath, workingDirectory, pathType);
    onClose();
  };

  const handleRevealInTree = () => {
    onRevealInTree?.();
    onClose();
  };

  const itemClass =
    'w-full text-left px-3 py-1.5 text-[13px] font-sans hover:bg-accent-blue/20 hover:text-accent-blue transition-colors';

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface-2 border border-accent-blue/30 shadow-[0_0_15px_rgba(0,0,0,0.8)] min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <div className="bg-accent-blue/10 px-2 py-1 text-[13px] text-accent-blue font-sans border-b dark:border-white/10 light:border-black/10 ">
        File_Operations
      </div>
      <button onClick={handleCopyPath} className={itemClass}>
        Copy Path
      </button>
      <button onClick={handleCopyRelativePath} className={itemClass}>
        Copy Relative Path
      </button>
      <div className="border-t dark:border-white/10 light:border-black/10" />
      <button onClick={handleOpenInVSCode} className={itemClass}>
        Open in VS Code
      </button>
      {showRevealInTree && onRevealInTree && (
        <>
          <div className="border-t dark:border-white/10 light:border-black/10" />
          <button onClick={handleRevealInTree} className={itemClass}>
            Reveal in Tree
          </button>
        </>
      )}
    </div>
  );
}
