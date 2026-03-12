import React, { useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import WorkspaceCreateDialog from '../workspace/WorkspaceCreateDialog';

function HeatDot({ activeCount, workingCount }: { activeCount: number; workingCount: number }) {
  let colorClass = 'bg-gray-600';
  let pulse = false;

  if (activeCount === 0) {
    colorClass = 'bg-gray-600';
  } else if (workingCount === 0) {
    colorClass = 'bg-blue-400';
  } else if (workingCount === 1) {
    colorClass = 'bg-yellow-400';
  } else if (workingCount === 2) {
    colorClass = 'bg-orange-400';
    pulse = true;
  } else if (workingCount >= 3 && workingCount < 4) {
    colorClass = 'bg-red-400';
    pulse = true;
  } else {
    colorClass = 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]';
    pulse = true;
  }

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${colorClass} ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}

export default function Sidebar() {
  const { workspaces, selectedWorkspaceId, selectWorkspace, loadWorkspaces, health, workspaceHeat } = useDashboardStore();
  const [showCreate, setShowCreate] = useState(false);
  const [dragOver, setDragOver] = useState(false);

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

    // Electron exposes .path on File objects
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

  return (
    <div className="w-64 bg-surface-1 border-r border-gray-800 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-gray-800">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-accent-blue">Agent</span> Dashboard
        </h1>
        {health && (
          <div className="flex gap-2 mt-2 text-xs">
            <span className={health.claudeWindowsAvailable ? 'text-green-400' : 'text-gray-600'}>
              WIN
            </span>
            <span className={health.wslAvailable ? 'text-green-400' : 'text-gray-600'}>
              WSL
            </span>
            <span className={health.tmuxAvailable ? 'text-green-400' : 'text-gray-600'}>
              TMUX
            </span>
          </div>
        )}
      </div>

      {/* Workspaces */}
      <div
        className={`flex-1 overflow-y-auto p-2 transition-colors ${
          dragOver ? 'bg-accent-blue/10 border-2 border-dashed border-accent-blue/40' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center justify-between px-2 py-1 mb-1">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Workspaces
          </span>
          <button
            onClick={() => setShowCreate(true)}
            className="text-gray-500 hover:text-white text-lg leading-none"
            title="Add workspace"
          >
            +
          </button>
        </div>

        {workspaces.map((ws) => {
          const heat = workspaceHeat[ws.id];
          return (
            <button
              key={ws.id}
              onClick={() => selectWorkspace(ws.id)}
              className={`w-full text-left px-3 py-2 rounded-md mb-0.5 transition-colors ${
                selectedWorkspaceId === ws.id
                  ? 'bg-accent-blue/20 text-white'
                  : 'hover:bg-surface-2 text-gray-400'
              }`}
            >
              <div className="flex items-center gap-2">
                {heat && <HeatDot activeCount={heat.activeCount} workingCount={heat.workingCount} />}
                <div className="text-sm font-medium truncate">{ws.title}</div>
              </div>
              <div className="text-xs text-gray-600 truncate">{ws.path}</div>
              <div className="text-[10px] text-gray-700 mt-0.5">
                {ws.pathType === 'wsl' ? 'WSL' : 'Windows'}
              </div>
            </button>
          );
        })}

        {dragOver && (
          <div className="px-3 py-4 text-center text-accent-blue/70 text-xs">
            Drop folder to create workspace
          </div>
        )}

        {workspaces.length === 0 && !dragOver && (
          <div className="px-3 py-8 text-center text-gray-600 text-sm">
            No workspaces yet.
            <br />
            <button
              onClick={() => setShowCreate(true)}
              className="text-accent-blue hover:underline mt-2 inline-block"
            >
              Create one
            </button>
            <div className="text-[10px] text-gray-700 mt-2">
              or drop a folder here
            </div>
          </div>
        )}
      </div>

      {showCreate && <WorkspaceCreateDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}
