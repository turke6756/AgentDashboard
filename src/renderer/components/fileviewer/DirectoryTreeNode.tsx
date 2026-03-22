import React, { useState, useCallback, useRef } from 'react';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import FileContextMenu from '../shared/FileContextMenu';
import * as Icons from 'lucide-react';
import { getFileIconName } from './fileTypeUtils';
import { fileDragStart } from '../../utils/drag-file';

interface Props {
  entry: DirectoryEntry;
  depth: number;
  activeFilePath: string | null;
  pathType: PathType;
  workingDirectory: string;
  onFileSelect: (filePath: string) => void;
  loadChildren: (dirPath: string) => Promise<DirectoryEntry[]>;
}

export default function DirectoryTreeNode({ entry, depth, activeFilePath, pathType, workingDirectory, onFileSelect, loadChildren }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirectoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isActive = activeFilePath === entry.path;

  const handleClick = useCallback(() => {
    if (entry.isDirectory) {
      // Directories: toggle immediately, no debounce
      if (!expanded && children === null) {
        setLoading(true);
        loadChildren(entry.path).then((items) => {
          setChildren(items);
          setLoading(false);
        });
      }
      setExpanded(!expanded);
      return;
    }

    // Files: debounce single click for double-click detection
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return; // double-click handler will fire
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      onFileSelect(entry.path);
    }, 250);
  }, [entry, expanded, children, onFileSelect, loadChildren]);

  const handleDoubleClick = useCallback(() => {
    if (entry.isDirectory) return;
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    window.api.system.openFileInWorkspace(entry.path, workingDirectory, pathType);
  }, [entry, workingDirectory, pathType]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (entry.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [entry.isDirectory]);

  const iconName = getFileIconName(entry.path, entry.isDirectory);
  const IconComponent = (Icons as any)[iconName] || Icons.File;
  const FolderIcon = expanded ? Icons.ChevronDown : Icons.ChevronRight;

  return (
    <div>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={!entry.isDirectory}
        onDragStart={(e) => { if (!entry.isDirectory) fileDragStart(e, entry.path); }}
        className={`w-full text-left flex items-center gap-1.5 py-1 px-2 text-[13px] font-sans hover:bg-surface-2/60 transition-colors group ${
          isActive ? 'bg-accent-blue/10 text-accent-blue' : 'text-gray-400'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className="shrink-0 w-4 flex items-center justify-center">
          {entry.isDirectory ? (
            loading ? (
              <Icons.Loader2 className="w-3 h-3 animate-spin text-gray-300" />
            ) : (
              <FolderIcon className="w-3 h-3 text-gray-300 group-hover:text-gray-300" />
            )
          ) : (
            <IconComponent className={`w-3.5 h-3.5 ${isActive ? 'text-accent-blue' : 'text-gray-300'}`} />
          )}
        </span>
        <span className={`truncate ${entry.isDirectory ? 'text-accent-blue/70 font-medium' : ''}`}>
          {entry.name}
        </span>
      </button>
      {expanded && children && (
        <div className="border-l border-white/5 ml-[14px]">
          {children.map((child) => (
            <DirectoryTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              activeFilePath={activeFilePath}
              pathType={pathType}
              workingDirectory={workingDirectory}
              onFileSelect={onFileSelect}
              loadChildren={loadChildren}
            />
          ))}
        </div>
      )}

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={entry.path}
          workingDirectory={workingDirectory}
          pathType={pathType}
          showRevealInTree={false}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
