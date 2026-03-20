import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import DirectoryTreeNode from './DirectoryTreeNode';

interface Props {
  rootPath: string;
  pathType: PathType;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
}

export default function DirectoryTree({ rootPath, pathType, activeFilePath, onFileSelect }: Props) {
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const cache = useRef(new Map<string, DirectoryEntry[]>());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    cache.current.clear();
    window.api.files.listDirectory(rootPath, pathType).then((entries) => {
      if (!cancelled) {
        cache.current.set(rootPath, entries);
        setRootEntries(entries);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [rootPath, pathType]);

  const loadChildren = useCallback(async (dirPath: string): Promise<DirectoryEntry[]> => {
    const cached = cache.current.get(dirPath);
    if (cached) return cached;
    const entries = await window.api.files.listDirectory(dirPath, pathType);
    cache.current.set(dirPath, entries);
    return entries;
  }, [pathType]);

  // Extract the root folder name from path
  const rootName = rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rootPath;

  return (
    <div className="h-full flex flex-col border-r border-accent-blue/10 bg-surface-0/40">
      <div className="px-3 py-2 border-b border-accent-blue/10">
        <div className="text-[10px] font-mono uppercase tracking-wider text-gray-500">Explorer</div>
        <div className="text-[11px] font-mono text-accent-blue/70 truncate mt-0.5" title={rootPath}>
          {rootName}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin">
        {loading ? (
          <div className="px-3 py-4 text-[11px] text-gray-600 font-mono animate-pulse">Loading...</div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-gray-600 font-mono">Empty directory</div>
        ) : (
          rootEntries.map((entry) => (
            <DirectoryTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              activeFilePath={activeFilePath}
              pathType={pathType}
              workingDirectory={rootPath}
              onFileSelect={onFileSelect}
              loadChildren={loadChildren}
            />
          ))
        )}
      </div>
    </div>
  );
}
