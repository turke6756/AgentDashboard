import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import AgentLaunchDialog from '../agent/AgentLaunchDialog';
import FileViewerPanel from '../fileviewer/FileViewerPanel';
import type { AgentStatus } from '../../../shared/types';

function useSwipe(onSwipe: () => void, direction: 'left' | 'right') {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = Math.abs(e.clientY - startRef.current.y);
    startRef.current = null;
    // 80px threshold, must be mostly horizontal
    if (Math.abs(dx) > 80 && dy < 60) {
      if (direction === 'left' && dx < 0) onSwipe();
      if (direction === 'right' && dx > 0) onSwipe();
    }
  }, [onSwipe, direction]);

  return { onPointerDown, onPointerUp };
}

const SUPERVISOR_STATUS_COLORS: Record<AgentStatus, { dot: string; border: string; bg: string }> = {
  launching: { dot: 'bg-yellow-400', border: 'border-yellow-500/50', bg: 'hover:bg-yellow-500/10' },
  working:   { dot: 'bg-green-400 animate-pulse', border: 'border-green-500/50', bg: 'hover:bg-green-500/10' },
  idle:      { dot: 'bg-blue-400', border: 'border-blue-500/50', bg: 'hover:bg-blue-500/10' },
  waiting:   { dot: 'bg-orange-400 animate-pulse', border: 'border-orange-500/50', bg: 'hover:bg-orange-500/10' },
  done:      { dot: 'bg-gray-400', border: 'border-gray-500/50', bg: 'hover:bg-gray-500/10' },
  crashed:   { dot: 'bg-red-400', border: 'border-red-500/50', bg: 'hover:bg-red-500/10' },
  restarting:{ dot: 'bg-yellow-400 animate-pulse', border: 'border-yellow-500/50', bg: 'hover:bg-yellow-500/10' },
};

export default function MainContent() {
  const {
    workspaces, selectedWorkspaceId, agents, supervisorAgent, fileViewerOpen, showFileViewer, openTabs,
    loadSupervisor, launchSupervisor, setTerminalAgent, selectAgent, contextStats,
  } = useDashboardStore();
  const [showLaunch, setShowLaunch] = useState(false);
  const [supervisorLoading, setSupervisorLoading] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  // Load supervisor status when workspace changes
  useEffect(() => {
    if (workspace) {
      loadSupervisor(workspace.id);
    }
  }, [workspace?.id, loadSupervisor]);

  const swipeToFiles = useSwipe(() => showFileViewer(), 'left');

  // File viewer takes over the center panel
  if (fileViewerOpen) {
    return <FileViewerPanel />;
  }

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 bg-surface-0/20">
        <div className="text-center animate-pulse">
          <div className="text-4xl mb-4 text-accent-blue ">&#x1f916;</div>
          <div className="text-lg font-sans   text-accent-blue/50">
            Select a workspace to begin
          </div>
        </div>
      </div>
    );
  }

  const hasOpenTabs = openTabs.length > 0;
  const supStats = supervisorAgent ? contextStats[supervisorAgent.id] : null;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
       {/* Background Grid Accent */}
       <div className="absolute top-0 right-0 w-64 h-64 bg-accent-blue/5 rounded-full blur-3xl pointer-events-none -translate-y-1/2 translate-x-1/2" />

      {/* HUD Header */}
      <div className="px-6 py-4 border-b dark:border-white/10 light:border-black/10 bg-surface-1/40 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="text-xl font-sans font-bold text-gray-50">
                {workspace.title}
              </h2>
            </div>

            <div className="flex items-center gap-4 mt-2">
              <span className="text-[13px] text-accent-blue/70 font-sans px-1 rounded-sm">
                {workspace.path}
              </span>
              <span
                className={`text-[13px] px-1.5 py-0.5 font-bold border ${
                  workspace.pathType === 'wsl'
                    ? 'border-accent-orange/50 text-accent-orange'
                    : 'border-accent-blue/50 text-accent-blue'
                }`}
              >
                {workspace.pathType === 'wsl' ? 'WSL' : 'Windows'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Supervisor Card */}
            {supervisorAgent && !['done', 'crashed'].includes(supervisorAgent.status) ? (
              <button
                onClick={() => {
                  selectAgent(supervisorAgent.id);
                  setTerminalAgent(supervisorAgent.id);
                }}
                className={`hidden md:flex items-center gap-3 px-4 py-2.5 border rounded-lg transition-all cursor-pointer ${
                  SUPERVISOR_STATUS_COLORS[supervisorAgent.status].border
                } ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].bg} bg-surface-1/60`}
                title="Click to attach terminal"
              >
                {/* Status dot + label */}
                <div className="flex flex-col items-start gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${SUPERVISOR_STATUS_COLORS[supervisorAgent.status].dot}`} />
                    <span className="text-[13px] font-sans font-bold text-gray-100">Supervisor</span>
                  </div>
                  <span className="text-[11px] font-sans text-gray-400 ml-[18px] capitalize">{supervisorAgent.status}</span>
                </div>

                {/* Context bar */}
                {supStats && (
                  <div className="flex flex-col items-end gap-0.5 ml-2">
                    <span className="text-[11px] font-sans text-gray-400">
                      {Math.round(supStats.contextPercentage)}% ctx
                    </span>
                    <div className="w-20 h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          supStats.contextPercentage > 80 ? 'bg-red-400' :
                          supStats.contextPercentage > 50 ? 'bg-yellow-400' : 'bg-accent-green'
                        }`}
                        style={{ width: `${Math.min(supStats.contextPercentage, 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </button>
            ) : (
              <button
                onClick={async () => {
                  setSupervisorLoading(true);
                  await launchSupervisor(workspace.id);
                  setSupervisorLoading(false);
                }}
                disabled={supervisorLoading}
                className="hidden md:flex items-center gap-2 px-4 py-2.5 border border-purple-500/30 rounded-lg text-purple-300 hover:bg-purple-500/10 hover:border-purple-500 transition-all disabled:opacity-50 bg-surface-1/40"
                title="Launch Supervisor Agent"
              >
                <span className="w-2.5 h-2.5 rounded-full bg-purple-400/40 border border-purple-400/60" />
                <span className="text-[13px] font-sans font-semibold">
                  {supervisorLoading ? 'Launching...' : 'Supervisor'}
                </span>
              </button>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => showFileViewer()}
                className={`px-4 py-2 text-[13px] font-sans font-medium border transition-all rounded ${
                  hasOpenTabs
                    ? 'text-accent-green border-accent-green/30 hover:bg-accent-green/10 hover:border-accent-green'
                    : 'text-gray-400 border-gray-600 hover:bg-surface-3 hover:text-gray-200'
                }`}
                title={hasOpenTabs ? `Files (${openTabs.length} tabs open)` : 'Browse files'}
              >
                Files{hasOpenTabs ? ` (${openTabs.length})` : ''}
              </button>
              <button
                onClick={() => window.api.workspaces.openInVSCode(workspace.id)}
                className="px-4 py-2 text-[13px] font-sans font-medium text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-all hover:border-accent-blue rounded"
              >
                Open VS Code
              </button>
              <button
                onClick={() => setShowLaunch(true)}
                className="px-4 py-2 text-[13px] font-sans font-medium bg-accent-blue text-white hover:bg-blue-600 transition-all rounded shadow-sm"
              >
                Launch Agent
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Agent Grid — swipe left to open file viewer */}
      <div
        className="flex-1 overflow-y-auto p-6 scrollbar-thin"
        {...swipeToFiles}
      >
        <AgentGrid />
      </div>

      {showLaunch && (
        <AgentLaunchDialog
          workspace={workspace}
          onClose={() => setShowLaunch(false)}
        />
      )}
    </div>
  );
}
