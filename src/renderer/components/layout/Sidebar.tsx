import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useThemeStore } from '../../stores/theme-store';
import WorkspaceCreateDialog from '../workspace/WorkspaceCreateDialog';
import CollapseButton from './CollapseButton';
import * as Icons from 'lucide-react';
import DirectoryTreeNode from '../fileviewer/DirectoryTreeNode';
import type { DirectoryEntry, PathType } from '../../../shared/types';

function InlineWorkspaceTree({ rootPath, pathType }: { rootPath: string; pathType: PathType }) {
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const cache = useRef(new Map<string, DirectoryEntry[]>());
  const { openTab, activeTabId, openTabs } = useDashboardStore();
  const { theme } = useThemeStore();
  const isLight = theme === 'light';

  const activeFilePath = openTabs.find(t => t.id === activeTabId)?.filePath || null;

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

  const handleFileSelect = useCallback((filePath: string) => {
    openTab(filePath, rootPath, pathType);
  }, [openTab, rootPath, pathType]);

  return (
    <div className={`pl-3 py-1 shadow-inner ${isLight ? 'bg-black/5' : 'bg-black/40'}`}>
      {loading ? (
        <div className="px-4 py-2 text-[13px] text-gray-300 font-sans animate-pulse">Loading...</div>
      ) : rootEntries.length === 0 ? (
        <div className="px-4 py-2 text-[13px] text-gray-300 font-sans">Empty directory</div>
      ) : (
        rootEntries.map((entry) => (
          <DirectoryTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            activeFilePath={activeFilePath}
            pathType={pathType}
            workingDirectory={rootPath}
            onFileSelect={handleFileSelect}
            loadChildren={loadChildren}
          />
        ))
      )}
    </div>
  );
}

function HeatDot({ activeCount, workingCount }: { activeCount: number; workingCount: number }) {
  let colorClass = 'bg-gray-800';
  let pulse = false;

  if (activeCount === 0) {
    colorClass = 'bg-gray-800 border border-gray-700';
  } else if (workingCount === 0) {
    colorClass = 'bg-accent-blue shadow-[0_0_8px_rgba(0,243,255,0.6)]';
  } else if (workingCount === 1) {
    colorClass = 'bg-accent-yellow shadow-[0_0_8px_rgba(252,238,10,0.6)]';
  } else if (workingCount === 2) {
    colorClass = 'bg-accent-orange shadow-[0_0_8px_rgba(255,170,0,0.6)]';
    pulse = true;
  } else {
    colorClass = 'bg-accent-red shadow-[0_0_10px_rgba(255,0,85,0.8)]';
    pulse = true;
  }

  return (
    <span
      className={`inline-block w-2 h-2 rounded-none shrink-0 ${colorClass} ${pulse ? 'animate-pulse-fast' : ''}`}
    />
  );
}

interface SidebarProps {
  width: number;
}

export default function Sidebar({ width }: SidebarProps) {
  const { workspaces, selectedWorkspaceId, selectWorkspace, loadWorkspaces, deleteWorkspace, health, workspaceHeat, panelLayout, togglePanelCollapsed, resetLayout } = useDashboardStore();
  const { theme, toggleTheme } = useThemeStore();
  const [showCreate, setShowCreate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; wsId: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const collapsed = panelLayout.sidebarCollapsed;

  const toggleWorkspace = (wsId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setConfirmDelete(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (!files.length) return;

    const folderPath = (files[0] as any).path as string;
    if (!folderPath) return;

    const pathType = folderPath.startsWith('/') ? 'wsl' as const : 'windows' as const;
    const segments = folderPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const title = segments[segments.length - 1] || 'Workspace';

    try {
      const ws = await window.api.workspaces.create({ title, path: folderPath, pathType });
      await loadWorkspaces();
      selectWorkspace(ws.id);
    } catch (err) {
      console.error('Failed to create workspace from drop:', err);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(null);
    setContextMenu({ x: e.clientX, y: e.clientY, wsId });
  };

  const handleDelete = async (wsId: string) => {
    setContextMenu(null);
    setConfirmDelete(null);
    await deleteWorkspace(wsId);
  };

  // Collapsed sidebar: thin strip with expand button
  if (collapsed) {
    return (
      <div
        className="bg-surface-1/90 dark:backdrop-blur-sm border- dark:border-white/10 light:border-black/10 flex flex-col items-center z-20 dark:shadow-2xl light:shadow-none py-2"
        style={{ width }}
      >
        <CollapseButton collapsed direction="left" onClick={() => togglePanelCollapsed('sidebarCollapsed')} />
        <div className="mt-2 text-[13px] font-sans text-accent-blue writing-mode-vertical" style={{ writingMode: 'vertical-rl' }}>
          Workspaces
        </div>
      </div>
    );
  }

  return (
    <div
      className="bg-surface-1/90 dark:backdrop-blur-sm border- dark:border-white/10 light:border-black/10 flex flex-col z-20 dark:shadow-2xl light:shadow-none"
      style={{ width }}
    >
      {/* Header */}
      <div className="p-4 border- dark:border-white/10 light:border-black/10 bg-surface-0">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold   glow-text">
            <span className="text-accent-blue">Agent</span> OS
          </h1>
          <div className="flex items-center gap-1">
            <button
              onClick={resetLayout}
              className="text-[13px] font-sans text-gray-400 hover:text-accent-blue border border-gray-800 hover:border-accent-blue/40 px-1 py-0.5 transition-colors"
              title="Reset all panel sizes to defaults"
            >
              Reset
            </button>
            <button
              onClick={toggleTheme}
              className="text-[13px] font-sans text-gray-400 hover:text-accent-blue border border-gray-800 hover:border-accent-blue/40 px-1 py-0.5 transition-colors"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <CollapseButton collapsed={false} direction="left" onClick={() => togglePanelCollapsed('sidebarCollapsed')} />
          </div>
        </div>
        <div className="text-[13px] text-gray-300 font-sans mt-1 ">
          v1.0.0
        </div>
      </div>

      {/* Workspaces */}
      <div
        className={`flex-1 overflow-y-auto p-2 transition-colors scrollbar-hide ${
          dragOver ? 'bg-accent-blue/10 border-2 border-dashed border-accent-blue/40' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center justify-between px-2 py-2 mb-2 border- dark:border-white/10 light:border-black/10/50">
          <span className="text-[13px] font-sans font-medium text-accent-blue   ">
            Workspaces
          </span>
          <button
            onClick={() => setShowCreate(true)}
            className="text-accent-blue hover:text-white transition-colors"
            title="Add Workspace"
          >
            <Icons.Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1">
          {workspaces.map((ws) => {
            const heat = workspaceHeat[ws.id];
            const isSelected = selectedWorkspaceId === ws.id;
            const isExpanded = expandedWorkspaces.has(ws.id);

            return (
              <div key={ws.id}>
                <button
                  onClick={() => selectWorkspace(ws.id)}
                  onDoubleClick={(e) => toggleWorkspace(ws.id, e)}
                  onContextMenu={(e) => handleContextMenu(e, ws.id)}
                  className={`w-full text-left px-2 py-2.5 relative group transition-all duration-200 border-l-2 flex flex-col ${
                    isSelected
                      ? 'bg-surface-2 border-accent-blue dark:text-gray-50 text-gray-900 dark:shadow-[inset_10px_0_20px_-10px_rgba(0,243,255,0.1)] light:shadow-none light:bg-[#ddeefe]'
                      : 'border-transparent hover:bg-surface-2 dark:hover:border-gray-500 light:hover:border-gray-900 dark:text-gray-400 text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-1 w-full mb-1">
                    <div 
                      className="p-1 shrink-0 cursor-pointer text-gray-300 hover:text-gray-300 transition-colors"
                      onClick={(e) => toggleWorkspace(ws.id, e)}
                    >
                      {isExpanded ? <Icons.ChevronDown className="w-3.5 h-3.5" /> : <Icons.ChevronRight className="w-3.5 h-3.5" />}
                    </div>
                    <span className={`flex-1 font-sans text-[13px] font-medium truncate ${isSelected ? 'text-accent-blue' : ''}`}>
                      {ws.title}
                    </span>
                    {heat && <HeatDot activeCount={heat.activeCount} workingCount={heat.workingCount} />}
                  </div>

                  <div className="flex items-center text-[13px] font-sans text-gray-300 pl-6">
                    <span className={`mr-2  text-[13px] ${ws.pathType === 'wsl' ? 'text-accent-orange' : 'text-blue-400'}`}>
                      {ws.pathType}
                    </span>
                    <span className="truncate  max-w-[120px]">{ws.path}</span>
                  </div>

                  {/* Decoration corners for active item */}
                  {isSelected && (
                    <>
                      <div className="absolute top-0 right-0 w-1 h-1 border-t border-r border-accent-blue" />
                      <div className="absolute bottom-0 right-0 w-1 h-1 border-b border-r border-accent-blue" />
                    </>
                  )}
                </button>
                {isExpanded && (
                  <InlineWorkspaceTree rootPath={ws.path} pathType={ws.pathType} />
                )}
              </div>
            );
          })}
        </div>

        {dragOver && (
          <div className="mt-4 px-3 py-4 text-center border border-dashed border-accent-blue text-accent-blue/70 text-[13px] font-sans animate-pulse">
            Drop folder here to add workspace
          </div>
        )}

        {workspaces.length === 0 && !dragOver && (
          <div className="px-3 py-12 text-center text-gray-400 text-[13px] font-sans">
            No workspaces found
            <br />
            <button
              onClick={() => setShowCreate(true)}
              className="text-accent-blue hover:underline mt-4 "
            >
              Add Workspace
            </button>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-surface-2 border border-accent-red/30 shadow-[0_0_15px_rgba(0,0,0,0.8)] min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="bg-accent-red/10 px-2 py-1 text-[13px] text-accent-red font-sans font-medium border-b border-accent-red/20 ">
            Workspace Options
          </div>
          {confirmDelete === contextMenu.wsId ? (
            <div className="px-3 py-2">
              <p className="text-[13px] text-accent-red font-sans mb-2">Confirm delete?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleDelete(contextMenu.wsId)}
                  className="px-2 py-1 text-[13px] font-sans bg-accent-red/20 text-accent-red hover:bg-accent-red/40 border border-accent-red/50 "
                >
                  Yes
                </button>
                <button
                  onClick={() => { setConfirmDelete(null); setContextMenu(null); }}
                  className="px-2 py-1 text-[13px] font-sans bg-surface-3 text-gray-400 hover:text-white border border-gray-700 "
                >
                  No
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => {
                  window.api.workspaces.openInVSCode(contextMenu.wsId);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-2 text-[13px] font-sans hover:bg-accent-blue/20 hover:text-accent-blue transition-colors "
              >
                Open VS Code
              </button>
              <button
                onClick={() => setConfirmDelete(contextMenu.wsId)}
                className="w-full text-left px-3 py-2 text-[13px] font-sans hover:bg-accent-red/20 hover:text-accent-red transition-colors "
              >
                Delete Workspace
              </button>
            </>
          )}
        </div>
      )}

      {/* Footer Status Ticker */}
      <div className="p-2 border- dark:border-white/10 light:border-black/10 bg-surface-0 text-[13px] font-sans text-gray-300  flex justify-between items-center">
        {health ? (
          <>
            <div className="flex gap-2">
              <span className={health.claudeWindowsAvailable ? 'text-accent-green' : 'text-gray-700'}>Win</span>
              <span className={health.wslAvailable ? 'text-accent-green' : 'text-gray-700'}>WSL</span>
              <span className={health.tmuxAvailable ? 'text-accent-green' : 'text-gray-700'}>Tmux</span>
            </div>
            <div className="animate-pulse text-accent-blue">Connected</div>
          </>
        ) : (
          <span className="text-accent-red animate-pulse">Checking...</span>
        )}
      </div>

      {showCreate && <WorkspaceCreateDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}
