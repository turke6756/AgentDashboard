import React, { useState } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from '../agent/AgentGrid';
import AgentLaunchDialog from '../agent/AgentLaunchDialog';
import FileViewerPanel from '../fileviewer/FileViewerPanel';

export default function MainContent() {
  const { workspaces, selectedWorkspaceId, agents, fileViewerOpen } = useDashboardStore();
  const [showLaunch, setShowLaunch] = useState(false);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  // File viewer takes over the center panel
  if (fileViewerOpen) {
    return <FileViewerPanel />;
  }

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 bg-surface-0/20">
        <div className="text-center animate-pulse">
          <div className="text-4xl mb-4 text-accent-blue opacity-50">&#x1f916;</div>
          <div className="text-lg font-mono uppercase tracking-widest text-accent-blue/50">
            Awaiting Sector Selection...
          </div>
        </div>
      </div>
    );
  }

  const activeCount = agents.filter(
    (a) => !['done', 'crashed'].includes(a.status)
  ).length;

  const totalAgents = agents.length;
  const loadPercentage = totalAgents > 0 ? Math.round((activeCount / totalAgents) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
       {/* Background Grid Accent */}
       <div className="absolute top-0 right-0 w-64 h-64 bg-accent-blue/5 rounded-full blur-3xl pointer-events-none -translate-y-1/2 translate-x-1/2" />

      {/* HUD Header */}
      <div className="px-6 py-4 border-b border-accent-blue/20 bg-surface-1/40 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-accent-blue font-mono text-lg">[</span>
              <h2 className="text-xl font-bold font-mono uppercase tracking-wider text-white glow-text">
                {workspace.title}
              </h2>
              <span className="text-accent-blue font-mono text-lg">]</span>
            </div>

            <div className="flex items-center gap-4 mt-2">
              <span className="text-[10px] text-accent-blue/70 font-mono tracking-wider border border-accent-blue/30 px-1 rounded-sm">
                PATH: {workspace.path}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 font-bold tracking-wider uppercase border ${
                  workspace.pathType === 'wsl'
                    ? 'border-accent-orange/50 text-accent-orange'
                    : 'border-accent-blue/50 text-accent-blue'
                }`}
              >
                TYPE::{workspace.pathType === 'wsl' ? 'WSL' : 'WIN'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-6">
            {/* System Load Indicator */}
            <div className="hidden md:block">
               <div className="flex justify-between text-[9px] font-mono text-gray-500 mb-1">
                  <span>SYSTEM_LOAD</span>
                  <span className="text-accent-green">{loadPercentage}%</span>
               </div>
               <div className="w-32 h-1 bg-gray-800 relative overflow-hidden">
                  <div
                    className="h-full bg-accent-blue shadow-[0_0_5px_currentColor]"
                    style={{ width: `${loadPercentage}%` }}
                  />
               </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => window.api.workspaces.openInVSCode(workspace.id)}
                className="px-4 py-2 text-xs font-mono font-bold uppercase tracking-wider text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-all hover:glow-box hover:border-accent-blue"
              >
                Open_VSCode
              </button>
              <button
                onClick={() => setShowLaunch(true)}
                className="px-4 py-2 text-xs font-mono font-bold uppercase tracking-wider bg-accent-blue/10 border border-accent-blue text-accent-blue hover:bg-accent-blue hover:text-black transition-all hover:shadow-[0_0_15px_rgba(0,243,255,0.4)]"
              >
                Launch_Agent
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Agent Grid */}
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
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
