import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Icons from 'lucide-react';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import DirectoryTreeNode from './DirectoryTreeNode';
import { applyFsEvent } from './applyFsEvent';

interface Props {
  rootPath: string;
  pathType: PathType;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
}

export default function DirectoryTree({ rootPath, pathType, activeFilePath, onFileSelect }: Props) {
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const cache = useRef(new Map<string, DirectoryEntry[]>());

  const handleRefresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        handleRefresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleRefresh]);

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
  }, [rootPath, pathType, refreshTick]);

  useEffect(() => {
    if (!rootPath) return;
    const unsub = window.api.files.watchDirectory(rootPath, pathType, (event) => {
      setRootEntries((prev) => applyFsEvent(prev, event));
    });
    return unsub;
  }, [rootPath, pathType, refreshTick]);

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
    <div className="h-full flex flex-col border-r dark:border-white/10 light:border-black/10 bg-surface-0/40">
      <div className="px-3 py-2 border-b dark:border-white/10 light:border-black/10 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-sans   text-gray-300">Explorer</div>
          <div className="text-[13px] font-sans text-accent-blue/70 truncate mt-0.5" title={rootPath}>
            {rootName}
          </div>
        </div>
        <button
          onClick={handleRefresh}
          title="Refresh (F5)"
          className="shrink-0 p-1 rounded text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <Icons.RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div key={refreshTick} className="flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin">
        {loading ? (
          <div className="px-3 py-4 text-[13px] text-gray-400 font-sans animate-pulse">Loading...</div>
        ) : rootEntries.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-gray-400 font-sans">Empty directory</div>
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
