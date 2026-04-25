import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import FileContextMenu from '../shared/FileContextMenu';
import * as Icons from 'lucide-react';
import FileIcon from './FileIcon';
import { fileDragStart } from '../../utils/drag-file';
import { applyFsEvent } from './applyFsEvent';

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

  const childrenLoaded = children !== null;
  useEffect(() => {
    if (!entry.isDirectory || !expanded || !childrenLoaded) return;
    const unsub = window.api.files.watchDirectory(entry.path, pathType, (event) => {
      setChildren((prev) => (prev ? applyFsEvent(prev, event) : prev));
    });
    return unsub;
  }, [entry.isDirectory, entry.path, pathType, expanded, childrenLoaded]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (entry.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [entry.isDirectory]);

  const ChevronIcon = expanded ? Icons.ChevronDown : Icons.ChevronRight;

  return (
    <div>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={!entry.isDirectory}
        onDragStart={(e) => { if (!entry.isDirectory) fileDragStart(e, entry.path); }}
        className={`w-full text-left flex items-center gap-1 py-[3px] px-2 text-[13px] font-sans transition-colors group ${
          isActive ? 'tree-row-selected' : 'tree-row-hover text-fg-primary'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px`, color: isActive ? undefined : 'var(--color-fg-primary)' }}
      >
        {entry.isDirectory ? (
          <>
            <span className="shrink-0 w-3.5 flex items-center justify-center" style={{ color: 'var(--color-fg-secondary)' }}>
              {loading ? (
                <Icons.Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ChevronIcon className="w-3.5 h-3.5" />
              )}
            </span>
            <span className="shrink-0 w-4 flex items-center justify-center">
              <FileIcon name={entry.name} isDirectory isOpen={expanded} className="w-4 h-4" />
            </span>
          </>
        ) : (
          <>
            <span className="shrink-0 w-3.5" />
            <span className="shrink-0 w-4 flex items-center justify-center">
              <FileIcon name={entry.name} className="w-4 h-4" />
            </span>
          </>
        )}
        <span className="truncate">
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
