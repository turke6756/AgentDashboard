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

  return (
    <div
      ref={menuRef}
      className="ui-menu fixed z-50"
      style={{ left: x, top: y }}
    >
      <div className="ui-menu-header">
        File Operations
      </div>
      <button onClick={handleCopyPath} className="ui-menu-item">
        Copy Path
      </button>
      <button onClick={handleCopyRelativePath} className="ui-menu-item">
        Copy Relative Path
      </button>
      <div className="ui-menu-divider" />
      <button onClick={handleOpenInVSCode} className="ui-menu-item">
        Open in VS Code
      </button>
      {showRevealInTree && onRevealInTree && (
        <>
          <div className="ui-menu-divider" />
          <button onClick={handleRevealInTree} className="ui-menu-item">
            Reveal in Tree
          </button>
        </>
      )}
    </div>
  );
}
