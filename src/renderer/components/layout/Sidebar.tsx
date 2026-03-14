import React, { useState, useRef, useEffect } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import WorkspaceCreateDialog from '../workspace/WorkspaceCreateDialog';

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

export default function Sidebar() {
  const { workspaces, selectedWorkspaceId, selectWorkspace, loadWorkspaces, deleteWorkspace, health, workspaceHeat } = useDashboardStore();
  const [showCreate, setShowCreate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; wsId: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="w-64 bg-surface-1/90 backdrop-blur-sm border-r border-gray-800 flex flex-col z-20 shadow-2xl">
      {/* Header */}
      <div className="p-4 border-b border-gray-800 bg-surface-0/50">
        <h1 className="text-xl font-bold tracking-widest uppercase glow-text">
          <span className="text-accent-blue">AGENT</span>_OS
        </h1>
        <div className="text-[10px] text-gray-500 font-mono mt-1 tracking-widest">
          V1.0.0 // SYSTEM_READY
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
        <div className="flex items-center justify-between px-2 py-2 mb-2 border-b border-gray-800/50">
          <span className="text-[10px] font-bold text-accent-blue uppercase tracking-widest opacity-70">
            Sector_List
          </span>
          <button
            onClick={() => setShowCreate(true)}
            className="text-accent-blue hover:text-white text-lg leading-none transition-colors hover:glow-text"
            title="Initialize New Sector"
          >
            [+]
          </button>
        </div>

        <div className="space-y-1">
          {workspaces.map((ws) => {
            const heat = workspaceHeat[ws.id];
            const isSelected = selectedWorkspaceId === ws.id;

            return (
              <button
                key={ws.id}
                onClick={() => selectWorkspace(ws.id)}
                onContextMenu={(e) => handleContextMenu(e, ws.id)}
                className={`w-full text-left px-3 py-3 relative group transition-all duration-200 border-l-2 ${
                  isSelected
                    ? 'bg-surface-2 border-accent-blue text-white shadow-[inset_10px_0_20px_-10px_rgba(0,243,255,0.1)]'
                    : 'border-transparent hover:bg-surface-2 hover:border-gray-600 text-gray-400 hover:text-gray-200'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`font-mono text-xs font-bold uppercase tracking-wider ${isSelected ? 'text-accent-blue glow-text' : ''}`}>
                    {ws.title}
                  </span>
                  {heat && <HeatDot activeCount={heat.activeCount} workingCount={heat.workingCount} />}
                </div>

                <div className="flex items-center text-[9px] font-mono text-gray-600 uppercase tracking-tight">
                  <span className={`mr-2 ${ws.pathType === 'wsl' ? 'text-accent-orange' : 'text-blue-400'}`}>
                    {ws.pathType}
                  </span>
                  <span className="truncate opacity-50 max-w-[120px]">{ws.path}</span>
                </div>

                {/* Decoration corners for active item */}
                {isSelected && (
                  <>
                    <div className="absolute top-0 right-0 w-1 h-1 border-t border-r border-accent-blue" />
                    <div className="absolute bottom-0 right-0 w-1 h-1 border-b border-r border-accent-blue" />
                  </>
                )}
              </button>
            );
          })}
        </div>

        {dragOver && (
          <div className="mt-4 px-3 py-4 text-center border border-dashed border-accent-blue text-accent-blue/70 text-xs font-mono animate-pulse">
            {'>> INITIATE DOCKING SEQUENCE <<'}
          </div>
        )}

        {workspaces.length === 0 && !dragOver && (
          <div className="px-3 py-12 text-center text-gray-600 text-xs font-mono">
            [NO SECTORS FOUND]
            <br />
            <button
              onClick={() => setShowCreate(true)}
              className="text-accent-blue hover:underline mt-4 uppercase tracking-wider"
            >
              Initialize_Sector
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
          <div className="bg-accent-red/10 px-2 py-1 text-[9px] text-accent-red font-mono border-b border-accent-red/20 uppercase">
            Sector_Operations
          </div>
          {confirmDelete === contextMenu.wsId ? (
            <div className="px-3 py-2">
              <p className="text-[10px] text-accent-red font-mono mb-2">Confirm delete?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleDelete(contextMenu.wsId)}
                  className="px-2 py-1 text-[10px] font-mono bg-accent-red/20 text-accent-red hover:bg-accent-red/40 border border-accent-red/50 uppercase"
                >
                  Yes
                </button>
                <button
                  onClick={() => { setConfirmDelete(null); setContextMenu(null); }}
                  className="px-2 py-1 text-[10px] font-mono bg-surface-3 text-gray-400 hover:text-white border border-gray-700 uppercase"
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
                className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-accent-blue/20 hover:text-accent-blue transition-colors uppercase"
              >
                Open_VS_Code
              </button>
              <button
                onClick={() => setConfirmDelete(contextMenu.wsId)}
                className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-accent-red/20 hover:text-accent-red transition-colors uppercase"
              >
                Delete_Sector
              </button>
            </>
          )}
        </div>
      )}

      {/* Footer Status Ticker */}
      <div className="p-2 border-t border-gray-800 bg-surface-0 text-[9px] font-mono text-gray-500 uppercase flex justify-between items-center">
        {health ? (
          <>
            <div className="flex gap-2">
              <span className={health.claudeWindowsAvailable ? 'text-accent-green' : 'text-gray-700'}>W:OK</span>
              <span className={health.wslAvailable ? 'text-accent-green' : 'text-gray-700'}>L:OK</span>
              <span className={health.tmuxAvailable ? 'text-accent-green' : 'text-gray-700'}>T:OK</span>
            </div>
            <div className="animate-pulse text-accent-blue">ONLINE</div>
          </>
        ) : (
          <span className="text-accent-red animate-pulse">SYSTEM CHECK...</span>
        )}
      </div>

      {showCreate && <WorkspaceCreateDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}
